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


def _insert_to_dlq(
    ticker: str,
    signal_type: str,
    severity: int,
    title: str,
    body: str,
    raw_data: dict[str, Any] | None,
    error_message: str,
) -> None:
    """Write a failed signal to the dead-letter queue."""
    try:
        supabase().table("failed_signals").insert({
            "ticker": ticker.upper(),
            "signal_type": signal_type,
            "severity": severity,
            "title": title[:200],
            "body": body[:1000],
            "raw_data": raw_data,
            "error_message": str(error_message)[:500],
            "retry_count": 0,
            "resolved": False,
        }).execute()
    except Exception as dlq_err:
        log.error(f"DLQ insert also failed for {ticker}/{signal_type}: {dlq_err}")


def insert_signal(
    ticker: str,
    signal_type: str,
    severity: float,
    title: str,
    body: str,
    raw_data: dict[str, Any] | None = None,
) -> None:
    """Insert a new signal — triggers realtime update on dashboard + push if severity high.
    On failure, writes to dead-letter queue instead of raising."""
    sev = round(max(1.0, min(10.0, float(severity))), 1)
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
        log.error(f"insert_signal failed for {ticker}/{signal_type}: {e} — writing to DLQ")
        _insert_to_dlq(ticker, signal_type, sev, title, body, raw_data, str(e))


def insert_snapshot(ticker: str, price: float, volume: int | None, change_pct: float | None) -> None:
    """#7: Insert snapshot with data_freshness = NOW() to track last successful price update."""
    try:
        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).isoformat()
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


def retry_failed_signals() -> int:
    """Retry up to 20 unresolved DLQ entries. Returns count of resolved signals."""
    from datetime import datetime, timezone
    db = supabase()
    try:
        rows = (
            db.table("failed_signals")
            .select("*")
            .eq("resolved", False)
            .lt("retry_count", 5)
            .order("created_at")
            .limit(20)
            .execute()
        )
    except Exception as e:
        log.error(f"DLQ fetch failed: {e}")
        return 0

    resolved_count = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for row in (rows.data or []):
        row_id = row["id"]
        sev = round(max(1.0, min(10.0, float(row.get("severity", 5)))), 1)
        payload = {
            "ticker": (row.get("ticker") or "UNKNOWN").upper(),
            "signal_type": row.get("signal_type", "convergence"),
            "severity": sev,
            "title": (row.get("title") or "")[:200],
            "body": (row.get("body") or "")[:1000],
            "raw_data": row.get("raw_data"),
            "read": False,
        }
        try:
            res = db.table("signals").insert(payload).execute()
            if res.data:
                _notify_push(res.data[0])
            db.table("failed_signals").update({"resolved": True, "last_retry_at": now_iso}).eq("id", row_id).execute()
            resolved_count += 1
            log.info(f"DLQ resolved: {payload['ticker']}/{payload['signal_type']} (id={row_id})")
        except Exception as e:
            log.warning(f"DLQ retry failed for {row_id}: {e}")
            try:
                db.table("failed_signals").update({
                    "retry_count": row.get("retry_count", 0) + 1,
                    "last_retry_at": now_iso,
                }).eq("id", row_id).execute()
            except Exception as upd_e:
                log.error(f"DLQ retry_count update failed for {row_id}: {upd_e}")

    return resolved_count


def recent_signals_for_ticker(ticker: str, minutes: int = 30) -> list[dict]:
    """Used by signal engine to detect convergence."""
    from datetime import datetime, timedelta, timezone
    since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
    res = supabase().table("signals").select("*").eq("ticker", ticker.upper()).gte("created_at", since).execute()
    return res.data or []


def get_data_freshness(ticker: str) -> dict | None:
    """#7: Get latest snapshot freshness for a ticker. Returns {age_minutes, is_stale, last_update}."""
    from datetime import datetime, timezone
    try:
        res = supabase().table("snapshots").select("data_freshness").eq("ticker", ticker.upper()).order("data_freshness", desc=True).limit(1).execute()
        if not res.data:
            return None
        last_update = res.data[0].get("data_freshness")
        if not last_update:
            return None
        last_dt = datetime.fromisoformat(last_update.replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        age_seconds = (now - last_dt).total_seconds()
        age_minutes = age_seconds / 60
        return {
            "last_update": last_update,
            "age_minutes": round(age_minutes, 1),
            "is_stale_10min": age_minutes > 10,
            "is_stale_1hr": age_minutes > 60,
        }
    except Exception as e:
        log.debug(f"get_data_freshness failed for {ticker}: {e}")
        return None
