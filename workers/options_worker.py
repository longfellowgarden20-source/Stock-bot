"""
Options Flow Worker — tracks unusual options activity via Unusual Whales API.

Strategy:
- Every 5 min during extended hours, fetch recent unusual options flow
- Filter for: sweeps (aggressive directional bets), size > $100k premium
- Detect put/call imbalance per ticker within a rolling window
- Emit signals: options_unusual (single large sweep), options_skew (heavy one-sided flow)
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone, timedelta
from db import supabase, get_watchlist_tickers, insert_signal
from market_hours import is_extended_hours

log = logging.getLogger("options_worker")

UW_KEY = os.environ.get("UNUSUAL_WHALES_API_KEY", "")
UW_BASE = "https://api.unusualwhales.com/api"

# Dedup cache — (ticker, contract) seen in last 2h
_seen: dict[str, float] = {}
_SEEN_TTL = 7200


def _evict_seen():
    now = datetime.now(timezone.utc).timestamp()
    stale = [k for k, ts in _seen.items() if now - ts > _SEEN_TTL]
    for k in stale:
        del _seen[k]


async def fetch_flow(client: httpx.AsyncClient) -> list[dict]:
    """Fetch recent unusual options flow — last 15 min of activity."""
    if not UW_KEY:
        return []
    try:
        r = await client.get(
            f"{UW_BASE}/option-trades/flow-alerts",
            headers={"Authorization": f"Bearer {UW_KEY}"},
            params={"limit": 100, "order": "desc"},
            timeout=15,
        )
        if r.status_code != 200:
            log.warning(f"UW flow status {r.status_code}: {r.text[:200]}")
            return []
        data = r.json()
        return data.get("data", data) if isinstance(data, dict) else data
    except Exception as e:
        log.error(f"UW flow fetch failed: {e}")
        return []


async def fetch_ticker_flow(client: httpx.AsyncClient, ticker: str) -> list[dict]:
    """Ticker-specific flow — only called for watchlist/portfolio tickers."""
    if not UW_KEY:
        return []
    try:
        r = await client.get(
            f"{UW_BASE}/stock/{ticker}/option-trades",
            headers={"Authorization": f"Bearer {UW_KEY}"},
            params={"limit": 50},
            timeout=15,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        return data.get("data", data) if isinstance(data, dict) else data
    except Exception as e:
        log.error(f"UW ticker flow failed for {ticker}: {e}")
        return []


def parse_premium(val) -> float:
    """Parse premium string like '$1.2M', '$450K', or raw float."""
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).replace("$", "").replace(",", "").strip().upper()
    try:
        if s.endswith("M"):
            return float(s[:-1]) * 1_000_000
        if s.endswith("K"):
            return float(s[:-1]) * 1_000
        return float(s)
    except ValueError:
        return 0.0


def classify_aggression(trade: dict) -> str:
    """Determine if trade is sweep, block, or normal."""
    execution = str(trade.get("execution_estimate", "") or trade.get("trade_type", "")).lower()
    if "sweep" in execution:
        return "sweep"
    if "block" in execution or "golden" in execution:
        return "block"
    return "normal"


def process_flow(trades: list[dict], watched: set[str]) -> None:
    """Scan all trades, emit signals for large/unusual ones on watched tickers."""
    _evict_seen()

    # Group by ticker first — detect skew
    ticker_calls: dict[str, float] = {}
    ticker_puts: dict[str, float] = {}

    for trade in trades:
        ticker = str(trade.get("ticker", trade.get("symbol", "")) or "").upper()
        if not ticker or (watched and ticker not in watched):
            continue

        side = str(trade.get("put_call", trade.get("type", "")) or "").upper()
        premium = parse_premium(trade.get("premium", trade.get("cost_basis", 0)))
        contract = trade.get("contract", trade.get("id", f"{ticker}-{premium}"))
        dedup_key = f"{ticker}-{contract}"

        if dedup_key in _seen:
            continue

        aggression = classify_aggression(trade)
        strike = trade.get("strike_price", trade.get("strike", "?"))
        expiry = trade.get("expiry", trade.get("expiration_date", "?"))
        size = trade.get("size", trade.get("volume", trade.get("contracts", "?")))
        spot = trade.get("underlying_price", trade.get("spot_price"))

        # Accumulate call/put premium for skew analysis
        if "C" in side or "CALL" in side:
            ticker_calls[ticker] = ticker_calls.get(ticker, 0) + premium
        elif "P" in side or "PUT" in side:
            ticker_puts[ticker] = ticker_puts.get(ticker, 0) + premium

        # Large single trade signal (>$50k) or sweeps (>$25k)
        min_prem = 25_000 if aggression == "sweep" else 50_000
        if premium >= min_prem:
            _seen[dedup_key] = datetime.now(timezone.utc).timestamp()

            direction = "CALL" if ("C" in side or "CALL" in side) else "PUT" if ("P" in side or "PUT" in side) else side
            prem_fmt = f"${premium/1_000_000:.2f}M" if premium >= 1_000_000 else f"${premium/1_000:.0f}K"

            sev_base = 6
            if premium >= 1_000_000:
                sev_base = 9
            elif premium >= 500_000:
                sev_base = 8
            elif premium >= 100_000:
                sev_base = 7
            if aggression == "sweep":
                sev_base = min(10, sev_base + 1)

            body_parts = [f"{aggression.title()} — {direction} ${strike} exp {expiry}"]
            if size:
                body_parts.append(f"{size} contracts")
            body_parts.append(f"{prem_fmt} premium")
            if spot:
                body_parts.append(f"spot ${float(spot):.2f}")

            insert_signal(
                ticker,
                "options_unusual",
                sev_base,
                f"{ticker} large {direction.lower()} {aggression} — {prem_fmt}",
                ". ".join(body_parts) + ".",
                {
                    "premium": premium,
                    "direction": direction,
                    "aggression": aggression,
                    "strike": strike,
                    "expiry": str(expiry),
                    "size": size,
                    "spot": spot,
                },
            )

    # Skew signal — one side is 3x the other with at least $200k total
    for ticker in set(list(ticker_calls.keys()) + list(ticker_puts.keys())):
        calls = ticker_calls.get(ticker, 0)
        puts = ticker_puts.get(ticker, 0)
        total = calls + puts
        if total < 200_000:
            continue
        skew_key = f"{ticker}-skew"
        if skew_key in _seen:
            continue
        if calls > 0 and puts > 0:
            ratio = max(calls, puts) / min(calls, puts)
            if ratio >= 3:
                dominant = "call" if calls > puts else "put"
                pct = (max(calls, puts) / total) * 100
                _seen[skew_key] = datetime.now(timezone.utc).timestamp()
                total_fmt = f"${total/1_000_000:.2f}M" if total >= 1_000_000 else f"${total/1_000:.0f}K"
                insert_signal(
                    ticker,
                    "options_unusual",
                    7,
                    f"{ticker} heavy {dominant} flow — {pct:.0f}% skew",
                    f"{pct:.0f}% of {total_fmt} options premium flowing into {dominant}s. Ratio {ratio:.1f}:1 vs opposite side.",
                    {"calls": calls, "puts": puts, "ratio": ratio, "dominant": dominant, "total": total},
                )


async def run_once() -> dict:
    if not UW_KEY:
        return {"status": "skipped", "reason": "UNUSUAL_WHALES_API_KEY not set"}

    tickers = get_watchlist_tickers()
    watched = set(tickers)

    async with httpx.AsyncClient() as client:
        # Fetch broad flow feed — filter to watched tickers client-side
        trades = await fetch_flow(client)

        if trades:
            process_flow(trades, watched)
        elif watched:
            # Fallback: query each watched ticker individually (slower but works)
            for ticker in tickers[:20]:  # cap at 20 to avoid hammering
                ticker_trades = await fetch_ticker_flow(client, ticker)
                if ticker_trades:
                    process_flow(ticker_trades, {ticker})
                await asyncio.sleep(0.5)

    return {"status": "ok", "trades_seen": len(trades), "tickers_watched": len(watched)}


async def main_loop():
    log.info("Options flow worker started")
    while True:
        try:
            if is_extended_hours():
                result = await run_once()
                log.info(f"Options tick: {result}")
            else:
                log.debug("Outside market hours, skipping")
        except Exception as e:
            log.error(f"Options loop error: {e}")
        await asyncio.sleep(300)  # 5 min
