"""
Morning Outlook Worker — runs at 8:00am ET on weekdays.

Pulls:
  - Latest macro readings (VIX, yields, dollar) from macro_worker cache
  - SPY/QQQ/IWM pre-market direction from Polygon snapshots
  - Sector rotation signals from last 24h
  - Overnight news headlines from signals table
  - Watchlist tickers with signals in last 24h

Outputs:
  1. A 'market_outlook' signal (ticker=MARKET) with Groq's directional call
  2. Stores outlook in market_outlooks table for sandbox to read
  3. Sandbox uses the outlook to bias its entry decisions that morning
"""
import os
import logging
import asyncio
import json
import httpx
from datetime import datetime, timezone, timedelta, date
from db import supabase, insert_signal
from market_hours import now_et, is_weekday

log = logging.getLogger("morning_outlook_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

_last_outlook_date: date | None = None


# ─── Groq call ────────────────────────────────────────────────────────────────

async def _call_groq(prompt: str, max_tokens: int = 400) -> str | None:
    from groq_pool import call_llm
    return await call_llm(prompt, primary_env_vars=["GROQ_BACKUP_API_KEY"], max_tokens=max_tokens, temperature=0.2)


# ─── Data fetchers ────────────────────────────────────────────────────────────

async def fetch_market_snapshot(client: httpx.AsyncClient) -> dict:
    """SPY, QQQ, IWM pre-market prices and direction."""
    result = {}
    if not POLYGON_KEY:
        return result
    for ticker in ["SPY", "QQQ", "IWM"]:
        try:
            r = await client.get(
                f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}",
                params={"apiKey": POLYGON_KEY}, timeout=8,
            )
            if r.status_code == 200:
                d = r.json()
                if d.get("status") == "OK" and "ticker" in d:
                    t = d["ticker"]
                    day = t.get("day") or {}
                    prev = t.get("prevDay") or {}
                    price = (t.get("lastTrade") or {}).get("p") or day.get("c")
                    prev_close = prev.get("c")
                    if price and prev_close:
                        chg_pct = (float(price) - float(prev_close)) / float(prev_close) * 100
                        result[ticker] = {"price": round(float(price), 2), "change_pct": round(chg_pct, 2)}
        except Exception as e:
            log.debug(f"Snapshot failed for {ticker}: {e}")
    return result


async def get_overnight_signals() -> list[dict]:
    """High-severity signals from overnight (last 12 hours)."""
    since = (datetime.now(timezone.utc) - timedelta(hours=12)).isoformat()
    try:
        res = (
            supabase().table("signals")
            .select("ticker,signal_type,severity,title")
            .gte("created_at", since)
            .gte("severity", 6)
            .not_.eq("ticker", "MARKET")
            .order("severity", desc=True)
            .limit(15)
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.debug(f"Overnight signals failed: {e}")
        return []


async def get_recent_lessons() -> list[dict]:
    """Last 10 sandbox lessons — what Groq has been learning."""
    try:
        res = (
            supabase().table("prediction_lessons")
            .select("ticker,date,bias,actual_bias,in_range,lesson")
            .order("date", desc=True)
            .limit(10)
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.debug(f"Lessons fetch failed: {e}")
        return []


# ─── Core outlook generation ──────────────────────────────────────────────────

async def generate_outlook(client: httpx.AsyncClient) -> dict | None:
    """Generate and store the morning market outlook."""
    today = now_et().date()

    # Gather all inputs in parallel
    market_snap, overnight_signals, lessons = await asyncio.gather(
        fetch_market_snapshot(client),
        get_overnight_signals(),
        get_recent_lessons(),
    )

    # Get latest macro readings from macro_worker cache
    try:
        import macro_worker
        macro = macro_worker.get_latest_readings()
    except Exception:
        macro = {}

    # Build context blocks
    spy = market_snap.get("SPY")
    qqq = market_snap.get("QQQ")
    iwm = market_snap.get("IWM")

    futures_block = "Pre-market futures unavailable."
    if spy or qqq or iwm:
        lines = []
        for sym, data in [("SPY", spy), ("QQQ", qqq), ("IWM", iwm)]:
            if data:
                chg = data["change_pct"]
                lines.append(f"  {sym}: ${data['price']} ({'+' if chg >= 0 else ''}{chg:.2f}%)")
        futures_block = "\n".join(lines)

    macro_block = "Macro data unavailable."
    if any(v is not None for v in macro.values()):
        parts = []
        if macro.get("vix") is not None:
            vix = macro["vix"]
            regime = "fear" if vix > 25 else "complacency" if vix < 14 else "neutral"
            parts.append(f"VIX: {vix:.1f} ({regime})")
        if macro.get("ten_y") is not None:
            parts.append(f"10Y yield: {macro['ten_y']:.2f}%")
        if macro.get("two_y") is not None and macro.get("ten_y") is not None:
            spread = macro["ten_y"] - macro["two_y"]
            parts.append(f"2s10s spread: {spread:+.2f}% ({'inverted' if spread < 0 else 'normal'})")
        if macro.get("uup") is not None:
            parts.append(f"Dollar (UUP): ${macro['uup']:.2f}")
        macro_block = " | ".join(parts)

    signals_block = "No overnight signals."
    if overnight_signals:
        signals_block = "\n".join(
            f"  [{s['signal_type']} sev={s['severity']}] {s['ticker']}: {s['title']}"
            for s in overnight_signals[:10]
        )

    lessons_block = "No recent lessons."
    if lessons:
        lines = []
        for l in lessons[:6]:
            correct = l.get("in_range") and l.get("bias") == l.get("actual_bias")
            lines.append(f"  {l['ticker']} {l['date']}: [{('✓' if correct else '✗')}] {l.get('lesson', '')[:100]}")
        lessons_block = "\n".join(lines)

    prompt = f"""You are a pre-market trading analyst. It's {today.strftime('%A, %B %d, %Y')} at approximately 8:00am ET.

PRE-MARKET FUTURES:
{futures_block}

MACRO ENVIRONMENT:
{macro_block}

OVERNIGHT SIGNALS (last 12h):
{signals_block}

RECENT GROQ TRADING LESSONS:
{lessons_block}

Give a concise pre-market brief covering:

**MARKET DIRECTION**: Is today likely GREEN or RED based on futures and macro? Give a directional lean (bullish/bearish/neutral) with confidence level 1-10. Be honest — if unclear, say neutral.

**KEY DRIVERS**: What 2-3 factors are most likely to move markets today?

**WATCH LIST**: Which sectors or tickers from the overnight signals look most interesting for trades today?

**SANDBOX BIAS**: Should today's paper trades lean LONG or SHORT overall, or be selective? Factor in the lessons — what mistakes should be avoided today?

**RISK**: What's the main risk that could flip the day's direction?

Keep it tight — 150 words max. Write for an active trader making decisions in the next 90 minutes."""

    analysis = await _call_groq(prompt, max_tokens=400)
    if not analysis:
        log.warning("Morning outlook Groq call failed")
        return None

    # Parse directional lean from response
    text_lower = analysis.lower()
    if "bearish" in text_lower or "red" in text_lower.split("market direction")[-1][:100] if "market direction" in text_lower else "":
        direction = "bearish"
    elif "bullish" in text_lower or "green" in text_lower.split("market direction")[-1][:100] if "market direction" in text_lower else "":
        direction = "bullish"
    else:
        direction = "neutral"

    outlook_data = {
        "date": today.isoformat(),
        "direction": direction,
        "analysis": analysis,
        "spy_change": spy["change_pct"] if spy else None,
        "qqq_change": qqq["change_pct"] if qqq else None,
        "vix": macro.get("vix"),
        "ten_y": macro.get("ten_y"),
    }

    # Store in market_outlooks table
    try:
        supabase().table("market_outlooks").upsert(outlook_data, on_conflict="date").execute()
    except Exception as e:
        log.warning(f"market_outlooks upsert failed: {e}")

    # Insert as a signal so it appears in the dashboard
    sev = 7.0 if direction != "neutral" else 5.0
    direction_label = {"bullish": "🟢 BULLISH", "bearish": "🔴 BEARISH", "neutral": "⚪ NEUTRAL"}[direction]
    insert_signal(
        "MARKET",
        "convergence",
        sev,
        f"Morning Outlook {today.strftime('%b %d')} — {direction_label}",
        analysis,
        outlook_data,
    )

    log.info(f"Morning outlook generated: {direction} (SPY {spy['change_pct']:+.2f}% pre-mkt)" if spy else f"Morning outlook: {direction}")
    return outlook_data


def get_todays_outlook() -> dict | None:
    """Used by sandbox_worker to bias entry decisions."""
    try:
        today = date.today().isoformat()
        res = (
            supabase().table("market_outlooks")
            .select("direction,analysis,spy_change,vix")
            .eq("date", today)
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]
    except Exception:
        pass
    return None


# ─── Entry point ──────────────────────────────────────────────────────────────

async def run_once() -> dict:
    global _last_outlook_date
    if not is_weekday():
        return {"status": "skipped", "reason": "weekend"}

    et = now_et()
    today = et.date()

    # Only generate between 7:45am and 9:15am ET
    total_min = et.hour * 60 + et.minute
    if not (7 * 60 + 45 <= total_min <= 9 * 60 + 15):
        return {"status": "skipped", "reason": "outside outlook window"}

    # Only once per day
    if _last_outlook_date == today:
        return {"status": "skipped", "reason": "already ran today"}

    _last_outlook_date = today

    async with httpx.AsyncClient(timeout=15) as client:
        outlook = await generate_outlook(client)

    if not outlook:
        _last_outlook_date = None  # allow retry
        return {"status": "error", "reason": "groq failed"}

    return {"status": "ok", "direction": outlook["direction"], "date": today.isoformat()}


async def main_loop():
    log.info("Morning outlook worker started")
    while True:
        try:
            result = await run_once()
            if result["status"] == "ok":
                log.info(f"Morning outlook: {result}")
        except Exception as e:
            log.error(f"Morning outlook loop error: {e}")
        await asyncio.sleep(1800)  # check every 30 min, runs once per day in window
