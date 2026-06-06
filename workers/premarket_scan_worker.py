"""
Pre-Market Scan Worker — runs at 8:30am ET on weekdays.

After the morning outlook is stored (8:00am), this worker:
  1. Builds a ranked universe of tickers with overnight signal activity
  2. Fetches pre-market prices from Finnhub for each
  3. Asks Groq to pick its TOP 5 highest-conviction setups for the day
  4. Stores the game plan in sandbox_premarket_plans table
  5. Posts the plan as a signal so it shows on the dashboard

At 9:30am, sandbox_worker reads this plan and executes the top entries
instead of scanning from scratch — prepared, not reactive.
"""
import os
import logging
import asyncio
import json
import httpx
from datetime import datetime, timezone, timedelta, date
from db import supabase, insert_signal
from market_hours import now_et, is_weekday

log = logging.getLogger("premarket_scan_worker")

FINNHUB_KEY  = os.environ.get("FINNHUB_API_KEY", "")
POLYGON_KEY  = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

MAX_PLAN_PICKS = 5   # top 5 setups for the day

_last_scan_date: date | None = None


# ─── Groq call ────────────────────────────────────────────────────────────────

async def _call_groq(prompt: str, max_tokens: int = 800) -> str | None:
    from groq_pool import call_llm
    return await call_llm(
        prompt,
        primary_env_vars=["GROQ_BACKUP_API_KEY"],
        max_tokens=max_tokens,
        temperature=0.2,
    )


# ─── Data helpers ─────────────────────────────────────────────────────────────

async def get_premarket_price(client: httpx.AsyncClient, ticker: str) -> dict | None:
    """Finnhub quote — c=current/last, pc=prev close, d=change, dp=change%.
    Also computes gap_strength = gap_pct / estimated ATR (5-day range / 5)."""
    if not FINNHUB_KEY:
        return None
    try:
        r = await client.get(
            f"https://finnhub.io/api/v1/quote?symbol={ticker}&token={FINNHUB_KEY}",
            timeout=8,
        )
        if r.status_code == 200:
            d = r.json()
            price = d.get("c") or d.get("pc")
            if price and float(price) > 0:
                gap_pct = round(float(d.get("dp") or 0), 2)
                prev_close = round(float(d.get("pc") or price), 2)
                high_52w = d.get("h") or 0  # today's high as proxy
                low_52w  = d.get("l") or 0  # today's low as proxy
                atr_proxy = abs(float(high_52w) - float(low_52w)) if high_52w and low_52w else 0
                gap_strength = round(abs(gap_pct) / (atr_proxy / float(price) * 100), 2) if atr_proxy > 0 and float(price) > 0 else None
                # Gap strength > 2 = gap > 2x typical range = likely gap-and-crap or strong momentum
                gap_label = ""
                if gap_strength is not None:
                    if gap_strength > 3:
                        gap_label = "EXTREME gap (>3x ATR) — high fade risk"
                    elif gap_strength > 2:
                        gap_label = "large gap (2-3x ATR) — watch for fade"
                    elif gap_strength > 1:
                        gap_label = "moderate gap (1-2x ATR)"
                    else:
                        gap_label = "small gap (<1x ATR) — continuation likely"
                return {
                    "price": round(float(price), 2),
                    "prev_close": prev_close,
                    "change_pct": gap_pct,
                    "gap_strength": gap_strength,
                    "gap_label": gap_label,
                }
    except Exception as e:
        log.debug(f"Finnhub quote failed for {ticker}: {e}")
    return None


async def get_candidate_tickers() -> list[dict]:
    """
    Build a scored list of ticker candidates for today's game plan.
    Score = sum of (severity/10 * signal_weight) for signals in last 18h.
    Returns top 20 by score, each with their signals attached.
    """
    since = (datetime.now(timezone.utc) - timedelta(hours=18)).isoformat()
    SIGNAL_WEIGHTS = {
        "convergence": 10, "dark_pool": 8, "insider_buy": 9, "insider_sell": 9,
        "options_unusual": 8, "short_squeeze": 8, "congress_trade": 7,
        "volume_spike": 6, "analyst_change": 6, "news_breaking": 5,
        "technical": 4, "sentiment_spike": 4, "earnings_upcoming": 3,
        "price_move": 2, "macro": 2,
    }
    ETF_SKIP = {"SPY","QQQ","IWM","DIA","VTI","GLD","SLV","TLT","HYG",
                "XLF","XLE","XLK","XLV","XLI","XLP","XLU","XLB","XLY",
                "ARKK","SQQQ","TQQQ","UVXY","VXX","MARKET","REDDIT","GROQ_SELF"}

    try:
        res = (
            supabase().table("signals")
            .select("ticker,signal_type,severity,title,body")
            .gte("created_at", since)
            .gte("severity", 5)
            .order("severity", desc=True)
            .limit(200)
            .execute()
        )
        rows = res.data or []
    except Exception as e:
        log.error(f"Candidate fetch failed: {e}")
        return []

    scores: dict[str, float] = {}
    signals_by_ticker: dict[str, list[dict]] = {}

    for row in rows:
        t = row.get("ticker", "")
        if not t or t in ETF_SKIP or not t.isalpha() or len(t) > 5:
            continue
        sev = float(row.get("severity") or 5)
        weight = SIGNAL_WEIGHTS.get(row.get("signal_type", ""), 2)
        scores[t] = scores.get(t, 0) + (sev / 10) * weight
        if t not in signals_by_ticker:
            signals_by_ticker[t] = []
        signals_by_ticker[t].append({
            "type": row["signal_type"],
            "sev": sev,
            "title": row.get("title", "")[:80],
        })

    ranked = sorted(scores.keys(), key=lambda t: scores[t], reverse=True)[:20]
    return [
        {"ticker": t, "score": round(scores[t], 1), "signals": signals_by_ticker[t][:5]}
        for t in ranked
    ]


async def get_past_performance(tickers: list[str]) -> dict[str, dict]:
    """Win/loss record for each ticker from past sandbox trades."""
    if not tickers:
        return {}
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("ticker,pnl")
            .eq("status", "closed")
            .in_("ticker", tickers)
            .execute()
        )
        perf: dict[str, dict] = {}
        for row in (res.data or []):
            t = row["ticker"]
            if t not in perf:
                perf[t] = {"wins": 0, "losses": 0}
            if (row.get("pnl") or 0) > 0:
                perf[t]["wins"] += 1
            else:
                perf[t]["losses"] += 1
        return perf
    except Exception:
        return {}


async def get_open_tickers() -> set[str]:
    """Tickers already in open sandbox positions — skip these."""
    try:
        res = supabase().table("sandbox_trades").select("ticker").eq("status", "open").execute()
        return {r["ticker"] for r in (res.data or [])}
    except Exception:
        return set()


# ─── Core scan ────────────────────────────────────────────────────────────────

async def run_premarket_scan(client: httpx.AsyncClient) -> dict | None:
    today = now_et().date()
    today_str = today.isoformat()

    # Gather candidates + open positions in parallel
    candidates, open_tickers = await asyncio.gather(
        get_candidate_tickers(),
        get_open_tickers(),
    )

    # Filter out tickers already in open positions
    candidates = [c for c in candidates if c["ticker"] not in open_tickers]
    if not candidates:
        log.info("No candidates for pre-market scan")
        return None

    # Fetch pre-market prices sequentially to respect Finnhub rate limit
    prices: dict[str, dict] = {}
    for c in candidates:
        result = await get_premarket_price(client, c["ticker"])
        if result:
            prices[c["ticker"]] = result
        await asyncio.sleep(0.25)  # Finnhub free tier: 60 req/min

    # Get past performance
    tickers = [c["ticker"] for c in candidates]
    perf = await get_past_performance(tickers)

    # Get today's morning outlook
    try:
        import morning_outlook_worker
        outlook = morning_outlook_worker.get_todays_outlook()
    except Exception:
        outlook = None

    # Get yesterday's self-critique
    try:
        yesterday = (today - timedelta(days=1)).isoformat()
        critique_res = (
            supabase().table("prediction_lessons")
            .select("lesson")
            .eq("ticker", "GROQ_SELF")
            .eq("date", yesterday)
            .limit(1)
            .execute()
        )
        critique = critique_res.data[0].get("lesson", "")[:400] if critique_res.data else ""
    except Exception:
        critique = ""

    # Get overall win rate
    try:
        wr_res = supabase().table("sandbox_trades").select("pnl").eq("status", "closed").execute()
        wr_rows = wr_res.data or []
        wins_total = sum(1 for r in wr_rows if (r.get("pnl") or 0) > 0)
        win_rate = round(wins_total / len(wr_rows) * 100, 1) if wr_rows else 0.0
        total_trades = len(wr_rows)
    except Exception:
        win_rate, total_trades = 0.0, 0

    # Build the candidate block for Groq
    candidate_lines = []
    for c in candidates:
        t = c["ticker"]
        price_info = prices.get(t)
        p_str = f"${price_info['price']:.2f} ({price_info['change_pct']:+.1f}% pre-mkt)" if price_info else "price N/A"
        gap_str = f" {price_info['gap_label']}" if price_info and price_info.get("gap_label") else ""
        past = perf.get(t, {})
        past_str = f"{past.get('wins',0)}W/{past.get('losses',0)}L" if past else "no history"
        sig_str = " | ".join(f"{s['type']}(sev={s['sev']:.0f})" for s in c["signals"][:3])
        candidate_lines.append(f"  {t:6s} score={c['score']:.1f} | {p_str}{gap_str} | {past_str} | {sig_str}")

    candidates_block = "\n".join(candidate_lines)
    outlook_str = (
        f"{outlook.get('direction','?').upper()} — {outlook.get('analysis','')[:300]}"
        if outlook else "No morning outlook available."
    )
    critique_block = f"\nYESTERDAY'S SELF-CRITIQUE (follow these rules today):\n{critique}" if critique else ""

    prompt = f"""It is pre-market on {today.strftime('%A, %B %d, %Y')}. You are planning today's paper trades BEFORE the market opens.

MORNING OUTLOOK:
{outlook_str}

OVERALL WIN RATE: {win_rate:.1f}% ({total_trades} trades)
{critique_block}

CANDIDATE TICKERS (ranked by overnight signal activity):
{candidates_block}

Your job: Pick your TOP {MAX_PLAN_PICKS} highest-conviction setups for today. Be a sniper — only pick setups where the signals genuinely support a trade. Pass on the rest.

For each pick, provide:
- Why this ticker TODAY (specific catalyst, not generic)
- Direction (long/short) — must align with morning outlook unless you have a specific counter-thesis
- Key price levels to watch at open (entry zone, stop, target)
- Trade type (day/swing)
- Conviction score 1-10

Respond ONLY with valid JSON array:
[
  {{
    "ticker": "AAPL",
    "direction": "long",
    "trade_type": "day",
    "entry_zone": 185.00,
    "stop": 182.50,
    "target": 190.00,
    "conviction": 8,
    "thesis": "<2 specific sentences — catalyst + price action rationale>"
  }},
  ...
]

RULES:
- Return EXACTLY {MAX_PLAN_PICKS} picks or fewer if fewer quality setups exist
- Skip any ticker where the thesis is vague or signals are weak
- Direction must be consistent with the morning outlook unless you have a strong counter-thesis
- Stop must be at a real technical level, not arbitrary
- Target must be minimum 2:1 R:R vs stop distance
- Conviction below 6 = don't include it"""

    raw = await _call_groq(prompt, max_tokens=800)
    if not raw:
        log.warning("Pre-market scan Groq call failed")
        return None

    # Parse JSON
    try:
        text = raw.strip()
        if "```" in text:
            parts = text.split("```")
            text = parts[1] if len(parts) >= 2 else text
            if text.startswith("json"):
                text = text[4:]
        picks = json.loads(text.strip())
        if not isinstance(picks, list):
            raise ValueError("Expected JSON array")
    except Exception as e:
        log.warning(f"Pre-market scan parse failed: {e}\nRaw: {raw[:300]}")
        return None

    # Validate and clean picks
    valid_picks = []
    for p in picks[:MAX_PLAN_PICKS]:
        if not all(k in p for k in ("ticker", "direction", "entry_zone", "stop", "target", "conviction", "thesis")):
            continue
        if p.get("conviction", 0) < 6:
            continue
        valid_picks.append({
            "ticker": str(p["ticker"]).upper(),
            "direction": str(p["direction"]).lower(),
            "trade_type": str(p.get("trade_type", "day")).lower(),
            "entry_zone": round(float(p["entry_zone"]), 4),
            "stop": round(float(p["stop"]), 4),
            "target": round(float(p["target"]), 4),
            "conviction": int(p["conviction"]),
            "thesis": str(p["thesis"])[:400],
        })

    if not valid_picks:
        log.info("Pre-market scan: no high-conviction picks today")
        return {"picks": [], "date": today_str}

    # Store game plan in DB
    plan_record = {
        "date": today_str,
        "picks": valid_picks,
        "outlook_direction": outlook.get("direction") if outlook else "neutral",
        "candidate_count": len(candidates),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        supabase().table("sandbox_premarket_plans").upsert(plan_record, on_conflict="date").execute()
    except Exception as e:
        log.warning(f"Plan store failed: {e}")

    # Post as a dashboard signal
    picks_summary = ", ".join(
        f"{p['ticker']} {'↑' if p['direction']=='long' else '↓'}({p['conviction']}/10)"
        for p in valid_picks
    )
    body_lines = []
    for p in valid_picks:
        body_lines.append(
            f"[{p['conviction']}/10] {p['ticker']} {p['direction'].upper()} {p['trade_type']} | "
            f"entry ~${p['entry_zone']:.2f} stop ${p['stop']:.2f} target ${p['target']:.2f}\n"
            f"{p['thesis']}"
        )
    insert_signal(
        "SANDBOX",
        "convergence",
        7.0,
        f"Pre-Market Game Plan {today.strftime('%b %d')} — {len(valid_picks)} setups: {picks_summary}",
        "\n\n".join(body_lines),
        {"picks": valid_picks, "source": "premarket_scan"},
    )

    log.info(f"Pre-market game plan: {len(valid_picks)} picks — {picks_summary}")
    return plan_record


# ─── Entry point ──────────────────────────────────────────────────────────────

async def run_once() -> dict:
    global _last_scan_date
    if not is_weekday():
        return {"status": "skipped", "reason": "weekend"}

    et = now_et()
    today = et.date()
    total_min = et.hour * 60 + et.minute

    # Run between 8:15am and 9:15am ET (after morning outlook, before open)
    if not (8 * 60 + 15 <= total_min <= 9 * 60 + 15):
        return {"status": "skipped", "reason": "outside pre-market window (8:15–9:15am ET)"}

    # Only once per day
    if _last_scan_date == today:
        return {"status": "skipped", "reason": "already ran today"}

    # Wait for morning outlook to be ready
    try:
        import morning_outlook_worker
        outlook = morning_outlook_worker.get_todays_outlook()
        if not outlook:
            return {"status": "skipped", "reason": "morning outlook not ready yet"}
    except Exception:
        pass

    _last_scan_date = today

    async with httpx.AsyncClient(timeout=15) as client:
        plan = await run_premarket_scan(client)

    if not plan:
        _last_scan_date = None  # allow retry
        return {"status": "error", "reason": "scan failed"}

    return {
        "status": "ok",
        "picks": len(plan.get("picks", [])),
        "date": today.isoformat(),
    }
