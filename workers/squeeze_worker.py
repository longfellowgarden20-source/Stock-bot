"""
Short Squeeze Worker — monitors short interest, borrow rates, and failed-to-deliver data.

Data sources:
- Polygon.io: short interest via /v3/reference/tickers/{ticker} (shares outstanding)
- FINRA short sale data (free, FTP): weekly short volume
- SEC FTD data (free): bi-monthly failed-to-deliver CSV
- Polygon snapshot: float approximation via shares outstanding

Signals emitted:
- short_squeeze: when multiple squeeze conditions converge
  * Short interest > 20% of float
  * Days-to-cover > 5 (at current avg volume)
  * Borrow rate elevation (if available)
  * FTD spike
"""
import os
import logging
import httpx
import asyncio
import csv
import io
from datetime import datetime, timezone, timedelta, date
from db import get_watchlist_tickers, insert_signal, polygon_get

log = logging.getLogger("squeeze_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

# Cache: ticker -> (data_dict, fetched_ts)
_si_cache: dict[str, tuple[dict, float]] = {}
_SI_TTL = 3600 * 6  # 6h — short interest data is stale anyway

# FTD data cache — reloaded weekly
_ftd_cache: dict[str, int] = {}  # ticker -> ftd_count
_ftd_loaded_at: float = 0
_FTD_TTL = 86400 * 3  # reload every 3 days


async def fetch_ticker_details(client: httpx.AsyncClient, ticker: str) -> dict | None:
    """Polygon ticker details: shares outstanding, float if available."""
    if not POLYGON_KEY:
        return None
    cached = _si_cache.get(ticker)
    if cached and (datetime.now(timezone.utc).timestamp() - cached[1]) < _SI_TTL:
        return cached[0]
    try:
        r = await polygon_get(client, f"{POLYGON_BASE}/v3/reference/tickers/{ticker.upper()}",
            params={"apiKey": POLYGON_KEY},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        result = r.json().get("results", {})
        data = {
            "shares_outstanding": result.get("share_class_shares_outstanding") or result.get("weighted_shares_outstanding"),
            "market_cap": result.get("market_cap"),
            "name": result.get("name", ticker),
        }
        _si_cache[ticker] = (data, datetime.now(timezone.utc).timestamp())
        return data
    except Exception as e:
        log.error(f"Ticker details failed for {ticker}: {e}")
        return None


async def fetch_finra_short_volume(client: httpx.AsyncClient, ticker: str) -> dict | None:
    """
    FINRA short sale volume data via their public API.
    Returns short volume + total volume for most recent day available.
    """
    try:
        import json as _json
        compare_filter = _json.dumps([{
            "fieldName": "issueSymbolIdentifier",
            "compareType": "equal",
            "fieldValue": ticker.upper()
        }])
        # FINRA OTC short sale data (free, no auth required)
        r = await client.get(
            f"https://api.finra.org/data/group/OTCMarket/name/weeklySummary?compareFilters={compare_filter}&limit=5&sortFields=-weekStartDate",
            timeout=15,
        )
        if r.status_code != 200:
            return None
        results = r.json()
        if not results:
            return None
        row = results[0]
        short_vol = float(row.get("shortParQuantity", 0) or 0)
        total_vol = float(row.get("totalParQuantity", row.get("totalVolume", 1)) or 1)
        return {
            "short_volume": short_vol,
            "total_volume": total_vol,
            "short_pct_of_volume": (short_vol / total_vol * 100) if total_vol > 0 else None,
            "week": row.get("weekStartDate", ""),
        }
    except Exception as e:
        log.debug(f"FINRA short vol unavailable for {ticker}: {e}")
        return None


async def load_ftd_data(client: httpx.AsyncClient) -> None:
    """
    Load SEC failed-to-deliver data. Published bi-monthly as CSV.
    URL pattern: https://www.sec.gov/data/foiadocsfailsdataYYYYMMDD.zip
    We fetch the most recent known file.
    """
    global _ftd_loaded_at
    now = datetime.now(timezone.utc).timestamp()
    if now - _ftd_loaded_at < _FTD_TTL:
        return

    # SEC publishes FTD data twice monthly (around 1st and 15th)
    today = date.today()
    # Try current month first, then prior month
    candidates = []
    for month_offset in range(3):
        m = today.replace(day=1) - timedelta(days=30 * month_offset)
        candidates.append(f"{m.year}{m.month:02d}15")
        candidates.append(f"{m.year}{m.month:02d}01")

    for date_str in candidates:
        url = f"https://www.sec.gov/data/foiadocsfailsdata{date_str}.zip"
        try:
            r = await client.get(
                url,
                headers={"User-Agent": os.environ.get("SEC_USER_AGENT", "StockBot research@example.com")},
                timeout=30,
                follow_redirects=True,
            )
            if r.status_code == 200:
                import zipfile
                with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
                    names = zf.namelist()
                    if names:
                        content = zf.read(names[0]).decode("latin-1")
                        reader = csv.DictReader(io.StringIO(content), delimiter="|")
                        new_ftd: dict[str, int] = {}
                        for row in reader:
                            sym = str(row.get("SYMBOL", "") or "").upper().strip()
                            qty = int(row.get("QUANTITY (FAILS)", row.get("QUANTITY", 0)) or 0)
                            if sym:
                                new_ftd[sym] = new_ftd.get(sym, 0) + qty
                        _ftd_cache.clear()
                        _ftd_cache.update(new_ftd)
                        _ftd_loaded_at = now
                        log.info(f"FTD data loaded ({date_str}): {len(new_ftd)} tickers")
                        return
        except Exception as e:
            log.debug(f"FTD load failed for {date_str}: {e}")

    log.warning("Could not load SEC FTD data — all candidates failed")


async def fetch_avg_volume(client: httpx.AsyncClient, ticker: str) -> float | None:
    """30-day average daily volume from Polygon aggregates."""
    if not POLYGON_KEY:
        return None
    today = date.today()
    start = (today - timedelta(days=60)).isoformat()
    end = (today - timedelta(days=1)).isoformat()
    try:
        r = await polygon_get(client, f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start}/{end}",
            params={"apiKey": POLYGON_KEY, "limit": 60, "sort": "desc"},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        results = r.json().get("results", [])
        if not results:
            return None
        vols = [b.get("v", 0) for b in results[:30] if b.get("v")]
        return sum(vols) / len(vols) if vols else None
    except Exception as e:
        log.error(f"Avg vol fetch failed for {ticker}: {e}")
        return None


def score_squeeze(
    ticker: str,
    short_pct_float: float | None,
    days_to_cover: float | None,
    ftd_count: int,
    short_pct_volume: float | None,
) -> tuple[int, list[str]]:
    """Score squeeze potential 0-10 based on available data. Returns (score, reasons)."""
    score = 0
    reasons = []

    if short_pct_float is not None:
        if short_pct_float >= 30:
            score += 4
            reasons.append(f"{short_pct_float:.1f}% of float sold short (extreme)")
        elif short_pct_float >= 20:
            score += 3
            reasons.append(f"{short_pct_float:.1f}% of float sold short (high)")
        elif short_pct_float >= 10:
            score += 1
            reasons.append(f"{short_pct_float:.1f}% of float sold short")

    if days_to_cover is not None:
        if days_to_cover >= 10:
            score += 3
            reasons.append(f"{days_to_cover:.1f} days to cover (severe)")
        elif days_to_cover >= 5:
            score += 2
            reasons.append(f"{days_to_cover:.1f} days to cover")
        elif days_to_cover >= 3:
            score += 1
            reasons.append(f"{days_to_cover:.1f} days to cover")

    if ftd_count > 0:
        if ftd_count >= 1_000_000:
            score += 3
            reasons.append(f"{ftd_count:,} failed-to-deliver shares (massive)")
        elif ftd_count >= 100_000:
            score += 2
            reasons.append(f"{ftd_count:,} failed-to-deliver shares")
        elif ftd_count >= 10_000:
            score += 1
            reasons.append(f"{ftd_count:,} failed-to-deliver shares")

    if short_pct_volume is not None and short_pct_volume >= 40:
        score += 1
        reasons.append(f"{short_pct_volume:.0f}% of recent volume is short sales")

    return score, reasons


async def process_ticker(client: httpx.AsyncClient, ticker: str) -> None:
    details = await fetch_ticker_details(client, ticker)
    avg_vol = await fetch_avg_volume(client, ticker)
    fin_data = await fetch_finra_short_volume(client, ticker)

    shares_out = details.get("shares_outstanding") if details else None
    ftd_count = _ftd_cache.get(ticker.upper(), 0)

    # FINRA exposes daily short SALE VOLUME — not short interest (outstanding short position).
    # True short_pct_float requires Form SHO short interest data, which isn't free real-time.
    # We use short_pct_of_volume + days-to-cover (estimated as short_vol / avg_vol) as proxies.
    short_vol = fin_data.get("short_volume") if fin_data else None
    short_pct_vol = fin_data.get("short_pct_of_volume") if fin_data else None
    days_to_cover = None
    if short_vol and avg_vol and avg_vol > 0:
        days_to_cover = short_vol / avg_vol

    # Pass None for short_pct_float — we don't have a trustworthy reading.
    score, reasons = score_squeeze(ticker, None, days_to_cover, ftd_count, short_pct_vol)

    # Only signal on meaningful squeeze setups
    if score < 4 or not reasons:
        return

    sev = min(10, 4 + score)
    body = f"Squeeze indicators: {'. '.join(reasons)}."
    if avg_vol:
        body += f" Avg daily volume {int(avg_vol):,}."
    if details and details.get("name"):
        body += f" Company: {details['name']}."

    insert_signal(
        ticker,
        "short_squeeze",
        sev,
        f"{ticker} squeeze setup — score {score}/10",
        body,
        {
            "score": score,
            "days_to_cover": days_to_cover,
            "ftd_count": ftd_count,
            "short_pct_volume": short_pct_vol,
            "avg_volume": avg_vol,
            "shares_outstanding": shares_out,
        },
    )


# Dedup: don't re-emit squeeze signal for same ticker within 24h
_squeeze_last: dict[str, float] = {}
_SQUEEZE_COOLDOWN = 86400


async def run_once() -> dict:
    tickers = get_watchlist_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no tickers"}

    now = datetime.now(timezone.utc).timestamp()

    async with httpx.AsyncClient() as client:
        await load_ftd_data(client)

        for ticker in tickers:
            # Skip if we already fired a squeeze signal recently
            if now - _squeeze_last.get(ticker, 0) < _SQUEEZE_COOLDOWN:
                continue
            try:
                await process_ticker(client, ticker)
                _squeeze_last[ticker] = now
            except Exception as e:
                log.error(f"Squeeze check failed for {ticker}: {e}")
            await asyncio.sleep(0.5)

    return {"status": "ok", "tickers": len(tickers)}


async def main_loop():
    log.info("Squeeze worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Squeeze tick: {result}")
        except Exception as e:
            log.error(f"Squeeze loop error: {e}")
        await asyncio.sleep(3600)  # hourly — short data doesn't change minute-to-minute
