"""Supabase client wrapper for all workers."""
import os
import logging
import threading
import httpx
from supabase import create_client, Client
from typing import Any, Optional

log = logging.getLogger("db")

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


# Push notification trigger — only fires for severity >= 8
_PUSH_MIN_SEVERITY = 8


def _send_push_request(signal_row: dict) -> None:
    notify_url = os.environ.get("NEXT_PUBLIC_APP_URL")
    token = os.environ.get("PUSH_NOTIFY_TOKEN")
    if not notify_url or not token:
        return
    try:
        with httpx.Client(timeout=5) as client:
            client.post(
                f"{notify_url.rstrip('/')}/api/push/notify",
                headers={"X-Push-Token": token, "Content-Type": "application/json"},
                json={
                    "signal_id": signal_row.get("id"),
                    "ticker": signal_row.get("ticker"),
                    "signal_type": signal_row.get("signal_type"),
                    "severity": signal_row.get("severity"),
                    "title": signal_row.get("title"),
                    "body": signal_row.get("body"),
                },
            )
    except Exception as e:
        log.debug(f"Push notify failed (non-fatal): {e}")


def _notify_push(signal_row: dict) -> None:
    """Fire-and-forget push notification — runs in a daemon thread to avoid blocking the event loop."""
    if signal_row.get("severity", 0) < _PUSH_MIN_SEVERITY:
        return
    threading.Thread(target=_send_push_request, args=(signal_row,), daemon=True).start()


def insert_signal(
    ticker: str,
    signal_type: str,
    severity: int,
    title: str,
    body: str,
    raw_data: dict[str, Any] | None = None,
) -> None:
    """Insert a new signal — triggers realtime update on dashboard + push if severity high."""
    sev = max(1, min(10, severity))
    payload = {
        "ticker": ticker.upper(),
        "signal_type": signal_type,
        "severity": sev,
        "title": title[:200],
        "body": body[:1000],
        "raw_data": raw_data,
        "read": False,
    }
    try:
        res = supabase().table("signals").insert(payload).execute()
        if res.data:
            _notify_push(res.data[0])
    except Exception as e:
        log.error(f"insert_signal failed for {ticker}/{signal_type}: {e}")


def insert_snapshot(ticker: str, price: float, volume: int | None, change_pct: float | None) -> None:
    try:
        supabase().table("snapshots").insert({
            "ticker": ticker.upper(),
            "price": price,
            "volume": volume,
            "change_pct": change_pct,
        }).execute()
    except Exception as e:
        log.debug(f"insert_snapshot failed for {ticker}: {e}")


def insert_news(ticker: str, headline: str, source: str, url: str, sentiment: str | None, published_at: str | None) -> bool:
    """Dedup-aware news insert — returns True if a new row was created."""
    db = supabase()
    try:
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
    except Exception as e:
        log.error(f"insert_news failed for {ticker}: {e}")
        return False


def recent_signals_for_ticker(ticker: str, minutes: int = 30) -> list[dict]:
    """Used by signal engine to detect convergence."""
    from datetime import datetime, timedelta, timezone
    since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
    res = supabase().table("signals").select("*").eq("ticker", ticker.upper()).gte("created_at", since).execute()
    return res.data or []
