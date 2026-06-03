"""Supabase client wrapper for all workers."""
import os
from supabase import create_client, Client
from typing import Any, Optional

_client: Optional[Client] = None


def supabase() -> Client:
    global _client
    if _client is None:
        url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client


def get_watchlist_tickers() -> list[str]:
    """Returns all tickers from watchlist + portfolio combined."""
    db = supabase()
    watch = db.table("watchlist").select("ticker").execute()
    port = db.table("portfolio").select("ticker").execute()
    tickers = set()
    for row in (watch.data or []):
        tickers.add(row["ticker"].upper())
    for row in (port.data or []):
        tickers.add(row["ticker"].upper())
    return sorted(tickers)


def insert_signal(
    ticker: str,
    signal_type: str,
    severity: int,
    title: str,
    body: str,
    raw_data: dict[str, Any] | None = None,
) -> None:
    """Insert a new signal — triggers realtime update on dashboard."""
    supabase().table("signals").insert({
        "ticker": ticker.upper(),
        "signal_type": signal_type,
        "severity": max(1, min(10, severity)),
        "title": title[:200],
        "body": body[:1000],
        "raw_data": raw_data,
        "read": False,
    }).execute()


def insert_snapshot(ticker: str, price: float, volume: int | None, change_pct: float | None) -> None:
    supabase().table("snapshots").insert({
        "ticker": ticker.upper(),
        "price": price,
        "volume": volume,
        "change_pct": change_pct,
    }).execute()


def insert_news(ticker: str, headline: str, source: str, url: str, sentiment: str | None, published_at: str | None) -> bool:
    """Dedup-aware news insert — returns True if a new row was created."""
    db = supabase()
    existing = db.table("news").select("id").eq("ticker", ticker.upper()).eq("url", url).limit(1).execute()
    if existing.data:
        return False
    db.table("news").insert({
        "ticker": ticker.upper(),
        "headline": headline[:300],
        "source": source,
        "url": url,
        "sentiment": sentiment,
        "published_at": published_at,
    }).execute()
    return True


def recent_signals_for_ticker(ticker: str, minutes: int = 30) -> list[dict]:
    """Used by signal engine to detect convergence."""
    from datetime import datetime, timedelta, timezone
    since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
    res = supabase().table("signals").select("*").eq("ticker", ticker.upper()).gte("created_at", since).execute()
    return res.data or []
