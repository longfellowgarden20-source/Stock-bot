"""
Dark Pool Worker — institutional block trades executed off-exchange.

Source: Unusual Whales /api/darkpool/{ticker} endpoint.
Large dark pool prints are where institutions accumulate/distribute without
tipping their hand on lit exchanges.

Signals:
- dark_pool: any single print > $1M
- dark_pool_cluster: multiple prints within 30 min totaling > $5M
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone, timedelta
from db import get_watchlist_tickers, insert_signal

log = logging.getLogger("darkpool_worker")

UW_KEY = os.environ.get("UNUSUAL_WHALES_API_KEY", "")
UW_BASE = "https://api.unusualwhales.com/api"

_seen: dict[str, float] = {}
_SEEN_TTL = 7200


def _evict():
    now = datetime.now(timezone.utc).timestamp()
    stale = [k for k, ts in _seen.items() if now - ts > _SEEN_TTL]
    for k in stale:
        del _seen[k]


async def fetch_darkpool_for_ticker(client: httpx.AsyncClient, ticker: str) -> list[dict]:
    if not UW_KEY:
        return []
    try:
        r = await client.get(
            f"{UW_BASE}/darkpool/{ticker.upper()}",
            headers={"Authorization": f"Bearer {UW_KEY}"},
            params={"limit": 50},
            timeout=15,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        return data.get("data", data) if isinstance(data, dict) else data
    except Exception as e:
        log.error(f"Darkpool fetch failed for {ticker}: {e}")
        return []


def process_prints(ticker: str, prints: list[dict]) -> None:
    _evict()
    cluster_size = 0.0
    cluster_count = 0
    cluster_window_start = datetime.now(timezone.utc) - timedelta(minutes=30)

    for p in prints:
        size = float(p.get("size", p.get("volume", 0)) or 0)
        price = float(p.get("price", 0) or 0)
        notional = size * price
        if notional <= 0:
            continue

        tracking_id = p.get("tracking_id", p.get("id", f"{ticker}-{p.get('executed_at', '')}-{notional}"))
        dedup_key = f"dp-{ticker}-{tracking_id}"
        if dedup_key in _seen:
            continue
        _seen[dedup_key] = datetime.now(timezone.utc).timestamp()

        # Check timestamp for cluster window
        executed_at = p.get("executed_at", p.get("timestamp", ""))
        try:
            ts = datetime.fromisoformat(str(executed_at).replace("Z", "+00:00")) if executed_at else None
            if ts and ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts and ts >= cluster_window_start:
                cluster_size += notional
                cluster_count += 1
        except (ValueError, TypeError):
            pass

        # Single large print signal — >$1M
        if notional >= 1_000_000:
            sev = 6
            if notional >= 10_000_000:
                sev = 9
            elif notional >= 5_000_000:
                sev = 8
            elif notional >= 2_500_000:
                sev = 7

            notional_fmt = f"${notional/1_000_000:.2f}M" if notional >= 1_000_000 else f"${notional/1_000:.0f}K"
            size_fmt = f"{int(size):,}"
            insert_signal(
                ticker, "dark_pool", sev,
                f"{ticker} dark pool {notional_fmt} block",
                f"Block trade: {size_fmt} shares @ ${price:.2f} = {notional_fmt} executed off-exchange. Institutions hide accumulation/distribution here.",
                {"size": size, "price": price, "notional": notional, "executed_at": str(executed_at)},
            )

    # Cluster signal — multiple prints in 30 min window > $5M total
    cluster_key = f"dp-cluster-{ticker}"
    if cluster_size >= 5_000_000 and cluster_count >= 3 and cluster_key not in _seen:
        _seen[cluster_key] = datetime.now(timezone.utc).timestamp()
        cluster_fmt = f"${cluster_size/1_000_000:.2f}M"
        insert_signal(
            ticker, "dark_pool", 8,
            f"{ticker} dark pool cluster — {cluster_fmt} in 30 min",
            f"{cluster_count} dark pool blocks totaling {cluster_fmt} executed in the last 30 minutes. Heavy institutional activity — direction visible only in aggregate flow.",
            {"cluster_notional": cluster_size, "print_count": cluster_count},
        )


async def run_once() -> dict:
    if not UW_KEY:
        return {"status": "skipped", "reason": "UNUSUAL_WHALES_API_KEY not set"}
    tickers = get_watchlist_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no tickers"}

    async with httpx.AsyncClient() as client:
        for ticker in tickers:
            try:
                prints = await fetch_darkpool_for_ticker(client, ticker)
                if prints:
                    process_prints(ticker, prints)
            except Exception as e:
                log.error(f"Darkpool process failed for {ticker}: {e}")
            await asyncio.sleep(0.6)

    return {"status": "ok", "tickers": len(tickers)}


async def main_loop():
    log.info("Dark pool worker started")
    while True:
        try:
            from market_hours import is_market_hours
            if is_market_hours():
                result = await run_once()
                log.info(f"Darkpool tick: {result}")
            else:
                log.debug("Outside market hours, skipping darkpool")
        except Exception as e:
            log.error(f"Darkpool loop error: {e}")
        await asyncio.sleep(600)  # 10 min during market hours
