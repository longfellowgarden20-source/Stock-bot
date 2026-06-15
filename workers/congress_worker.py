"""
Congressional Trades Worker — tracks senator/rep stock trades via Quiver Quantitative.

Quiver provides clean congressional trade data from STOCK Act disclosures.
Requires QUIVER_API_KEY env var (free tier available at quiverquant.com).
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone, timedelta
from db import supabase, get_watchlist_tickers, insert_signal

log = logging.getLogger("congress_worker")

QUIVER_KEY = os.environ.get("QUIVER_API_KEY", "")
QUIVER_BASE = "https://api.quiverquant.com/beta"

_seen: set[str] = set()


async def fetch_recent_trades(client: httpx.AsyncClient) -> list[dict]:
    """Fetch most recent congressional trades from Quiver Quantitative."""
    if not QUIVER_KEY:
        log.warning("QUIVER_API_KEY not set — congress worker skipped")
        return []
    try:
        r = await client.get(
            f"{QUIVER_BASE}/live/congresstrading",
            headers={"Authorization": f"Token {QUIVER_KEY}", "Accept": "application/json"},
            timeout=20,
        )
        if r.status_code == 401:
            log.warning("Quiver API key unauthorized — check QUIVER_API_KEY")
            return []
        if r.status_code != 200:
            log.warning(f"Quiver congress status {r.status_code}: {r.text[:200]}")
            return []
        data = r.json()
        return data if isinstance(data, list) else data.get("data", [])
    except Exception as e:
        log.error(f"Quiver congress fetch failed: {e}")
        return []


async def fetch_ticker_trades(client: httpx.AsyncClient, ticker: str) -> list[dict]:
    """Fetch trades for a specific ticker from Quiver."""
    if not QUIVER_KEY:
        return []
    try:
        r = await client.get(
            f"{QUIVER_BASE}/historical/congresstrading/{ticker.upper()}",
            headers={"Authorization": f"Token {QUIVER_KEY}", "Accept": "application/json"},
            timeout=15,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        return data if isinstance(data, list) else data.get("data", [])
    except Exception as e:
        log.error(f"Quiver ticker fetch failed for {ticker}: {e}")
        return []


def parse_trade_amount(amount_str: str | None) -> tuple[str, float]:
    """Parse amount range like '$1,001 - $15,000' → label + midpoint."""
    if not amount_str:
        return ("unknown", 0)
    ranges = {
        "$1,001 - $15,000": ("$1K–$15K", 8_000),
        "$15,001 - $50,000": ("$15K–$50K", 32_500),
        "$50,001 - $100,000": ("$50K–$100K", 75_000),
        "$100,001 - $250,000": ("$100K–$250K", 175_000),
        "$250,001 - $500,000": ("$250K–$500K", 375_000),
        "$500,001 - $1,000,000": ("$500K–$1M", 750_000),
        "$1,000,001 - $5,000,000": ("$1M–$5M", 3_000_000),
        "Over $5,000,000": ("$5M+", 5_000_000),
    }
    for key, (label, mid) in ranges.items():
        if key.lower() in str(amount_str).lower():
            return (label, mid)
    # Quiver sometimes gives numeric ranges like "1001-15000"
    try:
        clean = str(amount_str).replace("$", "").replace(",", "").strip()
        if "-" in clean:
            parts = clean.split("-")
            lo, hi = float(parts[0].strip()), float(parts[1].strip())
            mid = (lo + hi) / 2
            if mid >= 1_000_000:
                return (f"${mid/1_000_000:.1f}M", mid)
            elif mid >= 1000:
                return (f"${mid/1000:.0f}K", mid)
            return (str(amount_str)[:30], mid)
    except Exception:
        pass
    return (str(amount_str)[:30], 0)


def normalize_quiver_trade(raw: dict) -> dict:
    """Normalize Quiver Quantitative response fields to internal format."""
    ticker = str(raw.get("Ticker") or raw.get("ticker") or "").upper()
    rep = raw.get("Representative") or raw.get("representative") or "Unknown"
    party = raw.get("Party") or raw.get("party") or ""
    tx_type = str(raw.get("Transaction") or raw.get("transaction") or "").lower()
    tx_date = raw.get("TransactionDate") or raw.get("Date") or raw.get("date") or ""
    amount = raw.get("Range") or raw.get("Amount") or raw.get("amount") or ""
    chamber = raw.get("Chamber") or raw.get("chamber") or ""
    state = raw.get("State") or raw.get("state") or ""

    return {
        "Ticker": ticker,
        "Representative": rep,
        "Party": party,
        "State": state,
        "Chamber": chamber,
        "Transaction": tx_type,
        "TransactionDate": str(tx_date)[:10] if tx_date else "",
        "Amount": amount,
    }


def process_trades(trades: list[dict], watched: set[str]) -> int:
    """Emit congress_trade signals. Returns count of new signals."""
    count = 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=45)

    for raw in trades:
        trade = normalize_quiver_trade(raw)

        ticker = trade["Ticker"]
        if not ticker:
            continue
        if watched and ticker not in watched:
            continue

        tx_date = trade["TransactionDate"]
        rep = trade["Representative"]
        tx_type = trade["Transaction"]
        amount_raw = trade["Amount"]
        party = trade["Party"]
        state = trade["State"]
        chamber = trade["Chamber"]

        if tx_date:
            try:
                tx_dt = datetime.fromisoformat(str(tx_date).replace("Z", "+00:00"))
                if tx_dt.tzinfo is None:
                    tx_dt = tx_dt.replace(tzinfo=timezone.utc)
                if tx_dt < cutoff:
                    continue
            except (ValueError, TypeError):
                pass

        dedup_key = f"{ticker}-{rep}-{tx_date}-{tx_type}-{amount_raw}"
        if dedup_key in _seen:
            continue

        try:
            existing = supabase().table("signals").select("id").eq("ticker", ticker).eq("signal_type", "congress_trade").contains("raw_data", {"representative": rep, "transaction_date": str(tx_date)}).limit(1).execute()
            if existing.data:
                _seen.add(dedup_key)
                continue
        except Exception:
            pass

        _seen.add(dedup_key)

        is_buy = "purchase" in tx_type or "buy" in tx_type
        is_sell = "sale" in tx_type or "sell" in tx_type
        if not (is_buy or is_sell):
            continue

        amount_label, amount_mid = parse_trade_amount(str(amount_raw))

        sev = 5
        if amount_mid >= 1_000_000:
            sev = 8
        elif amount_mid >= 500_000:
            sev = 7
        elif amount_mid >= 100_000:
            sev = 6

        direction = "BOUGHT" if is_buy else "SOLD"
        party_str = f" ({party}-{state})" if party and state else (f" ({state})" if state else "")
        chamber_str = f" [{chamber}]" if chamber else ""

        title = f"{ticker} — {rep}{party_str} {direction} {amount_label}"
        body = (
            f"{rep}{party_str}{chamber_str} disclosed a {tx_type} of {ticker} worth {amount_label}. "
            f"Transaction date: {tx_date}. "
            f"Congressional trades often precede legislation that affects the underlying company."
        )

        insert_signal(
            ticker,
            "congress_trade",
            sev,
            title,
            body,
            {
                "representative": rep,
                "party": party,
                "state": state,
                "chamber": chamber,
                "transaction": tx_type,
                "amount": amount_raw,
                "amount_mid": amount_mid,
                "transaction_date": str(tx_date),
            },
        )
        count += 1

    return count


async def run_once() -> dict:
    if not QUIVER_KEY:
        return {"status": "skipped", "reason": "QUIVER_API_KEY not set"}

    tickers = get_watchlist_tickers()
    watched = set(tickers)

    async with httpx.AsyncClient() as client:
        trades = await fetch_recent_trades(client)
        count = process_trades(trades, watched)

        # Per-ticker fallback for watched tickers not in the broad feed
        watched_hits = {normalize_quiver_trade(t)["Ticker"] for t in trades} & watched
        missing = watched - watched_hits
        if missing:
            log.info(f"Querying Quiver per-ticker for: {missing}")
            for ticker in list(missing)[:15]:
                ticker_trades = await fetch_ticker_trades(client, ticker)
                if ticker_trades:
                    count += process_trades(ticker_trades, {ticker})
                await asyncio.sleep(1)

    return {"status": "ok", "new_signals": count, "trades_fetched": len(trades)}


async def main_loop():
    log.info("Congress trade worker started (Quiver Quantitative)")
    while True:
        try:
            result = await run_once()
            log.info(f"Congress tick: {result}")
        except Exception as e:
            log.error(f"Congress loop error: {e}")
        await asyncio.sleep(6 * 3600)  # 6h
