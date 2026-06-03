"""
Reddit sentiment worker — tracks mention velocity on watched tickers across stock subs.
If mentions spike 3x+ over normal → emit sentiment_spike signal.
"""
import os
import logging
import httpx
import asyncio
import base64
import re
from db import get_watchlist_tickers, insert_signal, supabase

log = logging.getLogger("reddit_worker")

REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID", "")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET", "")
REDDIT_USER_AGENT = os.environ.get("REDDIT_USER_AGENT", "StockBot/1.0")

SUBREDDITS = ["wallstreetbets", "stocks", "investing", "options", "smallstreetbets"]

_token: str | None = None
_token_expiry: float = 0


async def get_token(client: httpx.AsyncClient) -> str | None:
    global _token, _token_expiry
    import time
    if _token and time.time() < _token_expiry - 60:
        return _token
    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET:
        return None
    auth = base64.b64encode(f"{REDDIT_CLIENT_ID}:{REDDIT_CLIENT_SECRET}".encode()).decode()
    try:
        r = await client.post(
            "https://www.reddit.com/api/v1/access_token",
            headers={"Authorization": f"Basic {auth}", "User-Agent": REDDIT_USER_AGENT},
            data={"grant_type": "client_credentials"},
            timeout=10,
        )
        if r.status_code != 200:
            log.warning(f"reddit auth status {r.status_code}: {r.text[:120]}")
            return None
        data = r.json()
        _token = data["access_token"]
        _token_expiry = time.time() + int(data.get("expires_in", 3600))
        return _token
    except Exception as e:
        log.error(f"reddit token error: {e}")
        return None


async def fetch_subreddit_posts(client: httpx.AsyncClient, token: str, sub: str, limit: int = 100) -> list[dict]:
    try:
        r = await client.get(
            f"https://oauth.reddit.com/r/{sub}/new",
            headers={"Authorization": f"Bearer {token}", "User-Agent": REDDIT_USER_AGENT},
            params={"limit": limit},
            timeout=15,
        )
        if r.status_code != 200:
            return []
        return [c["data"] for c in r.json().get("data", {}).get("children", []) if c.get("kind") == "t3"]
    except Exception as e:
        log.error(f"sub fetch error {sub}: {e}")
        return []


def count_ticker_mentions(posts: list[dict], ticker: str) -> int:
    """Count posts mentioning the ticker as $TICKER or whole-word TICKER."""
    if not ticker:
        return 0
    pattern = re.compile(rf"(?:\$|\b){ticker.upper()}\b", re.IGNORECASE)
    count = 0
    for p in posts:
        text = f"{p.get('title', '')} {p.get('selftext', '')}"
        if pattern.search(text):
            count += 1
    return count


def get_baseline_mentions(ticker: str) -> float:
    """Average mentions/run for this ticker — to detect spikes."""
    # We'll store baseline in a simple way: look at last 5 sentiment_spike checks (we'll use snapshots-like table later)
    # For v1 — use a fixed baseline. Real impl would track rolling avg.
    return 2.0  # baseline assumption


async def run_once() -> dict:
    if not REDDIT_CLIENT_ID:
        return {"status": "skipped", "reason": "no reddit creds"}
    tickers = get_watchlist_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no tickers"}

    async with httpx.AsyncClient() as client:
        token = await get_token(client)
        if not token:
            return {"status": "skipped", "reason": "no reddit token"}

        all_posts: list[dict] = []
        for sub in SUBREDDITS:
            posts = await fetch_subreddit_posts(client, token, sub, 100)
            all_posts.extend(posts)
            await asyncio.sleep(1)  # respect rate limits

        results = {}
        for ticker in tickers:
            mentions = count_ticker_mentions(all_posts, ticker)
            baseline = get_baseline_mentions(ticker)
            if mentions >= max(5, baseline * 3):
                ratio = mentions / baseline if baseline > 0 else mentions
                sev = 7 if mentions >= 15 else 5
                insert_signal(
                    ticker,
                    "sentiment_spike",
                    sev,
                    f"{ticker} reddit mentions spiking",
                    f"Mentioned {mentions}x across r/wsb, r/stocks, r/investing in the last batch ({ratio:.1f}x baseline). Retail crowd is watching.",
                    {"mentions": mentions, "baseline": baseline, "ratio": ratio, "subreddits": SUBREDDITS},
                )
            results[ticker] = mentions
    return {"status": "ok", "mentions": results}


async def main_loop():
    log.info("Reddit worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Reddit tick: {result}")
        except Exception as e:
            log.error(f"Reddit loop error: {e}")
        await asyncio.sleep(1800)  # 30 min
