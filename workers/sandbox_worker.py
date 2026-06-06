"""
Sandbox Worker — Groq's paper trading engine.

Goal: achieve 70%+ win rate on paper trades, learning from every mistake.

Schedule:
  9:30am ET  — scan all watchlist tickers, Groq decides entries
  Every 30m  — re-evaluate open swing trades, exit if thesis broken
  4:00pm ET  — close all day trades at last price, evaluate all open trades

Trade types:
  day   — opens and closes same day
  swing — held up to 20 trading days, Groq re-evaluates daily

Groq gets:
  - Current price + recent signals
  - Past lessons from prediction_lessons table
  - Its own open positions (to avoid doubling up)
  - Its own win rate (so it knows if it needs to be more selective)
"""
import os
import logging
import asyncio
import json
import httpx
from datetime import datetime, timezone, date, timedelta
from db import supabase, insert_signal
from market_hours import now_et, is_weekday, is_market_hours

log = logging.getLogger("sandbox_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

# Paper trading config
STARTING_BALANCE   = 50_000.00  # $50k paper account
MAX_POSITION_PCT   = 15.0       # never put more than 15% of account in one trade
MAX_OPEN_POSITIONS = 10         # sniper mode — fewer, better positions
MAX_DAILY_ENTRIES  = 8          # max 8 trades/day — only the best setups
MAX_SWING_DAYS     = 20         # force-close swing trades after 20 trading days
MAX_STOP_PCT       = 6.0        # tighter stops — bad setups rejected faster
MAX_POSITIONS_PER_SECTOR = 2    # max 2 per sector — avoid concentration
COOLDOWN_DAYS      = 5          # ban ticker N days after 2 consecutive losses
BREAKEVEN_TRIGGER  = 2.0        # move stop to breakeven after +2% gain
VIX_REGIME_LIMIT   = 28.0       # skip entries when VIX above this

# ── Sniper position sizing — scales with signal conviction ──────────────────
RISK_PCT_BASE        = 1.0   # 1 qualifying signal  → 1% risk  ($500)
RISK_PCT_MULTI       = 1.5   # 2+ signals           → 1.5% risk ($750)
RISK_PCT_CONVERGENCE = 3.0   # convergence alert    → 3% risk  ($1,500) — full send
RISK_PCT_HOT_STREAK  = 0.5   # bonus when WR >= 70% over last 10 trades

# Confidence thresholds — high bar by default
BASE_CONFIDENCE_THRESHOLD = 65   # raised from 50 — sniper mode
HIGH_BAR_CONFIDENCE       = 75   # used when win rate < 50%
CONVERGENCE_MIN_CONFIDENCE = 55  # convergence overrides normal bar (signal does the work)

# Sector mapping for correlation limit (#6)
SECTOR_MAP: dict[str, str] = {
    "AAPL": "tech", "MSFT": "tech", "NVDA": "tech", "AMD": "tech", "META": "tech",
    "GOOGL": "tech", "GOOG": "tech", "AMZN": "tech", "TSLA": "tech", "PLTR": "tech",
    "CRM": "tech", "ORCL": "tech", "ADBE": "tech", "INTC": "tech", "MDB": "tech",
    "DELL": "tech", "SNOW": "tech", "NET": "tech", "CRWD": "tech", "DDOG": "tech",
    "JPM": "finance", "BAC": "finance", "GS": "finance", "MS": "finance", "WFC": "finance",
    "C": "finance", "BLK": "finance", "SCHW": "finance", "AXP": "finance",
    "JNJ": "health", "UNH": "health", "PFE": "health", "ABBV": "health", "MRK": "health",
    "LLY": "health", "DHR": "health", "TMO": "health", "AMGN": "health",
    "XOM": "energy", "CVX": "energy", "COP": "energy", "SLB": "energy", "EOG": "energy",
    "SPY": "index", "QQQ": "index", "IWM": "index", "DIA": "index",
    "LMT": "defense", "RTX": "defense", "NOC": "defense", "GD": "defense", "HII": "defense",
    "ACN": "consulting", "IBM": "tech",
}


# ─── Groq call ────────────────────────────────────────────────────────────────

async def _call_groq(prompt: str, max_tokens: int = 500) -> str | None:
    from groq_pool import call_llm
    return await call_llm(
        prompt,
        primary_env_vars=["GROQ_BACKUP_API_KEY"],
        max_tokens=max_tokens,
        temperature=0.2,
    )


# ─── Data helpers ─────────────────────────────────────────────────────────────

def get_watchlist_tickers() -> list[str]:
    try:
        watch = supabase().table("watchlist").select("ticker").execute()
        port = supabase().table("portfolio").select("ticker").execute()
        tickers = set()
        for r in (watch.data or []):
            tickers.add(r["ticker"].upper())
        for r in (port.data or []):
            tickers.add(r["ticker"].upper())
        return sorted(tickers)
    except Exception as e:
        log.error(f"get_watchlist_tickers failed: {e}")
        return []


async def get_scan_universe(client: httpx.AsyncClient) -> list[str]:
    """
    Build a broad universe of tickers for sandbox scanning:
    1. Polygon top gainers + losers (price momentum)
    2. StockTwits trending (retail sentiment)
    3. Tickers with recent signals in DB (already flagged by other workers)
    4. Watchlist + portfolio (always included)

    Returns deduplicated list, ETFs and crypto filtered out.
    """
    tickers: set[str] = set()

    # 1. Watchlist + portfolio — always included
    tickers.update(get_watchlist_tickers())

    # 2. Polygon top gainers + losers
    if POLYGON_KEY:
        for direction in ["gainers", "losers"]:
            try:
                r = await client.get(
                    f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/{direction}",
                    params={"apiKey": POLYGON_KEY, "include_otc": False},
                    timeout=10,
                )
                if r.status_code == 200:
                    for item in (r.json().get("tickers") or [])[:15]:
                        t = item.get("ticker", "")
                        if t and 1 < len(t) <= 5 and t.isalpha():
                            tickers.add(t.upper())
            except Exception as e:
                log.debug(f"Polygon {direction} fetch failed: {e}")

    # 3. StockTwits trending
    try:
        r = await client.get(
            "https://api.stocktwits.com/api/2/trending/symbols.json",
            timeout=10,
        )
        if r.status_code == 200:
            for s in (r.json().get("symbols") or [])[:20]:
                t = s.get("symbol", "")
                # Filter crypto (.X suffix) and ETFs
                if t and "." not in t and 1 < len(t) <= 5 and t.isalpha():
                    tickers.add(t.upper())
    except Exception as e:
        log.debug(f"StockTwits trending fetch failed: {e}")

    # 4. Tickers with signals in last 24h (already flagged by other workers)
    try:
        from datetime import datetime, timezone, timedelta
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("ticker")
            .gte("created_at", since)
            .gte("severity", 6)
            .execute()
        )
        for r in (res.data or []):
            t = r.get("ticker", "")
            if t and 1 < len(t) <= 5 and t.isalpha() and t not in ("REDDIT", "SYSTEM"):
                tickers.add(t.upper())
    except Exception as e:
        log.debug(f"Signals universe fetch failed: {e}")

    # Filter known ETFs and indices
    ETF_FILTER = {"SPY", "QQQ", "IWM", "DIA", "VTI", "GLD", "SLV", "TLT", "HYG",
                  "XLF", "XLE", "XLK", "XLV", "XLI", "XLP", "XLU", "XLB", "XLY",
                  "ARKK", "ARKG", "SQQQ", "TQQQ", "UVXY", "VXX"}
    tickers -= ETF_FILTER

    # Score each ticker by signal activity in last 24h — more signals = higher score
    # This lets us pass only the top 20 to Groq instead of all 50-100
    scores: dict[str, float] = {}
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("ticker,severity,signal_type")
            .gte("created_at", since)
            .gte("severity", 5)
            .execute()
        )
        signal_weights = {
            "convergence": 10, "dark_pool": 8, "insider_buy": 8, "insider_sell": 8,
            "options_unusual": 8, "short_squeeze": 7, "congress_trade": 7,
            "volume_spike": 6, "analyst_change": 6, "news_breaking": 5,
            "technical": 4, "sentiment_spike": 4, "earnings_upcoming": 4,
            "price_move": 3, "macro": 2,
        }
        for row in (res.data or []):
            t = row.get("ticker", "")
            if t not in tickers:
                continue
            sev = float(row.get("severity") or 5)
            weight = signal_weights.get(row.get("signal_type", ""), 3)
            scores[t] = scores.get(t, 0) + (sev / 10) * weight
    except Exception as e:
        log.debug(f"Scoring failed: {e}")

    # Watchlist/portfolio tickers always get a score boost so they're never dropped
    for t in get_watchlist_tickers():
        scores[t] = scores.get(t, 0) + 5

    # Sort by score descending, take top 20
    ranked = sorted(tickers, key=lambda t: scores.get(t, 0), reverse=True)[:MAX_DAILY_ENTRIES]
    log.info(f"Sandbox scan universe: {len(tickers)} tickers → top {len(ranked)} by signal score")
    return ranked


async def get_current_price(client: httpx.AsyncClient, ticker: str) -> float | None:
    """Try snapshot first (paid), fall back to daily aggs (free)."""
    if not POLYGON_KEY:
        return None
    try:
        r = await client.get(
            f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}",
            params={"apiKey": POLYGON_KEY}, timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            if d.get("status") == "OK" and "ticker" in d:
                t = d["ticker"]
                p = (t.get("lastTrade") or {}).get("p") or (t.get("day") or {}).get("c")
                if p:
                    return float(p)
    except Exception:
        pass
    # Free-tier fallback: daily agg
    try:
        today = date.today().isoformat()
        start = (date.today() - timedelta(days=5)).isoformat()
        r = await client.get(
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start}/{today}",
            params={"apiKey": POLYGON_KEY, "limit": 3, "sort": "desc"}, timeout=10,
        )
        if r.status_code == 200:
            results = r.json().get("results", [])
            if results:
                return float(results[0].get("c") or 0) or None
    except Exception as e:
        log.debug(f"Price fetch failed for {ticker}: {e}")
    return None


async def get_recent_signals(ticker: str, hours: int = 24) -> list[dict]:
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        res = (
            supabase().table("signals")
            .select("signal_type,severity,title,body")
            .eq("ticker", ticker.upper())
            .gte("created_at", since)
            .order("severity", desc=True)
            .limit(10)
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.debug(f"Signals fetch failed for {ticker}: {e}")
        return []


async def get_recent_lessons(ticker: str, limit: int = 5) -> list[dict]:
    """Prediction lessons for this ticker — Groq reads these to avoid repeat mistakes."""
    try:
        res = (
            supabase().table("prediction_lessons")
            .select("date,bias,actual_bias,in_range,lesson,confidence_pct")
            .eq("ticker", ticker.upper())
            .order("date", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.debug(f"Lessons fetch failed for {ticker}: {e}")
        return []


async def get_sandbox_lessons(ticker: str, limit: int = 5) -> list[dict]:
    """Past sandbox trade outcomes for this ticker."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("entry_date,direction,entry_price,exit_price,pnl_pct,exit_reason,groq_thesis,groq_exit_note")
            .eq("ticker", ticker.upper())
            .eq("status", "closed")
            .order("entry_date", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.debug(f"Sandbox lessons fetch failed for {ticker}: {e}")
        return []


def get_open_positions() -> list[dict]:
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("*")
            .eq("status", "open")
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.error(f"get_open_positions failed: {e}")
        return []


def get_overall_win_rate() -> tuple[int, int, float]:
    """Returns (wins, total, win_rate_pct)."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .execute()
        )
        rows = res.data or []
        if not rows:
            return 0, 0, 0.0
        wins = sum(1 for r in rows if (r.get("pnl") or 0) > 0)
        return wins, len(rows), round(wins / len(rows) * 100, 1)
    except Exception as e:
        log.debug(f"Win rate fetch failed: {e}")
        return 0, 0, 0.0


def get_account_balance() -> float:
    """Current sandbox account balance."""
    try:
        res = supabase().table("sandbox_account").select("balance").limit(1).execute()
        if res.data:
            return float(res.data[0]["balance"])
    except Exception as e:
        log.debug(f"Account balance fetch failed: {e}")
    return STARTING_BALANCE


def get_confidence_threshold(win_rate: float, total_trades: int) -> int:
    """
    Dynamic confidence threshold based on recent performance.
    - New account (< 10 trades): use base threshold, learning mode
    - Win rate < 40%: raise to 70, be very selective
    - Win rate 40-50%: raise to 60, be selective
    - Win rate > 50%: use base threshold 50, stay active
    - Win rate > 65%: lower to 45, press the advantage
    """
    if total_trades < 10:
        return BASE_CONFIDENCE_THRESHOLD
    if win_rate < 40:
        return HIGH_BAR_CONFIDENCE      # 70 — something is wrong, be selective
    if win_rate < 50:
        return 60                        # underperforming, tighten up
    if win_rate >= 65:
        return 45                        # on a roll, press the edge
    return BASE_CONFIDENCE_THRESHOLD    # 50 — normal operation


def calculate_position_size(entry: float, stop: float, account_balance: float) -> tuple[int, float, float]:
    """
    Kelly-inspired position sizing based on 1% account risk.
    Returns (shares, position_size_dollars, risk_amount_dollars).
    """
    risk_per_share = abs(entry - stop)
    if risk_per_share <= 0:
        return 1, entry, entry

    # Dollar risk = 1% of account
    dollar_risk = account_balance * (RISK_PER_TRADE_PCT / 100)

    # Shares = dollar risk / risk per share
    shares = max(1, int(dollar_risk / risk_per_share))

    # Cap position at MAX_POSITION_PCT of account
    max_position_dollars = account_balance * (MAX_POSITION_PCT / 100)
    max_shares_by_size = max(1, int(max_position_dollars / entry))
    shares = min(shares, max_shares_by_size)

    position_size = round(shares * entry, 2)
    risk_amount = round(shares * risk_per_share, 2)
    return shares, position_size, risk_amount


def update_account_balance(pnl_dollar: float) -> float:
    """Apply closed trade P&L to account balance. Returns new balance."""
    try:
        res = supabase().table("sandbox_account").select("*").limit(1).execute()
        if not res.data:
            return STARTING_BALANCE
        acct = res.data[0]
        new_balance = round(float(acct["balance"]) + pnl_dollar, 2)
        peak = max(float(acct["peak_balance"]), new_balance)
        wins = int(acct.get("winning_trades", 0)) + (1 if pnl_dollar > 0 else 0)
        losses = int(acct.get("losing_trades", 0)) + (1 if pnl_dollar < 0 else 0)
        supabase().table("sandbox_account").update({
            "balance": new_balance,
            "peak_balance": peak,
            "total_trades": int(acct.get("total_trades", 0)) + 1,
            "winning_trades": wins,
            "losing_trades": losses,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", acct["id"]).execute()
        return new_balance
    except Exception as e:
        log.error(f"update_account_balance failed: {e}")
        return STARTING_BALANCE


# ─── Context helpers ──────────────────────────────────────────────────────────

async def get_options_flow_context(ticker: str) -> str:
    """#1 — Latest options flow signals for this ticker."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("signal_type,severity,title,body")
            .eq("ticker", ticker.upper())
            .in_("signal_type", ["options_unusual", "dark_pool"])
            .gte("created_at", since)
            .order("severity", desc=True)
            .limit(3)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return "No recent options/dark pool flow."
        lines = [f"[{r['signal_type']} sev={r['severity']}] {r['title']}" for r in rows]
        return "\n".join(lines)
    except Exception:
        return "Options flow unavailable."


async def get_technical_context(ticker: str) -> str:
    """#2 — Latest technical indicator signals for this ticker."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        res = (
            supabase().table("signals")
            .select("title,body,severity,created_at")
            .eq("ticker", ticker.upper())
            .eq("signal_type", "technical")
            .gte("created_at", since)
            .order("created_at", desc=True)
            .limit(3)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return "No recent technical signals."
        lines = [f"[sev={r['severity']}] {r['title']}" for r in rows]
        return "\n".join(lines)
    except Exception:
        return "Technical data unavailable."


async def get_convergence_context(ticker: str) -> str:
    """#3 — Check if signal_engine fired a convergence signal recently."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        res = (
            supabase().table("signals")
            .select("severity,title,body")
            .eq("ticker", ticker.upper())
            .eq("signal_type", "convergence")
            .gte("created_at", since)
            .order("severity", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            r = res.data[0]
            return f"CONVERGENCE ALERT (sev={r['severity']}): {r['title']}\n{(r.get('body') or '')[:200]}"
        return "No convergence signal in last 2h."
    except Exception:
        return ""


async def get_volume_context(client: httpx.AsyncClient, ticker: str) -> str:
    """#4 — Today's volume vs 20-day average."""
    if not POLYGON_KEY:
        return ""
    try:
        today = date.today()
        start = (today - timedelta(days=25)).isoformat()
        r = await client.get(
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start}/{today.isoformat()}",
            params={"apiKey": POLYGON_KEY, "limit": 22, "sort": "desc"},
            timeout=8,
        )
        if r.status_code != 200:
            return ""
        results = r.json().get("results", [])
        if len(results) < 2:
            return ""
        today_vol = results[0].get("v", 0)
        avg_vol = sum(r2.get("v", 0) for r2 in results[1:21]) / min(20, len(results) - 1)
        if avg_vol <= 0:
            return ""
        ratio = today_vol / avg_vol
        label = "HIGH volume" if ratio > 1.5 else "LOW volume" if ratio < 0.7 else "normal volume"
        return f"Volume: {label} ({ratio:.1f}x 20-day avg)"
    except Exception:
        return ""


def score_setup_conviction(signals: list[dict], convergence_ctx: str, recent_wr: float) -> tuple[float, str, bool]:
    """
    Score how convicted Groq should be in this setup.
    Returns (risk_pct, conviction_label, is_convergence).

    Sniper philosophy:
    - Convergence alert = full send at 3% risk
    - 2+ high-quality signals = 1.5% risk
    - 1 signal = 1% risk
    - Hot streak bonus = +0.5%
    """
    is_convergence = "CONVERGENCE ALERT" in convergence_ctx

    # Count high-quality signals (sev >= 7)
    high_quality = [s for s in signals if float(s.get("severity") or 0) >= 7]
    # Extra weight for dark pool + options (smart money signals)
    smart_money = [s for s in signals if s.get("signal_type") in ("dark_pool", "options_unusual", "congress_trade", "insider_buy", "insider_sell")]

    if is_convergence:
        risk_pct = RISK_PCT_CONVERGENCE
        label = "CONVERGENCE — full send 3%"
    elif len(smart_money) >= 1 and len(high_quality) >= 2:
        risk_pct = RISK_PCT_MULTI + 0.5  # smart money + multiple signals = 2%
        label = f"SMART MONEY + {len(high_quality)} signals — 2% risk"
    elif len(high_quality) >= 2:
        risk_pct = RISK_PCT_MULTI
        label = f"{len(high_quality)} signals — 1.5% risk"
    elif len(smart_money) >= 1:
        risk_pct = RISK_PCT_MULTI
        label = f"smart money signal — 1.5% risk"
    else:
        risk_pct = RISK_PCT_BASE
        label = "standard setup — 1% risk"

    # Hot streak bonus
    if recent_wr >= 70:
        risk_pct = min(risk_pct + RISK_PCT_HOT_STREAK, RISK_PCT_CONVERGENCE)
        label += " +streak bonus"

    return round(risk_pct, 2), label, is_convergence


def get_signal_freshness(ticker: str) -> tuple[bool, int]:
    """#5/#12 — Returns (has_fresh_signal, hours_since_last_signal).
    Fresh = qualifying signal within 4 hours."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat()
        res = (
            supabase().table("signals")
            .select("created_at")
            .eq("ticker", ticker.upper())
            .gte("severity", 6)
            .gte("created_at", since)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            t = datetime.fromisoformat(res.data[0]["created_at"].replace("Z", "+00:00"))
            hours_ago = int((datetime.now(timezone.utc) - t).total_seconds() / 3600)
            return True, hours_ago
        return False, 99
    except Exception:
        return True, 0  # fail open


def get_daily_pnl() -> float:
    """#9 — Total P&L from trades closed today."""
    try:
        today_str = date.today().isoformat()
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .eq("exit_date", today_str)
            .execute()
        )
        return sum((r.get("pnl") or 0) for r in (res.data or []))
    except Exception:
        return 0.0


def get_recent_win_rate(n: int = 10) -> float:
    """#10 — Win rate over last N closed trades."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(n)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return 0.0
        wins = sum(1 for r in rows if (r.get("pnl") or 0) > 0)
        return wins / len(rows) * 100
    except Exception:
        return 0.0


def get_confidence_accuracy() -> str:
    """#8 — Compare high vs low confidence call accuracy."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl,confidence_used")
            .eq("status", "closed")
            .not_.is_("confidence_used", "null")
            .execute()
        )
        rows = res.data or []
        if len(rows) < 10:
            return ""
        high = [r for r in rows if (r.get("confidence_used") or 0) >= 70]
        low = [r for r in rows if (r.get("confidence_used") or 0) < 70]
        high_wr = sum(1 for r in high if (r.get("pnl") or 0) > 0) / len(high) * 100 if high else 0
        low_wr = sum(1 for r in low if (r.get("pnl") or 0) > 0) / len(low) * 100 if low else 0
        return f"High-confidence (70%+) win rate: {high_wr:.0f}% ({len(high)} trades) | Low-confidence win rate: {low_wr:.0f}% ({len(low)} trades)"
    except Exception:
        return ""


def send_push_notification(title: str, body: str, severity: float = 7.0) -> None:
    """#14/#15 — Fire push notification via existing push infrastructure."""
    try:
        import threading
        from db import _send_push_request
        signal_row = {
            "id": None, "ticker": "SANDBOX", "signal_type": "convergence",
            "severity": severity, "title": title, "body": body,
        }
        threading.Thread(target=_send_push_request, args=(signal_row,), daemon=True).start()
    except Exception as e:
        log.debug(f"Push notification failed: {e}")


# ─── Trade filters ────────────────────────────────────────────────────────────

def is_choppy_market() -> bool:
    """#1 — True if VIX is elevated and market regime is not tradeable."""
    try:
        import macro_worker
        macro = macro_worker.get_latest_readings()
        vix = macro.get("vix")
        if vix is not None and float(vix) > VIX_REGIME_LIMIT:
            log.info(f"Regime filter: VIX={vix:.1f} > {VIX_REGIME_LIMIT} — skipping entries")
            return True
    except Exception:
        pass
    return False


def get_account_streak() -> tuple[int, int, float]:
    """#2 — Returns (current_streak, streak_type 1=win/-1=loss, drawdown_pct)."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(10)
            .execute()
        )
        trades = res.data or []
        if not trades:
            return 0, 0, 0.0

        streak = 0
        last_type = 1 if (trades[0].get("pnl") or 0) > 0 else -1
        for t in trades:
            cur = 1 if (t.get("pnl") or 0) > 0 else -1
            if cur == last_type:
                streak += 1
            else:
                break

        # Drawdown
        acct = supabase().table("sandbox_account").select("balance,peak_balance").limit(1).execute()
        drawdown = 0.0
        if acct.data:
            bal = float(acct.data[0]["balance"])
            peak = float(acct.data[0]["peak_balance"])
            drawdown = ((peak - bal) / peak * 100) if peak > 0 else 0.0

        return streak, last_type, drawdown
    except Exception:
        return 0, 0, 0.0


def is_in_dead_zone() -> bool:
    """#3 — True if current ET time is in the 12pm-2pm dead zone."""
    et = now_et()
    total_min = et.hour * 60 + et.minute
    return 720 <= total_min < 840  # 12:00pm–2:00pm ET


async def get_sector_for_ticker(client: httpx.AsyncClient, ticker: str) -> str:
    """#4 — Get sector for a ticker. Uses local map first, falls back to 'other'."""
    return SECTOR_MAP.get(ticker.upper(), "other")


def count_open_positions_by_sector(open_positions: list[dict]) -> dict[str, int]:
    """#6 — Count open positions per sector."""
    counts: dict[str, int] = {}
    for p in open_positions:
        sector = SECTOR_MAP.get(p["ticker"].upper(), "other")
        counts[sector] = counts.get(sector, 0) + 1
    return counts


def has_earnings_soon(ticker: str, days: int = 2) -> bool:
    """#7 — True if ticker has earnings within N days."""
    try:
        since = datetime.now(timezone.utc).isoformat()
        until = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
        res = (
            supabase().table("signals")
            .select("id")
            .eq("ticker", ticker.upper())
            .eq("signal_type", "earnings_upcoming")
            .gte("created_at", since)
            .lte("created_at", until)
            .limit(1)
            .execute()
        )
        return bool(res.data)
    except Exception:
        return False


def is_on_cooldown(ticker: str) -> bool:
    """#9 — True if ticker had 2+ consecutive losses recently and is in cooldown."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl,exit_date")
            .eq("ticker", ticker.upper())
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(3)
            .execute()
        )
        trades = res.data or []
        if len(trades) < 2:
            return False

        # Check last 2 trades — both losses?
        last_two = trades[:2]
        both_losses = all((t.get("pnl") or 0) < 0 for t in last_two)
        if not both_losses:
            return False

        # Is the most recent loss within COOLDOWN_DAYS?
        last_exit = last_two[0].get("exit_date")
        if not last_exit:
            return False
        last_date = date.fromisoformat(last_exit)
        days_since = (date.today() - last_date).days
        if days_since < COOLDOWN_DAYS:
            log.debug(f"Cooldown: {ticker} had 2 consecutive losses, {days_since}d ago — skipping")
            return True
        return False
    except Exception:
        return False


def has_minimum_signals(ticker: str) -> bool:
    """#5 — True if ticker has at least 1 signal with sev >= 6 in last 24h."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("id")
            .eq("ticker", ticker.upper())
            .gte("severity", 6)
            .gte("created_at", since)
            .limit(1)
            .execute()
        )
        return bool(res.data)
    except Exception:
        return True  # Fail open — don't block if DB is down


# ─── Entry decision ───────────────────────────────────────────────────────────

async def decide_entry(
    client: httpx.AsyncClient,
    ticker: str,
    open_tickers: set[str],
    open_positions: list[dict] | None = None,
) -> dict | None:
    """Ask Groq whether to enter a trade on this ticker. Returns trade dict or None."""
    if ticker in open_tickers:
        return None

    # ── Pre-flight filters (fast, no Groq calls) ──────────────────────────────

    # #5/#12 — Require fresh signal within 4 hours
    has_fresh, hours_since = get_signal_freshness(ticker)
    if not has_fresh:
        log.debug(f"Filter #5/#12: {ticker} last signal {hours_since}h ago — stale, skip")
        return None

    # #7 — Skip if earnings within 2 days
    if has_earnings_soon(ticker, days=2):
        log.debug(f"Filter #7: {ticker} has earnings soon — skip")
        return None

    # #9 — Skip if on cooldown after 2 consecutive losses
    if is_on_cooldown(ticker):
        log.debug(f"Filter #9: {ticker} on loss cooldown — skip")
        return None

    # #6 — Sector correlation limit
    if open_positions:
        sector_counts = count_open_positions_by_sector(open_positions)
        ticker_sector = SECTOR_MAP.get(ticker.upper(), "other")
        if ticker_sector != "other" and sector_counts.get(ticker_sector, 0) >= MAX_POSITIONS_PER_SECTOR:
            log.debug(f"Filter #6: {ticker} sector={ticker_sector} already at limit — skip")
            return None

    price = await get_current_price(client, ticker)
    if not price or price <= 0:
        return None

    # Fetch all context in parallel
    (
        signals, pred_lessons, sandbox_lessons,
        options_ctx, tech_ctx, convergence_ctx, volume_ctx,
    ) = await asyncio.gather(
        get_recent_signals(ticker, hours=24),
        get_recent_lessons(ticker, limit=5),
        get_sandbox_lessons(ticker, limit=5),
        get_options_flow_context(ticker),
        get_technical_context(ticker),
        get_convergence_context(ticker),
        get_volume_context(client, ticker),
        return_exceptions=False,
    )
    wins, total, win_rate = get_overall_win_rate()
    recent_wr = get_recent_win_rate(10)
    conf_accuracy = get_confidence_accuracy()

    # Fetch user-injected brain notes — general + ticker-specific
    try:
        notes_res = supabase().table("brain_notes").select("content,ticker,category").execute()
        notes = notes_res.data or []
        general_notes = [n["content"] for n in notes if not n.get("ticker")]
        ticker_notes = [n["content"] for n in notes if n.get("ticker") == ticker.upper()]
        brain_block = ""
        if general_notes or ticker_notes:
            lines = []
            if ticker_notes:
                lines.append(f"NOTES ABOUT {ticker}:")
                lines.extend(f"  - {n}" for n in ticker_notes)
            if general_notes:
                lines.append("GENERAL TRADING RULES (from user):")
                lines.extend(f"  - {n}" for n in general_notes[:10])
            brain_block = "\n".join(lines)
    except Exception:
        brain_block = ""

    # Fetch weekly review rules (written Sunday, read all week)
    try:
        week_start = (date.today() - timedelta(days=7)).isoformat()
        weekly_res = (
            supabase().table("prediction_lessons")
            .select("lesson")
            .eq("ticker", "GROQ_WEEKLY")
            .gte("date", week_start)
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        weekly_rules = weekly_res.data[0].get("lesson", "") if weekly_res.data else ""
        if "RULES FOR NEXT WEEK" in weekly_rules:
            weekly_rules = weekly_rules.split("RULES FOR NEXT WEEK")[-1][:400]
        else:
            weekly_rules = weekly_rules[:300]

        # Pattern mining rules
        patterns_res = (
            supabase().table("prediction_lessons")
            .select("lesson")
            .eq("ticker", "GROQ_PATTERNS")
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        pattern_rules = patterns_res.data[0].get("lesson", "") if patterns_res.data else ""
        if "3 CONCRETE RULES" in pattern_rules:
            pattern_rules = pattern_rules.split("3 CONCRETE RULES")[-1][:400]
        else:
            pattern_rules = pattern_rules[:300]
    except Exception:
        weekly_rules = ""
        pattern_rules = ""

    # Fetch yesterday's self-critique — Groq reads its own rules before trading
    try:
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        critique_res = (
            supabase().table("prediction_lessons")
            .select("lesson,key_factors")
            .eq("ticker", "GROQ_SELF")
            .eq("date", yesterday)
            .limit(1)
            .execute()
        )
        self_critique = critique_res.data[0].get("lesson", "") if critique_res.data else ""
        # Extract just the "tomorrow's adjustments" section if present
        if "TOMORROW'S ADJUSTMENTS" in self_critique:
            self_critique = self_critique.split("TOMORROW'S ADJUSTMENTS")[-1][:400]
        else:
            self_critique = self_critique[:300]
    except Exception:
        self_critique = ""

    # #2 — Equity curve + streak context
    streak_count, streak_type, drawdown = get_account_streak()
    account_balance = get_account_balance()
    total_return_pct = (account_balance - STARTING_BALANCE) / STARTING_BALANCE * 100
    streak_str = ""
    if streak_count >= 2:
        streak_word = "winning" if streak_type == 1 else "losing"
        streak_str = f"Current {streak_word} streak: {streak_count} trades"
        if streak_type == -1 and streak_count >= 3:
            streak_str += " — BE VERY SELECTIVE, cut position size mentally"
        elif streak_type == 1 and streak_count >= 3:
            streak_str += " — momentum is with you, stay disciplined"

    # #4 — Sector alignment
    ticker_sector = SECTOR_MAP.get(ticker.upper(), "unknown")
    sector_signals: list[str] = []
    try:
        since_24h = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        sec_res = (
            supabase().table("signals")
            .select("signal_type,title")
            .eq("signal_type", "macro")
            .gte("created_at", since_24h)
            .limit(3)
            .execute()
        )
        sector_signals = [(s.get("title") or "")[:80] for s in (sec_res.data or [])]
    except Exception:
        pass

    # Get today's morning outlook to bias direction
    try:
        import morning_outlook_worker
        outlook = morning_outlook_worker.get_todays_outlook()
    except Exception:
        outlook = None

    # Build signal summary
    sig_lines = [f"- [{s['signal_type']} sev={s['severity']}] {s['title']}" for s in signals]
    sig_block = "\n".join(sig_lines) if sig_lines else "No recent signals."

    # Build lessons block
    lessons_lines = []
    for l in pred_lessons:
        status = "correct" if (l.get("in_range") and l.get("bias") == l.get("actual_bias")) else "wrong"
        lessons_lines.append(f"- {l['date']}: predicted {l.get('bias')}, actual {l.get('actual_bias')} [{status}]")
        if l.get("lesson") and "Correct" not in (l.get("lesson") or ""):
            lessons_lines.append(f"  Lesson: {l['lesson'][:150]}")
    pred_block = "\n".join(lessons_lines) if lessons_lines else "No prediction history."

    sandbox_lines = []
    for t in sandbox_lessons:
        outcome = "WIN" if (t.get("pnl_pct") or 0) > 0 else "LOSS"
        exit_str = f"${float(t['exit_price']):.2f}" if t.get("exit_price") else "open"
        sandbox_lines.append(
            f"- {t['entry_date']} {t.get('direction')} @ ${float(t.get('entry_price') or 0):.2f} → "
            f"{exit_str} [{outcome} {t.get('pnl_pct') or 0:+.1f}%] reason: {t.get('exit_reason')}"
        )
        if t.get("groq_exit_note"):
            sandbox_lines.append(f"  Note: {t['groq_exit_note'][:100]}")
    sandbox_block = "\n".join(sandbox_lines) if sandbox_lines else "No sandbox history for this ticker."

    # Morning outlook block
    if outlook:
        direction_str = outlook.get("direction", "neutral").upper()
        spy_str = f" (SPY {outlook['spy_change']:+.2f}%)" if outlook.get("spy_change") is not None else ""
        vix_str = f", VIX {outlook['vix']:.1f}" if outlook.get("vix") is not None else ""
        outlook_block = f"Today's market outlook: {direction_str}{spy_str}{vix_str}\n{outlook.get('analysis', '')[:300]}"
    else:
        outlook_block = "No morning outlook available."

    today_str = date.today().isoformat()

    # Score conviction — determines position size and confidence bar
    risk_pct, conviction_label, is_convergence = score_setup_conviction(signals, convergence_ctx, recent_wr)

    critique_block = f"\nYOUR RULES FROM YESTERDAY'S SELF-CRITIQUE (FOLLOW THESE):\n{self_critique}" if self_critique else ""
    weekly_block = f"\nWEEKLY REVIEW RULES:\n{weekly_rules}" if weekly_rules else ""
    pattern_block_str = f"\nHIGHEST WIN-RATE PATTERNS (follow these):\n{pattern_rules}" if pattern_rules else ""
    user_brain_block = f"\nUSER-PROVIDED RULES AND OBSERVATIONS (MUST FOLLOW):\n{brain_block}" if brain_block else ""
    sector_block = f"\nTicker sector: {ticker_sector}" + (f"\nRecent macro signals: {'; '.join(sector_signals)}" if sector_signals else "")
    account_block = (
        f"\nAccount: ${account_balance:,.0f} ({total_return_pct:+.1f}% total return) | Drawdown: {drawdown:.1f}%"
        + (f" | {streak_str}" if streak_str else "")
        + f" | Last 10 trades WR: {recent_wr:.0f}%"
        + (f"\n{conf_accuracy}" if conf_accuracy else "")
    )
    convergence_note = f"\n⚡ {convergence_ctx}" if "CONVERGENCE ALERT" in convergence_ctx else ""

    # Regime-specific playbook instruction
    if is_convergence:
        playbook = "CONVERGENCE DETECTED — this is a full-send setup. Be aggressive. Set a wider target (3:1 R:R minimum). This is your highest conviction trade type."
    elif risk_pct >= 2.0:
        playbook = "Strong signal cluster detected. Be bold — set target at 2.5:1 R:R minimum. This setup has real edge."
    else:
        playbook = "Standard setup. Be selective — only take if you genuinely see an edge. Pass if uncertain."

    prompt = f"""You are a sophisticated sniper trader managing a $50,000 paper account. Your goal: high win rate AND maximum profit.

PHILOSOPHY: Pass on 80% of setups. When everything lines up — convergence + options flow + sector alignment — go in hard and set aggressive targets. Don't be afraid to be bold when the data supports it.

CURRENT SETUP: {ticker} @ ${price:.2f} | {volume_ctx}
CONVICTION LEVEL: {conviction_label}
{playbook}
{sector_block}{account_block}
{user_brain_block}
{pattern_block_str}
{weekly_block}
{critique_block}
MARKET OUTLOOK:
{outlook_block}
{convergence_note}
SMART MONEY FLOW:
{options_ctx}

TECHNICAL:
{tech_ctx}

SIGNALS (last 24h — freshest {hours_since}h ago):
{sig_block}

PAST ACCURACY FOR {ticker}:
{pred_block}

PAST SANDBOX TRADES FOR {ticker}:
{sandbox_block}

WIN RATE: {win_rate:.1f}% overall | {recent_wr:.0f}% last 10 trades ({wins}/{total} total)

Respond ONLY with valid JSON:
{{
  "trade": true | false,
  "direction": "long" | "short",
  "trade_type": "day" | "swing",
  "stop_loss": <price float>,
  "target_price": <price float>,
  "confidence": <integer 1-100>,
  "thesis": "<2 sentence reason — specific prices, specific catalysts, not generic>"
}}

ENTRY RULES:
- PASS if confidence < {CONVERGENCE_MIN_CONFIDENCE if is_convergence else BASE_CONFIDENCE_THRESHOLD} — don't force trades
- CONVERGENCE setups: target must be 3:1 R:R minimum — go big or pass
- Standard setups: target 2:1 R:R minimum
- Stop must be at a real technical level (support/resistance), not arbitrary
- Direction MUST align with market outlook unless you have a very specific counter-thesis
- If you've been losing on this ticker recently, pass unless signals are overwhelming
- Be specific in your thesis — vague reasoning = bad trade"""

    raw = await _call_groq(prompt, max_tokens=300)
    if not raw:
        return None

    try:
        text = raw.strip()
        if "```" in text:
            parts = text.split("```")
            text = parts[1] if len(parts) >= 2 else text
            if text.startswith("json"):
                text = text[4:]
        parsed = json.loads(text.strip())
    except Exception as e:
        log.warning(f"Entry decision parse failed for {ticker}: {e}\nRaw: {raw[:200]}")
        return None

    # Confidence threshold — convergence plays get lower bar (signal does the work)
    if is_convergence:
        conf_threshold = CONVERGENCE_MIN_CONFIDENCE
    else:
        conf_threshold = get_confidence_threshold(win_rate, total)

    confidence = parsed.get("confidence", 0)
    if not parsed.get("trade") or confidence < conf_threshold:
        log.debug(f"Sandbox: passed on {ticker} (confidence={confidence} < {conf_threshold}, conviction={conviction_label})")
        return None

    direction = parsed.get("direction", "long")
    trade_type = parsed.get("trade_type", "day")
    stop = float(parsed.get("stop_loss") or 0)
    target = float(parsed.get("target_price") or 0)
    thesis = str(parsed.get("thesis", ""))[:500]

    # R:R minimum — convergence plays need 3:1, standard 2:1
    min_rr = 2.5 if is_convergence else 2.0

    if direction == "long":
        if stop >= price or target <= price:
            log.debug(f"Sandbox: invalid levels for {ticker} long")
            return None
        risk = price - stop
        reward = target - price
        if risk <= 0 or reward / risk < min_rr:
            log.debug(f"Sandbox: R:R {reward/risk:.2f} < {min_rr} for {ticker} long — skip")
            return None
        stop_pct = (risk / price) * 100
        if stop_pct > MAX_STOP_PCT:
            log.debug(f"Filter #8: {ticker} stop too wide ({stop_pct:.1f}%) — skip")
            return None
    else:
        if stop <= price or target >= price:
            log.debug(f"Sandbox: invalid levels for {ticker} short")
            return None
        risk = stop - price
        reward = price - target
        if risk <= 0 or reward / risk < min_rr:
            log.debug(f"Sandbox: R:R {reward/risk:.2f} < {min_rr} for {ticker} short — skip")
            return None
        stop_pct = (risk / price) * 100
        if stop_pct > MAX_STOP_PCT:
            log.debug(f"Filter #8: {ticker} short stop too wide ({stop_pct:.1f}%) — skip")
            return None

    # Position sizing — scale up on hot streaks (#10)
    account_balance = get_account_balance()
    effective_risk_pct = risk_pct  # may be 1.5% if on hot streak
    risk_per_share = abs(price - stop)
    if risk_per_share > 0:
        dollar_risk = account_balance * (effective_risk_pct / 100)
        shares = max(1, int(dollar_risk / risk_per_share))
        max_shares = max(1, int(account_balance * (MAX_POSITION_PCT / 100) / price))
        shares = min(shares, max_shares)
    else:
        shares = 1
    position_size = round(shares * price, 2)
    risk_amount = round(shares * risk_per_share, 2)

    # #13 — Limit entry: set entry slightly better than current price
    if direction == "long":
        limit_entry = round(price * 0.997, 4)  # 0.3% below current
    else:
        limit_entry = round(price * 1.003, 4)  # 0.3% above current for short

    # #11 — Calculate Target 1 (partial exit at halfway)
    if direction == "long":
        target1 = round(price + (target - price) * 0.5, 4)
    else:
        target1 = round(price - (price - target) * 0.5, 4)

    return {
        "ticker": ticker.upper(),
        "direction": direction,
        "trade_type": trade_type,
        "status": "open",
        "entry_price": round(limit_entry, 4),  # #13 limit entry
        "stop_loss": round(stop, 4),
        "target_price": round(target, 4),
        "shares": shares,
        "position_size": position_size,
        "risk_amount": risk_amount,
        "account_balance_at_entry": account_balance,
        "confidence_used": confidence,
        "entry_date": today_str,
        "groq_thesis": thesis,
        "signals_at_entry": [{"type": s["signal_type"], "sev": s["severity"], "title": s["title"]} for s in signals[:5]],
        "target1": target1,
        "partial_exit_done": False,
        "conviction_label": conviction_label,
        "is_convergence": is_convergence,
    }


# ─── Exit evaluation ──────────────────────────────────────────────────────────

async def evaluate_open_trade(client: httpx.AsyncClient, trade: dict) -> None:
    """Check if an open trade should be closed — stop hit, target hit, or Groq exits."""
    ticker = trade["ticker"]
    price = await get_current_price(client, ticker)
    if not price:
        return

    direction = trade["direction"]
    stop = float(trade["stop_loss"])
    target = float(trade["target_price"])
    entry = float(trade["entry_price"])
    entry_date = date.fromisoformat(trade["entry_date"])
    trade_type = trade["trade_type"]
    today = date.today()

    # Calculate current P&L
    if direction == "long":
        pnl_pct = (price - entry) / entry * 100
    else:
        pnl_pct = (entry - price) / entry * 100

    # #10 — Trailing stop: move stop to breakeven once trade hits +BREAKEVEN_TRIGGER%
    if pnl_pct >= BREAKEVEN_TRIGGER:
        breakeven_stop = entry  # lock in breakeven
        if direction == "long" and stop < breakeven_stop:
            try:
                supabase().table("sandbox_trades").update({
                    "stop_loss": round(breakeven_stop, 4),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", trade["id"]).execute()
                stop = breakeven_stop  # use updated stop for rest of eval
                log.info(f"Trailing stop: {ticker} {direction} stop moved to breakeven ${breakeven_stop:.2f} (pnl={pnl_pct:+.1f}%)")
            except Exception as e:
                log.debug(f"Trailing stop update failed for {ticker}: {e}")
        elif direction == "short" and stop > breakeven_stop:
            try:
                supabase().table("sandbox_trades").update({
                    "stop_loss": round(breakeven_stop, 4),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", trade["id"]).execute()
                stop = breakeven_stop
                log.info(f"Trailing stop: {ticker} short stop moved to breakeven ${breakeven_stop:.2f}")
            except Exception as e:
                log.debug(f"Trailing stop update failed for {ticker}: {e}")

    # #11 — Partial exit at Target 1 (halfway)
    target1 = float(trade.get("target1") or 0)
    partial_done = trade.get("partial_exit_done", False)
    if target1 > 0 and not partial_done:
        t1_hit = (direction == "long" and price >= target1) or (direction == "short" and price <= target1)
        if t1_hit:
            # Close half the position at Target 1
            half_shares = max(1, int(float(trade.get("shares") or 1) / 2))
            # Bug fix: correct P&L sign for both directions
            half_pnl = half_shares * ((price - entry) if direction == "long" else (entry - price))
            update_account_balance(half_pnl)
            log.info(f"Partial exit: {ticker} {direction} — closed {half_shares} shares at Target1 ${price:.2f} (${half_pnl:+.2f})")
            try:
                remaining_shares = max(1, int(float(trade.get("shares") or 1)) - half_shares)
                supabase().table("sandbox_trades").update({
                    "partial_exit_done": True,
                    "stop_loss": round(entry, 4),  # move stop to breakeven after partial
                    "shares": remaining_shares,
                    "position_size": round(remaining_shares * price, 2),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", trade["id"]).execute()
                stop = entry  # updated for rest of this eval cycle
            except Exception as e:
                log.debug(f"Partial exit update failed for {ticker}: {e}")

    # Auto-exit: stop hit (uses updated stop if trailing fired)
    if (direction == "long" and price <= stop) or (direction == "short" and price >= stop):
        exit_reason = "stop_hit" if abs(stop - entry) > 0.01 else "breakeven_stop"
        await close_trade(trade, price, exit_reason, f"Stop hit at ${price:.2f} (stop=${stop:.2f})")
        return

    # Auto-exit: target hit — send push notification (#14)
    if (direction == "long" and price >= target) or (direction == "short" and price <= target):
        await close_trade(trade, price, "target_hit", f"Target hit at ${price:.2f}")
        return

    # Auto-exit: day trade at close
    if trade_type == "day" and today > entry_date:
        await close_trade(trade, price, "day_close", f"Day trade closed at EOD ${price:.2f}")
        return

    # Force-exit: max hold period exceeded — count actual trading days (weekdays only)
    trading_days_held = sum(
        1 for i in range((today - entry_date).days)
        if (entry_date + timedelta(days=i + 1)).weekday() < 5
    )
    if trading_days_held >= MAX_SWING_DAYS:
        await close_trade(trade, price, "max_hold", f"Max hold period reached — exited at ${price:.2f}")
        return

    # Swing trade: ask Groq if thesis still valid
    if trade_type == "swing":
        signals = await get_recent_signals(ticker, hours=24)
        sig_lines = [f"- [{s['signal_type']} sev={s['severity']}] {s['title']}" for s in signals]
        sig_block = "\n".join(sig_lines) if sig_lines else "No recent signals."

        prompt = f"""You entered a {direction} trade on {ticker} {trading_days_held} days ago.

Entry: ${entry:.2f} | Current: ${price:.2f} | P&L: {pnl_pct:+.1f}%
Stop: ${stop:.2f} | Target: ${target:.2f}
Original thesis: {trade.get('groq_thesis', 'No thesis recorded')}

New signals since entry:
{sig_block}

Should you exit this trade now, or hold?

Respond ONLY with JSON:
{{"exit": true | false, "reason": "<one sentence>"}}

Exit if: thesis is broken, new bearish signals, or P&L at risk of turning from win to loss."""

        raw = await _call_groq(prompt, max_tokens=100)
        if raw:
            try:
                text = raw.strip()
                if "```" in text:
                    parts = text.split("```")
                    text = parts[1] if len(parts) >= 2 else text
                    if text.startswith("json"):
                        text = text[4:]
                parsed = json.loads(text.strip())
                if parsed.get("exit"):
                    reason = str(parsed.get("reason", "Groq exited"))[:300]
                    await close_trade(trade, price, "groq_exit", reason)
                    return
            except Exception as e:
                log.debug(f"Swing exit parse failed for {ticker}: {e}")


async def close_trade(trade: dict, exit_price: float, exit_reason: str, exit_note: str) -> None:
    """Mark a trade as closed, compute P&L, write exit note, then write a lesson."""
    entry = float(trade["entry_price"])
    direction = trade["direction"]
    shares = float(trade.get("shares") or 1)
    ticker = trade["ticker"]

    if direction == "long":
        pnl = (exit_price - entry) * shares
        pnl_pct = (exit_price - entry) / entry * 100
    else:
        pnl = (entry - exit_price) * shares
        pnl_pct = (entry - exit_price) / entry * 100

    try:
        supabase().table("sandbox_trades").update({
            "status": "closed",
            "exit_price": round(exit_price, 4),
            "exit_date": date.today().isoformat(),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 4),
            "exit_reason": exit_reason,
            "groq_exit_note": exit_note[:500] if exit_reason == "groq_exit" else None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", trade["id"]).execute()
        outcome = "WIN" if pnl > 0 else "LOSS"
        log.info(f"Sandbox closed {direction} {ticker}: {outcome} {pnl_pct:+.1f}% (${pnl:+.2f}) reason={exit_reason}")
    except Exception as e:
        log.error(f"close_trade failed for {ticker}: {e}")
        return

    # Update account balance with real P&L
    new_balance = update_account_balance(pnl)
    log.info(f"Account balance: ${new_balance:,.2f}")

    # #14 — Push notification on target hit or stop hit
    outcome = "WIN" if pnl > 0 else "LOSS"
    if exit_reason in ("target_hit", "stop_hit", "breakeven_stop"):
        emoji = "🎯" if exit_reason == "target_hit" else "🛑" if exit_reason == "stop_hit" else "⚡"
        push_title = f"{emoji} Sandbox {outcome}: {ticker} {direction.upper()}"
        push_body = f"${entry:.2f} → ${exit_price:.2f} ({pnl_pct:+.1f}%) | {exit_reason.replace('_', ' ')} | Balance: ${new_balance:,.0f}"
        send_push_notification(push_title, push_body, severity=8.0 if exit_reason == "target_hit" else 7.0)

    # Write lesson and equity snapshot asynchronously
    asyncio.create_task(_write_trade_lesson(trade, exit_price, exit_reason, pnl_pct))
    asyncio.create_task(_record_equity_snapshot())


async def _write_trade_lesson(trade: dict, exit_price: float, exit_reason: str, pnl_pct: float) -> None:
    """Ask Groq to write a one-sentence lesson from this closed trade and store it."""
    ticker = trade["ticker"]
    direction = trade["direction"]
    entry = float(trade["entry_price"])
    stop = float(trade["stop_loss"])
    target = float(trade["target_price"])
    is_win = pnl_pct > 0
    outcome = "WIN" if is_win else "LOSS"

    prompt = f"""A sandbox trade on {ticker} just closed.

Trade: {direction.upper()} @ ${entry:.2f} | Stop ${stop:.2f} | Target ${target:.2f}
Exit: ${exit_price:.2f} via {exit_reason} | Result: {outcome} {pnl_pct:+.1f}%
Original thesis: "{trade.get('groq_thesis', 'N/A')}"

Write ONE specific sentence that captures what this trade teaches about trading {ticker} — what setup to repeat or what mistake to avoid next time. Be concrete, not generic. Start with "Next time" or "Avoid" or "Look for"."""

    try:
        lesson = await _call_groq(prompt, max_tokens=80)
        if not lesson:
            return
        lesson = lesson.strip().replace('"', '').replace('\n', ' ')[:200]

        # Store in prediction_lessons so ALL Groq workers can read it
        supabase().table("prediction_lessons").upsert({
            "ticker": ticker.upper(),
            "date": date.today().isoformat(),
            "bias": direction,
            "actual_bias": direction if is_win else ("short" if direction == "long" else "long"),
            "in_range": is_win,
            "lesson": lesson,
            "confidence_pct": min(99, max(1, int(abs(pnl_pct) * 5))),
            "key_factors": {"exit_reason": exit_reason, "pnl_pct": round(pnl_pct, 2), "source": "sandbox"},
            "signals_used": trade.get("signals_at_entry"),
        }, on_conflict="ticker,date").execute()
        log.info(f"Sandbox lesson written for {ticker}: {lesson[:80]}")
    except Exception as e:
        log.debug(f"Lesson write failed for {ticker}: {e}")


async def _record_equity_snapshot() -> None:
    """Record today's account balance as an equity curve data point."""
    try:
        acct_res = supabase().table("sandbox_account").select("balance,peak_balance").limit(1).execute()
        if not acct_res.data:
            return
        acct = acct_res.data[0]
        balance = float(acct["balance"])
        peak = float(acct["peak_balance"])
        drawdown = ((peak - balance) / peak * 100) if peak > 0 else 0

        today_str = date.today().isoformat()
        # Get today's P&L
        trades_today = supabase().table("sandbox_trades").select("pnl").eq("status", "closed").eq("exit_date", today_str).execute()
        daily_pnl = sum((r.get("pnl") or 0) for r in (trades_today.data or []))

        wins, total, win_rate = get_overall_win_rate()

        supabase().table("sandbox_equity").upsert({
            "date": today_str,
            "balance": balance,
            "daily_pnl": round(daily_pnl, 2),
            "drawdown_pct": round(drawdown, 4),
            "win_rate": round(win_rate, 2),
        }, on_conflict="date").execute()
    except Exception as e:
        log.debug(f"Equity snapshot failed: {e}")


# ─── Daily performance snapshot ───────────────────────────────────────────────

def record_daily_performance() -> None:
    today_str = date.today().isoformat()
    try:
        # Get all trades closed today
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .eq("exit_date", today_str)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return
        wins = sum(1 for r in rows if (r.get("pnl") or 0) > 0)
        losses = len(rows) - wins
        gross_pnl = sum((r.get("pnl") or 0) for r in rows)
        win_rate = wins / len(rows) * 100 if rows else 0

        supabase().table("sandbox_performance").upsert({
            "date": today_str,
            "trades_closed": len(rows),
            "wins": wins,
            "losses": losses,
            "win_rate": round(win_rate, 2),
            "gross_pnl": round(gross_pnl, 2),
        }, on_conflict="date").execute()
        log.info(f"Sandbox daily performance: {wins}W/{losses}L ({win_rate:.1f}%) P&L ${gross_pnl:+.2f}")
    except Exception as e:
        log.error(f"record_daily_performance failed: {e}")


# ─── Nightly self-critique ────────────────────────────────────────────────────

_critique_done_date: date | None = None

async def run_nightly_critique() -> dict:
    """
    5pm ET: Groq reviews ALL of today's closed trades as a batch.
    Identifies patterns in losses, blind spots, and rule violations.
    Stores critique in prediction_lessons as ticker=GROQ_SELF so it's
    injected into tomorrow's entry decisions.
    """
    global _critique_done_date
    today = date.today()
    if _critique_done_date == today:
        return {"status": "skipped", "reason": "already ran today"}

    today_str = today.isoformat()

    # Fetch all trades closed today
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("*")
            .eq("status", "closed")
            .eq("exit_date", today_str)
            .execute()
        )
        trades = res.data or []
    except Exception as e:
        log.error(f"Critique fetch failed: {e}")
        return {"status": "error", "reason": str(e)}

    if not trades:
        log.info("No closed trades today — skipping critique")
        return {"status": "skipped", "reason": "no trades today"}

    # Fetch yesterday's critique so Groq can see if it's repeating mistakes
    try:
        yesterday = (today - timedelta(days=1)).isoformat()
        prev_res = (
            supabase().table("prediction_lessons")
            .select("lesson,key_factors")
            .eq("ticker", "GROQ_SELF")
            .eq("date", yesterday)
            .limit(1)
            .execute()
        )
        prev_critique = prev_res.data[0].get("lesson", "") if prev_res.data else ""
    except Exception:
        prev_critique = ""

    # Get overall account state
    wins_today = [t for t in trades if (t.get("pnl") or 0) > 0]
    losses_today = [t for t in trades if (t.get("pnl") or 0) < 0]
    gross_pnl = sum((t.get("pnl") or 0) for t in trades)
    win_rate_today = len(wins_today) / len(trades) * 100 if trades else 0
    _, total_trades, overall_win_rate = get_overall_win_rate()

    # Build detailed trade log
    trade_lines = []
    for t in trades:
        outcome = "WIN" if (t.get("pnl") or 0) > 0 else "LOSS"
        pnl_pct = t.get("pnl_pct") or 0
        direction = t.get("direction", "?")
        ticker = t.get("ticker", "?")
        entry = t.get("entry_price", 0)
        exit_p = t.get("exit_price", 0)
        stop = t.get("stop_loss", 0)
        target = t.get("target_price", 0)
        reason = t.get("exit_reason", "?")
        thesis = (t.get("groq_thesis") or "")[:100]
        conf = t.get("confidence_used", "?")
        signals = t.get("signals_at_entry") or []
        sig_str = ", ".join(f"{s.get('type','?')}({s.get('sev','?')})" for s in signals[:3])

        trade_lines.append(
            f"[{outcome}] {ticker} {direction.upper()} @ ${entry:.2f} → ${exit_p:.2f} "
            f"({pnl_pct:+.1f}%) | conf={conf} | exit={reason}\n"
            f"  Stop=${stop:.2f} Target=${target:.2f} | Signals: {sig_str or 'none'}\n"
            f"  Thesis: {thesis}"
        )

    trade_block = "\n\n".join(trade_lines)

    prompt = f"""You are reviewing your own trading decisions from today ({today_str}).

TODAY'S RESULTS:
{len(wins_today)}W / {len(losses_today)}L | Win rate: {win_rate_today:.1f}% | P&L: ${gross_pnl:+.2f}
Overall account win rate: {overall_win_rate:.1f}% ({total_trades} total trades)

TODAY'S TRADES:
{trade_block}

YESTERDAY'S SELF-CRITIQUE (check if you repeated the same mistakes):
{prev_critique[:400] if prev_critique else "No prior critique."}

Be brutally honest. Analyze your decisions as a batch — not one at a time. Answer:

**PATTERN IN LOSSES**: What do the losing trades have in common? Wrong direction, too tight stops, bad timing, ignored market conditions, low conviction entries?

**PATTERN IN WINS**: What made the winning trades work? Can you do more of this?

**RULE VIOLATIONS**: Did you take trades that violated your own rules? Low R:R, traded against the morning outlook, entered when confidence was borderline?

**REPEATED MISTAKES**: Compare to yesterday — are you making the same errors again?

**TOMORROW'S ADJUSTMENTS**: Give 3 specific, concrete rule changes for tomorrow. Not generic advice — specific: "Don't short tech when QQQ pre-market is +0.5%+" or "Skip day trades on tickers with no signals in last 4h"

**SELF-SCORE**: Rate today's decision quality 1-10 (separate from P&L — a lucky win on a bad setup is still bad trading).

Be direct. You are critiquing yourself, not being polite."""

    critique = await _call_groq(prompt, max_tokens=700)
    if not critique:
        log.warning("Nightly critique Groq call failed")
        return {"status": "error", "reason": "groq failed"}

    _critique_done_date = today

    # Store as a special ticker "GROQ_SELF" so it's queryable but doesn't pollute ticker lessons
    try:
        supabase().table("prediction_lessons").upsert({
            "ticker": "GROQ_SELF",
            "date": today_str,
            "bias": "long" if win_rate_today >= 50 else "short",
            "actual_bias": "long" if gross_pnl >= 0 else "short",
            "in_range": win_rate_today >= 50,
            "lesson": critique[:2000],
            "confidence_pct": int(win_rate_today),
            "key_factors": {
                "wins": len(wins_today),
                "losses": len(losses_today),
                "win_rate": round(win_rate_today, 1),
                "gross_pnl": round(gross_pnl, 2),
                "total_trades": len(trades),
                "source": "nightly_critique",
            },
            "signals_used": None,
        }, on_conflict="ticker,date").execute()
        log.info(f"Nightly critique stored: {win_rate_today:.1f}% win rate today, ${gross_pnl:+.2f}")
    except Exception as e:
        log.error(f"Critique store failed: {e}")

    # Also insert as a signal so it appears on the dashboard
    insert_signal(
        "GROQ_SELF",
        "convergence",
        6.0,
        f"Groq Self-Critique {today_str} — {win_rate_today:.0f}% win rate",
        critique[:1000],
        {
            "wins": len(wins_today),
            "losses": len(losses_today),
            "gross_pnl": round(gross_pnl, 2),
            "critique_type": "nightly_self_review",
        },
    )

    return {
        "status": "ok",
        "trades_reviewed": len(trades),
        "win_rate": round(win_rate_today, 1),
        "gross_pnl": round(gross_pnl, 2),
    }


# ─── Main run_once entry point ────────────────────────────────────────────────

async def run_once() -> dict:
    if not is_weekday():
        return {"status": "skipped", "reason": "weekend"}

    et = now_et()
    hour = et.hour
    minute = et.minute

    open_positions = get_open_positions()
    open_tickers = {p["ticker"] for p in open_positions}

    async with httpx.AsyncClient(timeout=15) as client:

        # 9:30am–12:30pm ET: scan for new entries
        in_entry_window = (hour == 9 and minute >= 30) or (9 < hour < 12) or (hour == 12 and minute <= 30)
        if in_entry_window:

            # #1 — Regime detection: skip all entries if market is choppy
            if is_choppy_market():
                return {"status": "skipped", "reason": "choppy market regime — VIX too high"}

            # #3 — Dead zone: block 12pm-2pm ET
            if is_in_dead_zone():
                return {"status": "skipped", "reason": "dead zone 12-2pm ET"}

            # #9 — Daily loss limit: stop trading if account down 2% today
            daily_pnl = get_daily_pnl()
            account_balance = get_account_balance()
            daily_loss_pct = (daily_pnl / account_balance * 100) if account_balance > 0 else 0
            if daily_loss_pct <= -2.0:
                log.info(f"Daily loss limit hit: {daily_loss_pct:.1f}% — stopping entries for today")
                return {"status": "skipped", "reason": f"daily loss limit hit ({daily_loss_pct:.1f}%)"}

            # Count how many trades already entered today
            today_str = date.today().isoformat()
            try:
                today_entries_res = supabase().table("sandbox_trades").select("id").eq("entry_date", today_str).execute()
                today_entry_count = len(today_entries_res.data or [])
            except Exception:
                today_entry_count = 0

            if today_entry_count < MAX_DAILY_ENTRIES and len(open_positions) < MAX_OPEN_POSITIONS:
                tickers = await get_scan_universe(client)
                entries = 0
                slots_left = min(MAX_DAILY_ENTRIES - today_entry_count, MAX_OPEN_POSITIONS - len(open_positions))

                for ticker in tickers:
                    if entries >= slots_left:
                        break
                    if ticker in open_tickers:
                        continue
                    try:
                        trade = await decide_entry(client, ticker, open_tickers, open_positions)
                        if trade:
                            res = supabase().table("sandbox_trades").insert(trade).execute()
                            if res.data:
                                inserted = res.data[0]
                                trade["id"] = inserted.get("id")  # add DB-generated id
                                open_tickers.add(ticker)
                                open_positions.append(trade)  # keep sector counts current
                                entries += 1
                                conviction = trade.get("conviction_label", "standard")
                                log.info(f"Sandbox entered {trade['direction']} {ticker} @ ${trade['entry_price']:.2f} ({trade['trade_type']}) | {conviction} | risk=${trade.get('risk_amount', 0):.0f}")
                    except Exception as e:
                        log.error(f"Entry decision failed for {ticker}: {e}")
                    await asyncio.sleep(2)

                return {"status": "ok", "action": "entry_scan", "entries": entries, "today_total": today_entry_count + entries, "open": len(open_tickers)}

        # 4:00–4:15 ET: close all day trades + evaluate swings + record performance
        if hour == 16 and minute < 15:
            closed = 0
            for trade in open_positions:
                try:
                    await evaluate_open_trade(client, trade)
                    closed += 1
                except Exception as e:
                    log.error(f"EOD evaluation failed for {trade['ticker']}: {e}")
                await asyncio.sleep(1)
            record_daily_performance()

            # #15 — Daily P&L push at 4pm close
            try:
                today_str = date.today().isoformat()
                day_res = supabase().table("sandbox_trades").select("pnl,direction,ticker").eq("status", "closed").eq("exit_date", today_str).execute()
                day_trades = day_res.data or []
                if day_trades:
                    day_wins = sum(1 for t in day_trades if (t.get("pnl") or 0) > 0)
                    day_losses = len(day_trades) - day_wins
                    day_pnl = sum((t.get("pnl") or 0) for t in day_trades)
                    day_wr = day_wins / len(day_trades) * 100
                    new_bal = get_account_balance()
                    total_ret = (new_bal - STARTING_BALANCE) / STARTING_BALANCE * 100
                    push_title = f"📊 Sandbox EOD: {day_wins}W/{day_losses}L ({day_wr:.0f}%)"
                    push_body = f"Today: {'+' if day_pnl >= 0 else ''}${day_pnl:.0f} | Account: ${new_bal:,.0f} ({total_ret:+.1f}% total)"
                    send_push_notification(push_title, push_body, severity=7.0)
            except Exception as e:
                log.debug(f"Daily P&L push failed: {e}")

            return {"status": "ok", "action": "eod_close", "evaluated": closed}

        # 5:00–5:15 ET: nightly self-critique
        if hour == 17 and minute < 15:
            critique_result = await run_nightly_critique()
            return {"status": "ok", "action": "nightly_critique", **critique_result}

        # During market hours: re-evaluate open swing trades every 30 min
        if is_market_hours() and open_positions:
            checked = 0
            for trade in open_positions:
                if trade.get("trade_type") == "swing":
                    try:
                        await evaluate_open_trade(client, trade)
                        checked += 1
                    except Exception as e:
                        log.error(f"Swing eval failed for {trade['ticker']}: {e}")
                    await asyncio.sleep(1)
            return {"status": "ok", "action": "swing_check", "checked": checked}

    return {"status": "ok", "action": "idle", "open_positions": len(open_positions)}


async def main_loop():
    log.info("Sandbox worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Sandbox tick: {result}")
        except Exception as e:
            log.error(f"Sandbox loop error: {e}")
        await asyncio.sleep(1800)  # every 30 min
