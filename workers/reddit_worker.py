"""
StockTwits sentiment worker — replaces Reddit (which blocks unauthenticated requests).

StockTwits is a trader-focused social platform where every post is tagged to a ticker
and users self-label bullish/bearish. No auth required for the public API.

Schedule:
- Every 30 min: fetch trending tickers + watchlist sentiment spikes
- Every 2 hours during market hours (6,8,10,12,14,16,18 ET): Groq synthesis brief
"""
import logging
import httpx
import asyncio
from datetime import datetime, date
from db import get_watchlist_tickers, insert_signal
from market_hours import now_et, is_weekday

log = logging.getLogger("reddit_worker")  # keep name for main.py compatibility

STOCKTWITS_BASE = "https://api.stocktwits.com/api/2"

_last_brief_hour: int = -1


# ─── StockTwits fetch ─────────────────────────────────────────────────────────

async def fetch_trending(client: httpx.AsyncClient) -> list[dict]:
    """Top trending tickers on StockTwits right now."""
    try:
        r = await client.get(f"{STOCKTWITS_BASE}/trending/symbols.json", timeout=10)
        if r.status_code != 200:
            log.warning(f"StockTwits trending returned {r.status_code}")
            return []
        symbols = r.json().get("symbols", [])
        return symbols[:30]
    except Exception as e:
        log.error(f"StockTwits trending fetch failed: {e}")
        return []


async def fetch_ticker_stream(client: httpx.AsyncClient, ticker: str) -> list[dict]:
    """Recent messages for a specific ticker."""
    try:
        r = await client.get(
            f"{STOCKTWITS_BASE}/streams/symbol/{ticker}.json",
            params={"limit": 30},
            timeout=10,
        )
        if r.status_code == 429:
            log.debug(f"StockTwits rate limited on {ticker}")
            return []
        if r.status_code != 200:
            return []
        return r.json().get("messages", [])
    except Exception as e:
        log.debug(f"StockTwits stream failed for {ticker}: {e}")
        return []


def parse_sentiment(messages: list[dict]) -> dict:
    """
    Count bullish/bearish sentiment from StockTwits messages.
    Returns {bullish, bearish, neutral, total, bull_pct, sample_messages}.
    """
    bullish = 0
    bearish = 0
    neutral = 0
    samples = []

    for m in messages:
        sentiment = (m.get("entities") or {}).get("sentiment") or {}
        label = (sentiment.get("basic") or "").lower()
        body = (m.get("body") or "")[:120]

        if label == "bullish":
            bullish += 1
        elif label == "bearish":
            bearish += 1
        else:
            neutral += 1

        if body and len(samples) < 3:
            samples.append(body)

    total = bullish + bearish + neutral
    bull_pct = round(bullish / total * 100, 1) if total > 0 else 50.0

    return {
        "bullish": bullish,
        "bearish": bearish,
        "neutral": neutral,
        "total": total,
        "bull_pct": bull_pct,
        "sample_messages": samples,
    }


# ─── Sentiment spike detection ────────────────────────────────────────────────

async def check_watchlist_sentiment(client: httpx.AsyncClient, watchlist: list[str]) -> int:
    """
    For each watchlist ticker, fetch StockTwits stream and emit a signal
    if sentiment is strongly skewed (>70% bull or >70% bear) with enough volume.
    """
    emitted = 0
    for ticker in watchlist:
        messages = await fetch_ticker_stream(client, ticker)
        if len(messages) < 5:
            await asyncio.sleep(0.5)
            continue

        s = parse_sentiment(messages)
        bull_pct = s["bull_pct"]
        total = s["total"]

        # Strong bullish signal
        if bull_pct >= 70 and total >= 8:
            sev = 7.0 if bull_pct >= 80 else 5.5
            insert_signal(
                ticker, "sentiment_spike", sev,
                f"{ticker} StockTwits {bull_pct:.0f}% bullish ({total} posts)",
                f"Strong bullish sentiment on StockTwits: {bull_pct:.0f}% of {total} recent posts are bullish. "
                f"Sample: \"{s['sample_messages'][0]}\"" if s['sample_messages'] else "",
                {"source": "stocktwits", "bull_pct": bull_pct, "total_messages": total,
                 "bullish": s["bullish"], "bearish": s["bearish"], "samples": s["sample_messages"]},
            )
            emitted += 1

        # Strong bearish signal
        elif bull_pct <= 30 and total >= 8:
            sev = 7.0 if bull_pct <= 20 else 5.5
            bear_pct = 100 - bull_pct
            insert_signal(
                ticker, "sentiment_spike", sev,
                f"{ticker} StockTwits {bear_pct:.0f}% bearish ({total} posts)",
                f"Strong bearish sentiment on StockTwits: {bear_pct:.0f}% of {total} recent posts are bearish. "
                f"Sample: \"{s['sample_messages'][0]}\"" if s['sample_messages'] else "",
                {"source": "stocktwits", "bull_pct": bull_pct, "total_messages": total,
                 "bullish": s["bullish"], "bearish": s["bearish"], "samples": s["sample_messages"]},
            )
            emitted += 1

        await asyncio.sleep(0.5)  # gentle rate limiting

    return emitted


# ─── Groq brief ───────────────────────────────────────────────────────────────

async def groq_sentiment_brief(trending: list[dict], watchlist_data: list[dict]) -> str | None:
    from groq_pool import call_llm

    trend_lines = []
    for s in trending[:15]:
        symbol = s.get("symbol", "")
        name = s.get("title", "")
        watchlist_count = s.get("watchlist_count", 0)
        trend_lines.append(f"- {symbol} ({name}) — {watchlist_count:,} watching")

    watch_lines = []
    for w in watchlist_data:
        ticker = w["ticker"]
        s = w["sentiment"]
        if s["total"] >= 3:
            watch_lines.append(
                f"- {ticker}: {s['bull_pct']:.0f}% bullish ({s['total']} posts) — "
                f"Sample: \"{s['sample_messages'][0]}\"" if s["sample_messages"] else f"- {ticker}: {s['bull_pct']:.0f}% bullish ({s['total']} posts)"
            )

    trend_block = "\n".join(trend_lines) if trend_lines else "No trending data."
    watch_block = "\n".join(watch_lines) if watch_lines else "No watchlist data."

    try:
        import zoneinfo
        et_now = datetime.now(zoneinfo.ZoneInfo("America/New_York"))
        time_str = et_now.strftime("%I:%M %p ET")
    except Exception:
        time_str = "market hours"

    prompt = f"""You are a trading analyst reviewing retail trader sentiment from StockTwits at {time_str}.

TOP TRENDING TICKERS ON STOCKTWITS RIGHT NOW:
{trend_block}

YOUR WATCHLIST SENTIMENT:
{watch_block}

Write a concise market sentiment brief:
1. What are retail traders most excited or worried about right now?
2. Any of your watchlist tickers showing unusual sentiment worth acting on?
3. Any trending tickers outside your watchlist that look interesting?

Format as 3-4 short paragraphs. Be specific — mention actual tickers and sentiment direction. Trader-focused, no fluff."""

    return await call_llm(
        prompt,
        primary_env_vars=["CEREBRAS_API_KEY_2"],
        max_tokens=500,
        temperature=0.3,
        system="You are an experienced trader writing internal sentiment briefings. Direct, specific, never generic.",
    )


async def run_brief(client: httpx.AsyncClient) -> dict:
    """Full sentiment brief — trending + watchlist + Groq synthesis."""
    today = now_et().date()

    trending = await fetch_trending(client)
    watchlist = get_watchlist_tickers()

    # Fetch sentiment for watchlist tickers (up to 10 to avoid rate limits)
    watchlist_data = []
    for ticker in watchlist[:10]:
        messages = await fetch_ticker_stream(client, ticker)
        if messages:
            s = parse_sentiment(messages)
            watchlist_data.append({"ticker": ticker, "sentiment": s})
        await asyncio.sleep(0.5)

    synthesis = await groq_sentiment_brief(trending, watchlist_data)

    if not synthesis:
        # Fallback: plain text summary without Groq
        lines = [f"Trending: {', '.join(s.get('symbol','') for s in trending[:10])}"]
        for w in watchlist_data:
            s = w["sentiment"]
            lines.append(f"{w['ticker']}: {s['bull_pct']:.0f}% bullish ({s['total']} posts)")
        synthesis = "\n".join(lines)

    try:
        import zoneinfo
        et_now = datetime.now(zoneinfo.ZoneInfo("America/New_York"))
        hour_label = et_now.strftime("%-I%p").lower()
    except Exception:
        hour_label = today.isoformat()

    trending_tickers = [s.get("symbol", "") for s in trending[:10] if s.get("symbol")]

    insert_signal(
        "REDDIT",  # keep ticker as REDDIT for journal briefs tab compatibility
        "convergence",
        6,
        f"StockTwits Sentiment — {hour_label} — {len(trending_tickers)} trending",
        synthesis,
        {
            "tickers": trending_tickers,
            "mention_counts": {s.get("symbol", ""): s.get("watchlist_count", 0) for s in trending[:10]},
            "sample_posts": {w["ticker"]: w["sentiment"]["sample_messages"] for w in watchlist_data},
            "source": "stocktwits",
            "scan_type": "sentiment_brief",
            "date": today.isoformat(),
        },
    )

    log.info(f"StockTwits brief inserted: trending={trending_tickers[:5]}")
    return {"status": "ok", "trending": trending_tickers, "watchlist_coverage": len(watchlist_data)}


# ─── Public entry points ──────────────────────────────────────────────────────

async def run_once() -> dict:
    """Manual trigger — always runs a full brief."""
    async with httpx.AsyncClient(timeout=15) as client:
        watchlist = get_watchlist_tickers()
        spikes = await check_watchlist_sentiment(client, watchlist)
        brief = await run_brief(client)

    return {
        "status": "ok",
        "sentiment_spikes": spikes,
        "brief": brief,
    }


async def main_loop():
    global _last_brief_hour
    log.info("StockTwits sentiment worker started")

    while True:
        try:
            et = now_et()
            brief_hours = {6, 8, 10, 12, 14, 16, 18}
            should_brief = (
                is_weekday()
                and et.hour in brief_hours
                and et.minute < 30
                and et.hour != _last_brief_hour
            )

            async with httpx.AsyncClient(timeout=15) as client:
                if should_brief:
                    _last_brief_hour = et.hour
                    result = await run_brief(client)
                    log.info(f"StockTwits brief ({et.hour}h): {result}")

                # Always check watchlist sentiment every 30 min
                watchlist = get_watchlist_tickers()
                spikes = await check_watchlist_sentiment(client, watchlist)
                log.info(f"StockTwits tick: {spikes} sentiment spikes emitted")

        except Exception as e:
            log.error(f"StockTwits loop error: {e}")

        await asyncio.sleep(1800)
