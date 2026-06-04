"""
Earnings Worker — tracks upcoming earnings dates and historical move size.

Data sources:
- Polygon /vX/reference/financials (announcement dates per ticker)
- Polygon /v3/reference/tickers/{ticker}/events (corporate events, includes earnings)
- Polygon daily aggregates (for computing historical earnings-day move)

Signals:
- earnings_upcoming: when a watched ticker reports within next 7 days (severity scales with proximity)
- earnings_move: after earnings, if the move was >5% vs historical average
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone, timedelta, date
from db import get_watchlist_tickers, insert_signal

log = logging.getLogger("earnings_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

# Dedup: ticker+earnings_date so we don't re-alert
_alerted: dict[str, float] = {}
_ALERT_TTL = 86400 * 30  # 30 days


def _evict():
    now = datetime.now(timezone.utc).timestamp()
    stale = [k for k, ts in _alerted.items() if now - ts > _ALERT_TTL]
    for k in stale:
        del _alerted[k]


async def fetch_earnings_date(client: httpx.AsyncClient, ticker: str) -> str | None:
    """
    Returns the next upcoming earnings date as ISO string, or None.
    Uses Polygon /vX/reference/financials which includes report_period and filing_date.
    """
    if not POLYGON_KEY:
        return None
    try:
        # Polygon doesn't expose future earnings dates directly on free tier — try the events endpoint
        r = await client.get(
            f"{POLYGON_BASE}/v3/reference/tickers/{ticker.upper()}/events",
            params={"apiKey": POLYGON_KEY, "types": "ticker_change"},
            timeout=10,
        )
        # Most users don't have this — fall back to the financials filing pattern
    except Exception:
        pass

    # Use financial filings — average gap between filings predicts the next one
    try:
        r = await client.get(
            f"{POLYGON_BASE}/vX/reference/financials",
            params={"apiKey": POLYGON_KEY, "ticker": ticker.upper(), "limit": 4, "order": "desc", "sort": "filing_date"},
            timeout=15,
        )
        if r.status_code != 200:
            return None
        results = r.json().get("results", [])
        if not results:
            return None
        # Most recent filing date
        last_filing = results[0].get("filing_date") or results[0].get("end_date")
        if not last_filing:
            return None
        # Quarterly cadence — next is ~91 days after last
        last_dt = datetime.fromisoformat(str(last_filing).replace("Z", "+00:00"))
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=timezone.utc)
        next_estimate = last_dt + timedelta(days=91)
        return next_estimate.date().isoformat()
    except Exception as e:
        log.debug(f"Earnings date estimate failed for {ticker}: {e}")
        return None


async def fetch_historical_move(client: httpx.AsyncClient, ticker: str) -> float | None:
    """
    Average absolute % move on past earnings days. Used to set expectations.
    Heuristic: scan past 2 years of daily bars, find days with abnormally large volume
    (>2.5x avg) — those are likely earnings days. Average the abs change.
    """
    if not POLYGON_KEY:
        return None
    today = date.today()
    start = (today - timedelta(days=730)).isoformat()
    try:
        r = await client.get(
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker.upper()}/range/1/day/{start}/{today.isoformat()}",
            params={"apiKey": POLYGON_KEY, "limit": 500, "sort": "asc"},
            timeout=15,
        )
        if r.status_code != 200:
            return None
        bars = r.json().get("results", [])
        if len(bars) < 30:
            return None
        vols = [b.get("v", 0) for b in bars if b.get("v")]
        avg_vol = sum(vols) / len(vols) if vols else 0
        if avg_vol == 0:
            return None
        moves = []
        for i in range(1, len(bars)):
            v = bars[i].get("v", 0)
            prev_c = bars[i - 1].get("c")
            c = bars[i].get("c")
            if v > avg_vol * 2.5 and prev_c and c and prev_c > 0:
                pct = abs((c - prev_c) / prev_c) * 100
                if 1 < pct < 30:  # filter outliers
                    moves.append(pct)
        return sum(moves) / len(moves) if moves else None
    except Exception as e:
        log.debug(f"Historical move calc failed for {ticker}: {e}")
        return None


async def process_ticker(client: httpx.AsyncClient, ticker: str) -> None:
    next_date = await fetch_earnings_date(client, ticker)
    if not next_date:
        return

    today = date.today()
    try:
        ed = date.fromisoformat(next_date)
    except ValueError:
        return

    days_until = (ed - today).days
    if days_until < 0 or days_until > 7:
        return

    dedup_key = f"{ticker}-{next_date}"
    if dedup_key in _alerted:
        return
    _alerted[dedup_key] = datetime.now(timezone.utc).timestamp()

    hist_move = await fetch_historical_move(client, ticker)

    if days_until == 0:
        sev = 8
        when = "today"
    elif days_until <= 2:
        sev = 7
        when = f"in {days_until} day{'s' if days_until > 1 else ''}"
    elif days_until <= 5:
        sev = 6
        when = f"in {days_until} days"
    else:
        sev = 5
        when = f"in {days_until} days"

    body = f"{ticker} reports earnings {when} (estimated {next_date})."
    if hist_move:
        body += f" Historical earnings-day move averages {hist_move:.1f}%."
    body += " Options IV usually spikes into the print — check the chain for setup."

    insert_signal(
        ticker, "earnings_upcoming", sev,
        f"{ticker} earnings {when}",
        body,
        {"earnings_date": next_date, "days_until": days_until, "historical_move_pct": hist_move},
    )


async def run_once() -> dict:
    if not POLYGON_KEY:
        return {"status": "skipped", "reason": "POLYGON_API_KEY not set"}
    _evict()
    tickers = get_watchlist_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no tickers"}

    async with httpx.AsyncClient() as client:
        for i in range(0, len(tickers), 5):
            batch = tickers[i:i + 5]
            await asyncio.gather(*[process_ticker(client, t) for t in batch], return_exceptions=True)
            await asyncio.sleep(1)

    return {"status": "ok", "checked": len(tickers)}


async def main_loop():
    log.info("Earnings worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Earnings tick: {result}")
        except Exception as e:
            log.error(f"Earnings loop error: {e}")
        # Check every 6h — earnings dates rarely shift intraday
        await asyncio.sleep(6 * 3600)
