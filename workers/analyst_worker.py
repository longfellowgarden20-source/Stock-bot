"""
Analyst Worker — tracks ratings changes and price target adjustments.

Uses Polygon /v3/reference/tickers + Benzinga-equivalent data through Polygon's
analyst rating change endpoint. Falls back to Finnhub-style scrapes if needed.

Signals:
- analyst_change: upgrade or downgrade
- price_target_raised: new PT > prior consensus
- price_target_cut: new PT < prior consensus
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone, timedelta
from db import get_watchlist_tickers, insert_signal, supabase

log = logging.getLogger("analyst_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"
# Finnhub is free-tier friendly and exposes analyst recommendations cleanly
FINNHUB_KEY = os.environ.get("FINNHUB_API_KEY", "")
FINNHUB_BASE = "https://finnhub.io/api/v1"

_seen_ids: set[str] = set()


async def fetch_analyst_changes_finnhub(client: httpx.AsyncClient, ticker: str) -> list[dict]:
    """Finnhub price target endpoint — returns analyst price target snapshots."""
    if not FINNHUB_KEY:
        return []
    try:
        r = await client.get(
            f"{FINNHUB_BASE}/stock/price-target",
            params={"symbol": ticker.upper(), "token": FINNHUB_KEY},
            timeout=10,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        if not data or not isinstance(data, dict):
            return []
        return [data] if data.get("symbol") else []
    except Exception as e:
        log.debug(f"Finnhub PT fetch failed for {ticker}: {e}")
        return []


async def fetch_recommendation_trends(client: httpx.AsyncClient, ticker: str) -> list[dict]:
    """Finnhub recommendation trends — monthly buy/hold/sell counts."""
    if not FINNHUB_KEY:
        return []
    try:
        r = await client.get(
            f"{FINNHUB_BASE}/stock/recommendation",
            params={"symbol": ticker.upper(), "token": FINNHUB_KEY},
            timeout=10,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        log.debug(f"Finnhub recs fetch failed for {ticker}: {e}")
        return []


def _detect_change(curr: dict, prev: dict | None) -> tuple[str | None, dict]:
    """Compare current vs prior month's recommendation breakdown."""
    if not prev:
        return None, {}
    fields = ["strongBuy", "buy", "hold", "sell", "strongSell"]
    deltas = {f: int(curr.get(f, 0)) - int(prev.get(f, 0)) for f in fields}
    bullish_delta = deltas["strongBuy"] + deltas["buy"]
    bearish_delta = deltas["sell"] + deltas["strongSell"]
    if bullish_delta >= 2 and bearish_delta <= 0:
        return "upgrade_wave", deltas
    if bearish_delta >= 2 and bullish_delta <= 0:
        return "downgrade_wave", deltas
    return None, deltas


async def process_ticker(client: httpx.AsyncClient, ticker: str) -> None:
    # Get latest snapshot
    pt_rows = await fetch_analyst_changes_finnhub(client, ticker)
    if pt_rows:
        pt = pt_rows[0]
        pt_high = pt.get("targetHigh")
        pt_low = pt.get("targetLow")
        pt_mean = pt.get("targetMean")
        pt_median = pt.get("targetMedian")
        last_updated = pt.get("lastUpdated", "")

        dedup_key = f"pt-{ticker}-{last_updated}"
        if dedup_key not in _seen_ids and pt_mean:
            _seen_ids.add(dedup_key)
            # Check against prior stored snapshot
            try:
                prev_res = supabase().table("signals").select("raw_data").eq("ticker", ticker.upper()).eq("signal_type", "analyst_change").order("created_at", desc=True).limit(1).execute()
                prev_mean = None
                if prev_res.data:
                    prev_mean = (prev_res.data[0].get("raw_data") or {}).get("pt_mean")
                if prev_mean and abs(pt_mean - prev_mean) / prev_mean >= 0.05:
                    direction = "raised" if pt_mean > prev_mean else "cut"
                    pct = ((pt_mean - prev_mean) / prev_mean) * 100
                    sev = 7 if abs(pct) >= 15 else 6
                    insert_signal(
                        ticker, "analyst_change", sev,
                        f"{ticker} consensus PT {direction} {abs(pct):.0f}%",
                        f"Analyst consensus price target {direction} from ${prev_mean:.2f} to ${pt_mean:.2f} (range ${pt_low:.2f}–${pt_high:.2f}).",
                        {"pt_mean": pt_mean, "pt_high": pt_high, "pt_low": pt_low, "pt_median": pt_median, "prior_mean": prev_mean, "direction": direction},
                    )
                elif not prev_mean:
                    # First reading — store baseline silently as a low-sev signal
                    insert_signal(
                        ticker, "analyst_change", 4,
                        f"{ticker} analyst PT baseline ${pt_mean:.2f}",
                        f"Tracking consensus price target: ${pt_mean:.2f} (range ${pt_low:.2f}–${pt_high:.2f}). Future changes will be compared against this.",
                        {"pt_mean": pt_mean, "pt_high": pt_high, "pt_low": pt_low, "pt_median": pt_median, "baseline": True},
                    )
            except Exception as e:
                log.error(f"PT comparison failed for {ticker}: {e}")

    # Recommendation trend (upgrade/downgrade waves)
    recs = await fetch_recommendation_trends(client, ticker)
    if recs and len(recs) >= 2:
        # Most recent first in Finnhub response
        curr, prev = recs[0], recs[1]
        period = curr.get("period", "")
        dedup_key = f"rec-{ticker}-{period}"
        if dedup_key not in _seen_ids:
            _seen_ids.add(dedup_key)
            kind, deltas = _detect_change(curr, prev)
            if kind == "upgrade_wave":
                insert_signal(
                    ticker, "analyst_change", 7,
                    f"{ticker} analyst upgrade wave",
                    f"Multiple analysts upgraded {ticker} this period. Buy ratings +{deltas['buy']}, Strong Buy +{deltas['strongBuy']}. Current consensus: {curr.get('buy', 0)} buy, {curr.get('hold', 0)} hold, {curr.get('sell', 0)} sell.",
                    {"direction": "upgrade", "current": curr, "prior": prev, "deltas": deltas},
                )
            elif kind == "downgrade_wave":
                insert_signal(
                    ticker, "analyst_change", 7,
                    f"{ticker} analyst downgrade wave",
                    f"Multiple analysts downgraded {ticker} this period. Sell +{deltas['sell']}, Strong Sell +{deltas['strongSell']}. Current consensus: {curr.get('buy', 0)} buy, {curr.get('hold', 0)} hold, {curr.get('sell', 0)} sell.",
                    {"direction": "downgrade", "current": curr, "prior": prev, "deltas": deltas},
                )


async def run_once() -> dict:
    if not FINNHUB_KEY:
        return {"status": "skipped", "reason": "FINNHUB_API_KEY not set"}
    tickers = get_watchlist_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no tickers"}

    async with httpx.AsyncClient() as client:
        for ticker in tickers:
            try:
                await process_ticker(client, ticker)
            except Exception as e:
                log.error(f"Analyst process failed for {ticker}: {e}")
            await asyncio.sleep(1.5)  # finnhub free tier: 60/min

    return {"status": "ok", "checked": len(tickers)}


async def main_loop():
    log.info("Analyst worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Analyst tick: {result}")
        except Exception as e:
            log.error(f"Analyst loop error: {e}")
        # Every 4h — ratings don't change often
        await asyncio.sleep(4 * 3600)
