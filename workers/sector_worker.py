"""
Sector Rotation Worker — tracks 5-day relative performance of sector SPDRs.

Identifies money flow between sectors — money rotating out of tech (XLK) into energy (XLE)
is one of the strongest macro tells in the market.

Sector ETFs tracked:
- XLK Technology
- XLF Financials
- XLE Energy
- XLV Healthcare
- XLY Discretionary
- XLP Staples
- XLI Industrials
- XLU Utilities
- XLB Materials
- XLRE Real Estate
- XLC Communications

Signal: sector_rotation when a sector is +3% over 5d while another is -3% (clear flow).
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone, timedelta, date
from db import insert_signal

log = logging.getLogger("sector_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

SECTORS = {
    "XLK": "Technology",
    "XLF": "Financials",
    "XLE": "Energy",
    "XLV": "Healthcare",
    "XLY": "Consumer Discretionary",
    "XLP": "Consumer Staples",
    "XLI": "Industrials",
    "XLU": "Utilities",
    "XLB": "Materials",
    "XLRE": "Real Estate",
    "XLC": "Communications",
}

_last_rotation: dict[str, float] = {}
_COOLDOWN = 86400 * 2  # don't re-emit same rotation pair within 48h


async def fetch_5d_change(client: httpx.AsyncClient, ticker: str) -> float | None:
    today = date.today()
    start = (today - timedelta(days=10)).isoformat()
    try:
        r = await client.get(
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start}/{today.isoformat()}",
            params={"apiKey": POLYGON_KEY, "limit": 10, "sort": "asc"},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        results = r.json().get("results", [])
        if len(results) < 6:
            return None
        # 5 trading days back vs latest close
        recent = results[-1].get("c")
        five_back = results[-6].get("c")
        if not recent or not five_back or five_back == 0:
            return None
        return ((recent - five_back) / five_back) * 100
    except Exception as e:
        log.error(f"Sector fetch failed for {ticker}: {e}")
        return None


async def run_once() -> dict:
    if not POLYGON_KEY:
        return {"status": "skipped", "reason": "POLYGON_API_KEY not set"}

    perf: dict[str, float] = {}
    async with httpx.AsyncClient() as client:
        for ticker in SECTORS:
            change = await fetch_5d_change(client, ticker)
            if change is not None:
                perf[ticker] = change
            await asyncio.sleep(0.3)

    if len(perf) < 2:
        return {"status": "no_data"}

    # Find best and worst sectors
    sorted_perf = sorted(perf.items(), key=lambda x: x[1], reverse=True)
    best_ticker, best_pct = sorted_perf[0]
    worst_ticker, worst_pct = sorted_perf[-1]

    if best_pct >= 3 and worst_pct <= -3:
        pair_key = f"{best_ticker}-{worst_ticker}"
        now = datetime.now(timezone.utc).timestamp()
        if now - _last_rotation.get(pair_key, 0) >= _COOLDOWN:
            _last_rotation[pair_key] = now
            spread = best_pct - worst_pct
            insert_signal(
                best_ticker, "macro", 7,
                f"Sector rotation: into {SECTORS[best_ticker]}, out of {SECTORS[worst_ticker]}",
                f"{SECTORS[best_ticker]} ({best_ticker}) up {best_pct:+.1f}% over 5d while {SECTORS[worst_ticker]} ({worst_ticker}) down {worst_pct:+.1f}%. Spread {spread:.1f}%. Money flow regime shift — leaders and laggards diverging.",
                {
                    "best_sector": best_ticker,
                    "best_pct": best_pct,
                    "worst_sector": worst_ticker,
                    "worst_pct": worst_pct,
                    "spread": spread,
                    "all_sectors": perf,
                },
            )

    return {"status": "ok", "sectors": perf}


async def main_loop():
    log.info("Sector worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Sector tick: {result}")
        except Exception as e:
            log.error(f"Sector loop error: {e}")
        await asyncio.sleep(6 * 3600)  # 6h
