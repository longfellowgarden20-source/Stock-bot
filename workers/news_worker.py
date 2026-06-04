"""
News worker — polls NewsAPI + Polygon news for breaking headlines on watched tickers.
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone
from db import get_watchlist_tickers, insert_news, insert_signal

log = logging.getLogger("news_worker")

NEWS_API_KEY = os.environ.get("NEWS_API_KEY", "")
POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")

# Keywords that raise severity
_EARNINGS_KW = ["earnings", "revenue", "guidance", "eps", "profit", "loss", "quarterly", "annual results"]
_CATALYST_KW = ["fda", "merger", "acquisition", "buyout", "takeover", "deal", "agreement", "approved", "approval"]
_ANALYST_KW = ["upgrade", "downgrade", "price target", "initiated", "outperform", "underperform"]

# Sources that get a +0.5 credibility bonus
_PREMIUM_SOURCES = {"reuters", "bloomberg", "the wall street journal", "wsj", "financial times", "ft", "cnbc"}
# Sources that get a -0.5 press-release penalty
_PR_SOURCES = {"pr newswire", "globe newswire", "globenewswire", "business wire", "businesswire"}


def _is_premarket_et() -> bool:
    """True if current UTC time falls in 4:00–9:30 AM Eastern."""
    try:
        import zoneinfo
        et = datetime.now(zoneinfo.ZoneInfo("America/New_York"))
    except Exception:
        # Fallback: UTC-4 (EDT) approximation
        et = datetime.now(timezone.utc).replace(tzinfo=None)
        et = et.replace(hour=(et.hour - 4) % 24)
    return (et.hour == 4 and et.minute >= 0) or (5 <= et.hour <= 8) or (et.hour == 9 and et.minute < 30)


def _score_news(headline: str, source: str, published_at: str | None = None) -> float:
    """Compute nuanced severity for a news signal. Returns a value in [4.0, 9.0]."""
    h = headline.lower()
    s = source.lower() if source else ""
    sev = 5.0

    # Earnings / revenue / guidance keywords
    if any(kw in h for kw in _EARNINGS_KW):
        sev += 1.0

    # High-impact catalyst keywords
    if any(kw in h for kw in _CATALYST_KW):
        sev += 1.0

    # Analyst action keywords
    if any(kw in h for kw in _ANALYST_KW):
        sev += 0.5

    # Source credibility
    if any(ps in s for ps in _PREMIUM_SOURCES):
        sev += 0.5
    elif any(ps in s for ps in _PR_SOURCES):
        sev -= 0.5

    # Pre-market timing bonus
    if _is_premarket_et():
        sev += 0.5

    return round(max(4.0, min(9.0, sev)), 1)


BULLISH_KEYWORDS = ["beats", "surge", "rally", "upgrade", "soars", "record", "wins", "approves", "announces partnership", "breakthrough", "expands"]
BEARISH_KEYWORDS = ["misses", "plunge", "downgrade", "drops", "investigation", "lawsuit", "recall", "warning", "cuts guidance", "delays", "fraud", "halts"]


def classify_sentiment(headline: str) -> str:
    h = headline.lower()
    bull = sum(1 for k in BULLISH_KEYWORDS if k in h)
    bear = sum(1 for k in BEARISH_KEYWORDS if k in h)
    if bull > bear:
        return "bullish"
    if bear > bull:
        return "bearish"
    return "neutral"


async def fetch_polygon_news(client: httpx.AsyncClient, ticker: str) -> list[dict]:
    if not POLYGON_KEY:
        return []
    try:
        r = await client.get(
            f"https://api.polygon.io/v2/reference/news",
            params={"ticker": ticker, "limit": 10, "apiKey": POLYGON_KEY},
            timeout=10,
        )
        if r.status_code != 200:
            return []
        return r.json().get("results", [])
    except Exception as e:
        log.error(f"polygon news fetch failed for {ticker}: {e}")
        return []


async def fetch_newsapi(client: httpx.AsyncClient, ticker: str, company_hint: str | None = None) -> list[dict]:
    if not NEWS_API_KEY:
        return []
    q = ticker if not company_hint else f'"{ticker}" OR "{company_hint}"'
    try:
        r = await client.get(
            "https://newsapi.org/v2/everything",
            params={"q": q, "sortBy": "publishedAt", "pageSize": 5, "language": "en", "apiKey": NEWS_API_KEY},
            timeout=10,
        )
        if r.status_code != 200:
            return []
        return r.json().get("articles", [])
    except Exception as e:
        log.error(f"newsapi fetch failed for {ticker}: {e}")
        return []


async def process_ticker(client: httpx.AsyncClient, ticker: str) -> int:
    """Returns count of new articles ingested."""
    new_count = 0

    polygon_items = await fetch_polygon_news(client, ticker)
    for item in polygon_items:
        headline = item.get("title", "")
        url = item.get("article_url", "")
        source = (item.get("publisher", {}) or {}).get("name", "")
        published_at = item.get("published_utc")
        if not headline or not url:
            continue
        sentiment = classify_sentiment(headline)
        if insert_news(ticker, headline, source, url, sentiment, published_at):
            new_count += 1
            if sentiment in ("bullish", "bearish"):
                sev = _score_news(headline, source, published_at)
                insert_signal(
                    ticker,
                    "news_breaking",
                    sev,
                    headline[:120],
                    f"{source}: {headline}",
                    {"url": url, "sentiment": sentiment, "source": source, "published_at": published_at},
                )

    # Fallback to NewsAPI if Polygon returned nothing
    if not polygon_items:
        articles = await fetch_newsapi(client, ticker)
        for a in articles:
            headline = a.get("title") or ""
            url = a.get("url") or ""
            source = (a.get("source") or {}).get("name", "")
            published_at = a.get("publishedAt")
            if not headline or not url:
                continue
            sentiment = classify_sentiment(headline)
            if insert_news(ticker, headline, source, url, sentiment, published_at):
                new_count += 1
                if sentiment in ("bullish", "bearish"):
                    sev = _score_news(headline, source, published_at)
                    insert_signal(
                        ticker,
                        "news_breaking",
                        sev,
                        headline[:120],
                        f"{source}: {headline}",
                        {"url": url, "sentiment": sentiment, "source": source, "published_at": published_at},
                    )

    return new_count


async def run_once() -> dict:
    tickers = get_watchlist_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no tickers"}
    total = 0
    async with httpx.AsyncClient() as client:
        for i in range(0, len(tickers), 5):
            batch = tickers[i:i+5]
            results = await asyncio.gather(*[process_ticker(client, t) for t in batch], return_exceptions=True)
            for r in results:
                if isinstance(r, int):
                    total += r
            if i + 5 < len(tickers):
                await asyncio.sleep(1)
    return {"status": "ok", "tickers": len(tickers), "new_articles": total}


async def main_loop():
    log.info("News worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"News tick: {result}")
        except Exception as e:
            log.error(f"News loop error: {e}")
        await asyncio.sleep(180)  # 3 min
