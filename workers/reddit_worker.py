"""
Reddit opportunity scanner — scrapes 5 major stock subreddits using Reddit's public JSON API
(no credentials required). Extracts ALL ticker mentions, runs Groq synthesis on top 10,
and inserts a morning brief convergence signal.

Schedule:
- Every 30 min: mention counting + individual sentiment_spike for watchlist tickers
- Once per day 6:00–6:30 AM ET (weekdays): full Groq synthesis → Morning Brief
"""
import os
import re
import logging
import httpx
import asyncio
from datetime import date
from db import get_watchlist_tickers, insert_signal, supabase
from market_hours import now_et, is_weekday

log = logging.getLogger("reddit_worker")

REDDIT_USER_AGENT = os.environ.get("REDDIT_USER_AGENT", "StockBot/1.0 (personal trading tool)")

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile"
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

SUBREDDITS = ["wallstreetbets", "stocks", "investing", "options", "pennystocks"]

# Common false positives to filter — words that look like tickers but aren't
FALSE_POSITIVES = {
    'A', 'I', 'AT', 'IT', 'ARE', 'BE', 'GO', 'ON', 'OR', 'SO', 'US', 'AN', 'IN',
    'AS', 'IS', 'TO', 'FOR', 'THE', 'ETF', 'CEO', 'IPO', 'SEC', 'AI', 'EV', 'ER',
    'DD', 'OG', 'RH', 'WSB', 'LOL', 'IMO', 'TBH', 'YOLO', 'FOMO', 'OTC', 'ATH',
    'ATL', 'PE', 'EPS', 'GDP', 'CPI', 'FED', 'IMF', 'SPAC', 'SPY', 'QQQ', 'IWM',
    'UP', 'DOWN', 'NEW', 'ALL', 'TOO', 'BOT', 'BUY', 'PUT', 'CALL', 'DIP', 'RUN',
    'NOW', 'OUT', 'OFF', 'HOW', 'NOT', 'BUT', 'YET', 'BOX', 'APP', 'WAS', 'HAS',
    'DID', 'CAN', 'MAY', 'DAY', 'WAY', 'BIG', 'LOW', 'HIGH', 'LONG', 'HOLD',
    'NEXT', 'LAST', 'GOOD', 'VERY', 'WELL', 'WILL', 'JUST', 'LIKE', 'MORE',
    'MUCH', 'SOME', 'MOST', 'OVER', 'INTO', 'FROM', 'WITH', 'THAT', 'THIS',
    'THEN', 'THAN', 'WHEN', 'WHAT', 'ALSO', 'EACH', 'BEEN', 'WERE', 'THEY',
    'HAVE', 'DOES', 'SAID', 'TIME', 'YEAR', 'PART', 'MAKE', 'MADE', 'BACK',
    'AFTER', 'ABOUT', 'ABOVE', 'ACROSS', 'AGAIN', 'PRICE', 'STOCK', 'TRADE',
    'PUTS', 'CALLS', 'BEAR', 'BULL', 'MOON', 'LOSS', 'GAIN', 'CASH', 'RISK',
    'NEWS', 'RATE', 'FUND', 'BANK', 'DEBT', 'REAL', 'SOLD', 'SELL', 'FIRE',
    'SURE', 'OPEN', 'FREE', 'MOVE', 'FEEL', 'KNOW', 'KEEP', 'GIVE', 'COME',
    'TAKE', 'LOOK', 'PLAY', 'MEAN', 'SAME', 'WANT', 'NEED', 'WENT', 'DONE',
    'STAY', 'WEEK', 'ZERO', 'PLUS', 'MAIN', 'SIDE', 'TERM', 'DATA', 'HUGE',
    'FULL', 'HALF', 'LESS', 'ELSE', 'BOTH', 'EVEN', 'ONLY', 'ONCE', 'NEAR',
    'AWAY', 'HARD', 'EASY', 'FAST', 'SLOW', 'SAFE', 'FEEL', 'LIVE', 'LOVE',
    'HELP', 'PLAN', 'BEST', 'PAST', 'AREA', 'BASE', 'CASE', 'IDEA', 'KIND',
    'MIND', 'FORM', 'LIST', 'BOOK', 'READ', 'SHOW', 'SORT', 'STOP', 'WAIT',
}

# Ticker regex: $TICKER or standalone uppercase 1-5 chars
TICKER_PATTERN = re.compile(r'(?:\$([A-Z]{1,5})\b|\b([A-Z]{2,5})\b)')

_morning_done: date | None = None

# ─── Reddit public JSON fetch (no credentials needed) ───────────────────────

async def fetch_subreddit_posts(
    client: httpx.AsyncClient, sub: str, limit: int = 100
) -> list[dict]:
    """Fetch posts using Reddit's public .json endpoint — no OAuth required."""
    try:
        r = await client.get(
            f"https://www.reddit.com/r/{sub}/hot.json",
            headers={"User-Agent": REDDIT_USER_AGENT},
            params={"limit": limit},
            timeout=15,
        )
        if r.status_code == 429:
            log.warning(f"Reddit rate limited on /r/{sub}, backing off")
            await asyncio.sleep(10)
            return []
        if r.status_code != 200:
            log.warning(f"Reddit /r/{sub} returned {r.status_code}")
            return []
        posts = [c["data"] for c in r.json().get("data", {}).get("children", []) if c.get("kind") == "t3"]
        for p in posts:
            p["_sub"] = sub
        return posts
    except Exception as e:
        log.error(f"Fetch /r/{sub} error: {e}")
        return []


# ─── Ticker extraction ───────────────────────────────────────────────────────

def extract_tickers_from_text(text: str) -> list[str]:
    """Extract potential ticker symbols from text."""
    found = []
    for m in TICKER_PATTERN.finditer(text):
        ticker = (m.group(1) or m.group(2)).upper()
        if ticker not in FALSE_POSITIVES and len(ticker) >= 2:
            found.append(ticker)
    return found


def build_mention_map(all_posts: list[dict]) -> dict[str, dict]:
    """
    Returns a map: ticker -> {
        count: int,
        upvotes: int,
        titles: list[str],
        subreddits: set[str],
    }
    """
    mentions: dict[str, dict] = {}
    for post in all_posts:
        text = f"{post.get('title', '')} {post.get('selftext', '')}"
        tickers_in_post = set(extract_tickers_from_text(text))
        for ticker in tickers_in_post:
            if ticker not in mentions:
                mentions[ticker] = {
                    "count": 0,
                    "upvotes": 0,
                    "titles": [],
                    "subreddits": set(),
                }
            rec = mentions[ticker]
            rec["count"] += 1
            rec["upvotes"] += max(0, post.get("score", 0))
            if len(rec["titles"]) < 3:
                title = post.get("title", "")[:120]
                if title and title not in rec["titles"]:
                    rec["titles"].append(title)
            rec["subreddits"].add(post.get("_sub", "unknown"))
    return mentions


# ─── Groq synthesis ──────────────────────────────────────────────────────────

async def groq_morning_brief(
    client: httpx.AsyncClient,
    top_tickers: list[dict],
    date_str: str,
) -> str | None:
    if not GROQ_API_KEY:
        log.warning("No GROQ_API_KEY — skipping morning brief synthesis")
        return None

    ticker_lines = []
    for item in top_tickers:
        ticker = item["ticker"]
        count = item["count"]
        subs = ", ".join(sorted(item["subreddits"]))
        titles = "; ".join(f'"{t}"' for t in item["titles"])
        ticker_lines.append(
            f"{ticker}: {count} mentions across {subs}\n  Sample posts: {titles}"
        )
    ticker_data = "\n\n".join(ticker_lines)

    prompt = f"""You are a trading analyst reviewing retail sentiment from Reddit. Here are the top mentioned tickers today with sample posts:

{ticker_data}

For each ticker, write ONE sentence explaining: what retail traders are saying and why it might be worth watching. Be specific — mention the actual catalyst or thesis being discussed. If the ticker seems like noise/meme, say so. Format as a numbered list. Be direct and trader-focused."""

    payload = {
        "model": GROQ_MODEL,
        "max_tokens": 600,
        "temperature": 0.3,
        "messages": [
            {
                "role": "system",
                "content": "You are an experienced trader writing internal morning briefings. Direct, specific, never generic.",
            },
            {"role": "user", "content": prompt},
        ],
    }

    try:
        r = await client.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json=payload,
            timeout=25,
        )
        if r.status_code == 429:
            log.warning("Groq rate limited for morning brief")
            return None
        if r.status_code != 200:
            log.warning(f"Groq error {r.status_code}: {r.text[:200]}")
            return None
        return r.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        log.error(f"Groq morning brief error: {e}")
        return None


# ─── Core scan logic ─────────────────────────────────────────────────────────

async def scan_reddit(client: httpx.AsyncClient) -> dict:
    """Fetch posts from all subreddits using public JSON API, build mention map."""
    all_posts: list[dict] = []
    for sub in SUBREDDITS:
        posts = await fetch_subreddit_posts(client, sub, 100)
        all_posts.extend(posts)
        await asyncio.sleep(2)  # be polite — Reddit rate limits unauthenticated requests

    log.info(f"Reddit: fetched {len(all_posts)} posts from {len(SUBREDDITS)} subs")
    mentions = build_mention_map(all_posts)

    # Filter to tickers mentioned 3+ times
    qualified = {k: v for k, v in mentions.items() if v["count"] >= 3}
    return {"mentions": qualified, "total_posts": len(all_posts)}


def emit_sentiment_spikes(mentions: dict[str, dict], watchlist: list[str]) -> int:
    """Insert sentiment_spike signals for watchlist tickers that appear in top mentions."""
    baseline = 2.0
    emitted = 0
    for ticker in watchlist:
        rec = mentions.get(ticker.upper())
        if not rec:
            continue
        count = rec["count"]
        if count < max(5, baseline * 3):
            continue
        ratio = count / baseline
        sev = 7 if count >= 15 else 5
        insert_signal(
            ticker,
            "sentiment_spike",
            sev,
            f"{ticker} reddit mentions spiking",
            (
                f"Mentioned {count}x across {', '.join(sorted(rec['subreddits']))} "
                f"({ratio:.1f}x baseline). Sample: {rec['titles'][0] if rec['titles'] else 'N/A'}"
            ),
            {
                "mentions": count,
                "baseline": baseline,
                "ratio": ratio,
                "upvotes": rec["upvotes"],
                "subreddits": sorted(rec["subreddits"]),
                "sample_titles": rec["titles"],
            },
        )
        emitted += 1
    return emitted


async def morning_brief(client: httpx.AsyncClient) -> dict:
    """
    Full morning scan with Groq synthesis. Runs once per day 6:00–6:30 AM ET on weekdays.
    Inserts a single 'REDDIT' convergence signal with the AI synthesis.
    """
    global _morning_done
    today = now_et().date()
    if _morning_done == today:
        return {"status": "skipped", "reason": "already ran today"}

    # Mark immediately to prevent double-fire in same 30-min window
    _morning_done = today

    log.info("Running morning Reddit brief...")
    scan = await scan_reddit(client)
    if "error" in scan or not scan.get("mentions"):
        _morning_done = None  # allow retry
        return {"status": "skipped", "reason": scan.get("error", "no posts fetched")}

    mentions = scan["mentions"]
    if not mentions:
        return {"status": "skipped", "reason": "no mentions found"}

    # Top 10 tickers by mention count
    top_10 = sorted(mentions.items(), key=lambda x: x[1]["count"], reverse=True)[:10]

    top_tickers_data = [
        {
            "ticker": ticker,
            "count": rec["count"],
            "upvotes": rec["upvotes"],
            "titles": rec["titles"],
            "subreddits": sorted(rec["subreddits"]),
        }
        for ticker, rec in top_10
    ]

    date_str = today.strftime("%B %d, %Y")
    synthesis = await groq_morning_brief(client, top_tickers_data, date_str)

    if not synthesis:
        synthesis = "\n".join(
            f"{i+1}. {item['ticker']}: {item['count']} mentions across Reddit."
            for i, item in enumerate(top_tickers_data)
        )

    n = len(top_10)
    insert_signal(
        "REDDIT",
        "convergence",
        6,
        f"Morning Reddit Scan — {date_str} — Top {n} tickers",
        synthesis,
        {
            "tickers": [t for t, _ in top_10],
            "mention_counts": {t: r["count"] for t, r in top_10},
            "sample_posts": {t: r["titles"] for t, r in top_10},
            "subreddits_scanned": SUBREDDITS,
            "scan_type": "morning_brief",
            "date": today.isoformat(),
        },
    )
    log.info(f"Morning brief inserted: top tickers = {[t for t, _ in top_10]}")
    return {"status": "ok", "tickers": [t for t, _ in top_10], "date": today.isoformat()}


# ─── Public entry points ─────────────────────────────────────────────────────

async def run_once() -> dict:
    """Manual trigger — always does the full morning brief scan."""
    async with httpx.AsyncClient() as client:
        scan = await scan_reddit(client)
        if "error" in scan:
            return {"status": "skipped", "reason": scan["error"]}

        mentions = scan["mentions"]
        watchlist = get_watchlist_tickers()
        spikes = emit_sentiment_spikes(mentions, watchlist)

        # Always run brief on manual trigger
        global _morning_done
        _morning_done = None  # force re-run
        brief = await morning_brief(client)

    return {
        "status": "ok",
        "total_posts": scan["total_posts"],
        "tickers_found": len(mentions),
        "sentiment_spikes": spikes,
        "morning_brief": brief,
    }


async def main_loop():
    log.info("Reddit worker started")
    while True:
        try:
            et = now_et()

            # Morning brief window: 6:00–6:30 AM ET, weekdays only
            if is_weekday() and et.hour == 6 and et.minute < 30:
                async with httpx.AsyncClient() as client:
                    result = await morning_brief(client)
                log.info(f"Morning brief: {result}")
            else:
                # Regular 30-min tick: mention counting + sentiment spikes (no Groq)
                async with httpx.AsyncClient() as client:
                    all_posts: list[dict] = []
                    for sub in SUBREDDITS:
                        posts = await fetch_subreddit_posts(client, sub, 100)
                        all_posts.extend(posts)
                        await asyncio.sleep(2)
                    mentions = build_mention_map(all_posts)
                    qualified = {k: v for k, v in mentions.items() if v["count"] >= 3}
                    watchlist = get_watchlist_tickers()
                    spikes = emit_sentiment_spikes(qualified, watchlist)
                    log.info(f"Reddit tick: {len(qualified)} qualified tickers, {spikes} spikes")

        except Exception as e:
            log.error(f"Reddit loop error: {e}")

        await asyncio.sleep(1800)  # 30 min
