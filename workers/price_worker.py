"""
Price worker — polls Polygon.io for current price/volume on watched tickers.

Strategy:
- Every 5 min during market hours, fetch snapshot for each watched ticker
- Write to snapshots table
- Detect volume spike (>3x avg) → emit volume_spike signal
- Detect price move past threshold (configured per-watchlist entry) → emit price_move signal
"""
import os
import logging
import time
import httpx
import asyncio
from datetime import date, timedelta
from db import supabase, get_watchlist_tickers, insert_snapshot, insert_signal
from market_hours import is_extended_hours

log = logging.getLogger("price_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"


async def fetch_snapshot(client: httpx.AsyncClient, ticker: str) -> dict | None:
    """
    Fetch latest price data. Tries Polygon snapshot first (paid tier),
    falls back to daily aggregates (free tier) if snapshot returns non-200.
    """
    # Try snapshot endpoint (works on paid tier)
    snap_url = f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}"
    try:
        r = await client.get(snap_url, params={"apiKey": POLYGON_KEY}, timeout=10)
        if r.status_code == 200:
            data = r.json()
            if data.get("status") == "OK" and "ticker" in data:
                return data["ticker"]
    except Exception:
        pass

    # Fallback: daily aggregates (free tier) — get today + yesterday for change_pct
    try:
        today = date.today()
        start = (today - timedelta(days=5)).isoformat()
        agg_url = f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start}/{today.isoformat()}"
        r = await client.get(agg_url, params={"apiKey": POLYGON_KEY, "limit": 3, "sort": "desc"}, timeout=10)
        if r.status_code != 200:
            log.warning(f"{ticker}: aggs fallback status {r.status_code}")
            return None
        results = r.json().get("results", [])
        if not results:
            return None
        today_bar = results[0]
        prev_bar = results[1] if len(results) > 1 else {}
        # Wrap into snapshot-compatible shape
        return {
            "day": {"c": today_bar.get("c"), "v": today_bar.get("v"), "o": today_bar.get("o")},
            "prevDay": {"c": prev_bar.get("c")},
            "lastTrade": {"p": today_bar.get("c")},  # use close as last price
        }
    except Exception as e:
        log.error(f"{ticker}: aggs fallback failed — {e}")
        return None


# Avg volume cache — refreshed once per day per ticker
_avg_vol_cache: dict[str, tuple[float, float]] = {}  # ticker -> (avg_vol, fetched_at_ts)
_AVG_VOL_TTL = 24 * 60 * 60  # 24h


async def fetch_avg_volume(client: httpx.AsyncClient, ticker: str) -> float | None:
    """Last 30 trading days avg volume — used for spike detection. Cached 24h."""
    cached = _avg_vol_cache.get(ticker)
    if cached and (time.time() - cached[1]) < _AVG_VOL_TTL:
        return cached[0]

    # Use yesterday backwards 60 calendar days to capture 30 trading days
    today = date.today()
    start = today - timedelta(days=60)
    end = today - timedelta(days=1)  # exclude today
    url = f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start.isoformat()}/{end.isoformat()}"
    try:
        r = await client.get(url, params={"apiKey": POLYGON_KEY, "limit": 60, "sort": "desc"}, timeout=10)
        if r.status_code != 200:
            return None
        results = r.json().get("results", [])
        if not results:
            return None
        vols = [b.get("v", 0) for b in results[:30]]
        if not vols:
            return None
        avg = sum(vols) / len(vols)
        _avg_vol_cache[ticker] = (avg, time.time())
        return avg
    except Exception as e:
        log.error(f"avg vol fetch failed for {ticker}: {e}")
        return None


def get_threshold_for(ticker: str) -> float | None:
    """Per-ticker alert threshold from watchlist."""
    res = supabase().table("watchlist").select("alert_threshold_pct").eq("ticker", ticker.upper()).limit(1).execute()
    if res.data and res.data[0].get("alert_threshold_pct") is not None:
        return float(res.data[0]["alert_threshold_pct"])
    return None


async def process_ticker(client: httpx.AsyncClient, ticker: str) -> None:
    snap = await fetch_snapshot(client, ticker)
    if not snap:
        return

    day = snap.get("day", {}) or {}
    prev_day = snap.get("prevDay", {}) or {}
    last_trade = snap.get("lastTrade", {}) or {}

    price = last_trade.get("p") or day.get("c") or prev_day.get("c")
    volume = day.get("v") or 0
    prev_close = prev_day.get("c")
    change_pct = None
    if price and prev_close:
        change_pct = ((price - prev_close) / prev_close) * 100

    if price is None:
        return

    insert_snapshot(ticker, float(price), int(volume) if volume else None, change_pct)

    # Volume spike detection
    if volume:
        avg_vol = await fetch_avg_volume(client, ticker)
        if avg_vol and avg_vol > 0 and volume >= avg_vol * 3:
            ratio = volume / avg_vol
            sev = 9 if ratio >= 10 else 8 if ratio >= 5 else 7
            insert_signal(
                ticker,
                "volume_spike",
                sev,
                f"{ticker} volume {ratio:.1f}x average",
                f"Trading {volume:,} shares vs 30-day avg {int(avg_vol):,}. {('+' if (change_pct or 0) >= 0 else '')}{(change_pct or 0):.2f}% on day.",
                {"volume": volume, "avg_volume": avg_vol, "ratio": ratio, "price": price, "change_pct": change_pct},
            )

    # User-defined threshold
    threshold = get_threshold_for(ticker)
    if threshold and change_pct is not None and abs(change_pct) >= threshold:
        direction = "up" if change_pct > 0 else "down"
        sev = 8 if abs(change_pct) >= threshold * 2 else 6
        insert_signal(
            ticker,
            "price_move",
            sev,
            f"{ticker} {direction} {abs(change_pct):.2f}%",
            f"Crossed your alert threshold of {threshold}%. Now at ${price:.2f} from prev close ${prev_close:.2f}.",
            {"price": price, "prev_close": prev_close, "change_pct": change_pct, "threshold": threshold},
        )


def get_portfolio_tickers() -> list[str]:
    """Returns only portfolio tickers — these get priority."""
    res = supabase().table("portfolio").select("ticker").execute()
    return sorted({row["ticker"].upper() for row in (res.data or [])})


# #30 — Intraday unusual print detection via Polygon trades API
# Fires when: multiple large prints cluster within a 5-minute window
# Uses REST /v3/trades (no WebSocket required — Polygon free tier has REST access)
_last_print_scan_time: dict[str, float] = {}
_print_scan_cooldown: float = 600  # 10 min cooldown per ticker


async def scan_unusual_prints(client: httpx.AsyncClient, tickers: list[str]) -> int:
    """
    For each ticker, fetch recent trades and look for:
    - 3+ large prints (>$100k notional) within a 5-minute window
    - Single print > $1M notional
    Emits a 'technical' signal with subtype 'unusual_prints' when detected.
    """
    import time
    from datetime import datetime, timezone, timedelta
    if not POLYGON_KEY:
        return 0

    fired = 0
    now_ts = time.monotonic()
    now_utc = datetime.now(timezone.utc)

    for ticker in tickers[:20]:  # cap to 20 tickers per run to respect rate limits
        # Cooldown check — don't hammer same ticker
        last = _last_print_scan_time.get(ticker, 0)
        if now_ts - last < _print_scan_cooldown:
            continue

        try:
            window_start = (now_utc - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
            r = await client.get(
                f"{POLYGON_BASE}/v3/trades/{ticker}",
                params={
                    "apiKey": POLYGON_KEY,
                    "timestamp.gte": window_start,
                    "order": "desc",
                    "limit": 200,
                },
                timeout=8,
            )
            if r.status_code != 200:
                continue
            trades_data = r.json().get("results", [])
            if not trades_data:
                continue

            # Compute notional for each print
            large_prints = []
            for t in trades_data:
                price = float(t.get("price") or 0)
                size = int(t.get("size") or 0)
                notional = price * size
                if notional >= 100_000:
                    large_prints.append({"price": price, "size": size, "notional": notional})

            trigger = False
            reason = ""
            if any(p["notional"] >= 1_000_000 for p in large_prints):
                trigger = True
                big = max(large_prints, key=lambda x: x["notional"])
                reason = f"Single print ${big['notional']:,.0f} ({big['size']:,} shares @ ${big['price']:.2f})"
            elif len(large_prints) >= 3:
                total_notional = sum(p["notional"] for p in large_prints)
                trigger = True
                reason = f"{len(large_prints)} large prints totalling ${total_notional:,.0f} in last 5 min"

            if trigger:
                _last_print_scan_time[ticker] = now_ts
                sev = 8 if any(p["notional"] >= 1_000_000 for p in large_prints) else 7
                insert_signal(
                    ticker,
                    "technical",
                    sev,
                    f"{ticker} unusual print cluster detected",
                    reason,
                    {"source": "tape_reading", "prints": large_prints[:5], "window_minutes": 5},
                )
                fired += 1
                log.info(f"Unusual print detected: {ticker} — {reason}")

        except Exception as e:
            log.debug(f"Print scan failed for {ticker}: {e}")
        await asyncio.sleep(0.2)  # ~5 req/sec

    return fired


async def run_once() -> dict:
    if not POLYGON_KEY:
        return {"status": "skipped", "reason": "POLYGON_API_KEY not set"}

    all_tickers = get_watchlist_tickers()
    if not all_tickers:
        return {"status": "skipped", "reason": "no tickers in watchlist or portfolio"}

    # Portfolio tickers processed first — always up to date
    portfolio_tickers = get_portfolio_tickers()
    portfolio_set = set(portfolio_tickers)
    remaining = [t for t in all_tickers if t not in portfolio_set]
    ordered_tickers = portfolio_tickers + remaining

    processed = 0
    unusual_print_signals = 0
    async with httpx.AsyncClient() as client:
        for i in range(0, len(ordered_tickers), 10):
            batch = ordered_tickers[i:i+10]
            await asyncio.gather(*[process_ticker(client, t) for t in batch], return_exceptions=True)
            processed += len(batch)
            if i + 10 < len(ordered_tickers):
                await asyncio.sleep(2)

        # #30 — Intraday tape reading: scan for unusual print clusters during market hours
        try:
            from market_hours import is_market_hours
            if is_market_hours():
                unusual_print_signals = await scan_unusual_prints(client, ordered_tickers)
        except Exception as e:
            log.debug(f"Unusual print scan failed: {e}")

    return {"status": "ok", "processed": processed, "portfolio_first": portfolio_tickers, "unusual_prints": unusual_print_signals}


async def run_portfolio_only() -> dict:
    """Fetch only portfolio tickers — runs outside market hours too."""
    if not POLYGON_KEY:
        return {"status": "skipped", "reason": "no api key"}
    tickers = get_portfolio_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no portfolio tickers"}
    async with httpx.AsyncClient() as client:
        for t in tickers:
            await process_ticker(client, t)
            await asyncio.sleep(1)
    return {"status": "ok", "portfolio": tickers}


async def main_loop():
    """Background loop — full scan during market hours, portfolio-only outside."""
    log.info("Price worker started")
    # Always run once at startup so portfolio shows real prices immediately
    try:
        result = await run_once()
        log.info(f"Price startup tick: {result}")
    except Exception as e:
        log.error(f"Price startup error: {e}")

    while True:
        await asyncio.sleep(300)  # 5 min
        try:
            if is_extended_hours():
                result = await run_once()
                log.info(f"Price tick: {result}")
            else:
                # Outside market hours: still update portfolio every 30 min
                result = await run_portfolio_only()
                log.debug(f"Price off-hours portfolio tick: {result}")
        except Exception as e:
            log.error(f"Price loop error: {e}")
