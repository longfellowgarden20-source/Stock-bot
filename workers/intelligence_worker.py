"""
Intelligence Worker — Groq reads the world every 30 minutes.

Scans RSS feeds from Reuters, WSJ, SEC, FDA, Federal Register, DoD, and
USASpending.gov for breakthrough news: government contracts, legislation,
FDA approvals, regulatory changes, geopolitical shifts.

Groq reasons about implications — not just pattern matching — and flags
any story that could significantly move a publicly traded stock.

Flagged tickers get:
  - High-severity convergence signal in the dashboard
  - Auto-added to watchlist so all 14 workers start monitoring
  - Push notification if urgency >= 8
"""
import os
import logging
import httpx
import asyncio
import feedparser
import json
import re
from datetime import datetime, timezone, timedelta
from db import supabase, insert_signal

log = logging.getLogger("intelligence_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

# ─── RSS Feed Sources ─────────────────────────────────────────────────────────

FEEDS = [
    # Newswires
    {"name": "Reuters Business",      "url": "https://feeds.reuters.com/reuters/businessNews"},
    {"name": "Reuters Top News",      "url": "https://feeds.reuters.com/reuters/topNews"},
    {"name": "AP Business",           "url": "https://feeds.apnews.com/apnews/business"},
    {"name": "MarketWatch",           "url": "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines"},
    {"name": "Seeking Alpha",         "url": "https://seekingalpha.com/feed.xml"},
    # Government / Regulatory
    {"name": "SEC Press Releases",    "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=20&search_text=&output=atom"},
    {"name": "FDA News",              "url": "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml"},
    {"name": "Federal Register",      "url": "https://www.federalregister.gov/documents/search.rss?conditions%5Btype%5D%5B%5D=RULE&conditions%5Btype%5D%5B%5D=NOTICE"},
    {"name": "White House",           "url": "https://www.whitehouse.gov/feed/"},
    {"name": "DoD News",              "url": "https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=10"},
    # Financial / Market
    {"name": "CNBC Markets",          "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258"},
    {"name": "Yahoo Finance",         "url": "https://finance.yahoo.com/rss/topstories"},
    {"name": "Benzinga",              "url": "https://www.benzinga.com/feed"},
    {"name": "Motley Fool",           "url": "https://www.fool.com/feeds/index.aspx"},
]

# Known ticker → company name mappings to help Groq identify tickers from news
# (Groq will also figure out tickers it knows from its training data)
SECTOR_KEYWORDS = {
    "defense": ["LMT", "RTX", "NOC", "GD", "BA", "HII", "LDOS", "SAIC", "CACI"],
    "pharma": ["PFE", "MRK", "ABBV", "BMY", "JNJ", "AMGN", "GILD", "BIIB", "MRNA", "NVAX"],
    "energy": ["XOM", "CVX", "COP", "SLB", "HAL", "OXY", "DVN", "MPC", "PSX"],
    "semiconductor": ["NVDA", "AMD", "INTC", "TSM", "AVGO", "QCOM", "MRVL", "AMAT", "LRCX", "KLAC"],
    "ev": ["TSLA", "RIVN", "LCID", "NIO", "XPEV", "FSR", "GOEV"],
    "ai": ["NVDA", "MSFT", "GOOGL", "META", "AMZN", "PLTR", "AI", "BBAI", "SOUN"],
    "biotech": ["MRNA", "BNTX", "REGN", "VRTX", "ALNY", "BMRN", "SRPT"],
    "fintech": ["SQ", "PYPL", "COIN", "HOOD", "AFRM", "SOFI", "NU"],
    "cloud": ["AMZN", "MSFT", "GOOGL", "CRM", "SNOW", "DDOG", "MDB", "NET"],
}

# Dedup: don't re-process same headline
_seen_headlines: set[str] = set()
_MAX_SEEN = 2000
_last_run_headlines: list[dict] = []


async def _call_groq(prompt: str, max_tokens: int = 600) -> str | None:
    from groq_pool import call_llm
    return await call_llm(prompt, primary_env_vars=["GROQ_API_KEY_2"], max_tokens=max_tokens, temperature=0.2)


def _fetch_feed(url: str, name: str) -> list[dict]:
    """Parse RSS feed, return list of {title, summary, link, published} dicts."""
    try:
        feed = feedparser.parse(url)
        items = []
        cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
        for entry in feed.entries[:15]:
            title = entry.get("title", "").strip()
            if not title or title in _seen_headlines:
                continue
            # Try to parse published date
            published = None
            if hasattr(entry, "published_parsed") and entry.published_parsed:
                try:
                    published = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
                except Exception:
                    pass
            # Only include recent articles (last 2h) unless we have no date
            if published and published < cutoff:
                continue
            summary = entry.get("summary", "")[:300]
            link = entry.get("link", "")
            items.append({"title": title, "summary": summary, "link": link, "source": name})
        return items
    except Exception as e:
        log.debug(f"Feed parse failed for {name}: {e}")
        return []


async def fetch_all_feeds() -> list[dict]:
    """Fetch all RSS feeds concurrently using asyncio + feedparser (sync)."""
    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(None, _fetch_feed, feed["url"], feed["name"])
        for feed in FEEDS
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    articles = []
    for r in results:
        if isinstance(r, list):
            articles.extend(r)
    return articles


async def fetch_usaspending_contracts(client: httpx.AsyncClient) -> list[dict]:
    """
    USASpending.gov API — recent large federal contract awards.
    Free, no auth required. Returns contracts > $10M from last 2 days.
    """
    try:
        today = datetime.now(timezone.utc).date()
        two_days_ago = (today - timedelta(days=2)).isoformat()
        r = await client.post(
            "https://api.usaspending.gov/api/v2/search/spending_by_award/",
            json={
                "filters": {
                    "time_period": [{"start_date": two_days_ago, "end_date": today.isoformat()}],
                    "award_type_codes": ["A", "B", "C", "D"],  # contracts
                    "award_amounts": [{"lower_bound": 10_000_000}],
                },
                "fields": ["Recipient Name", "Award Amount", "Awarding Agency Name", "Award Description", "Period of Performance Start Date"],
                "sort": "Award Amount",
                "order": "desc",
                "limit": 20,
            },
            timeout=20,
        )
        if r.status_code != 200:
            return []
        results = r.json().get("results", [])
        contracts = []
        for c in results:
            recipient = c.get("Recipient Name", "")
            amount = c.get("Award Amount", 0)
            agency = c.get("Awarding Agency Name", "")
            desc = c.get("Award Description", "")
            if recipient and amount:
                contracts.append({
                    "title": f"${amount/1e6:.0f}M contract: {recipient} from {agency}",
                    "summary": desc[:200] if desc else "",
                    "source": "USASpending.gov",
                    "link": "https://usaspending.gov",
                    "recipient": recipient,
                    "amount": amount,
                })
        return contracts
    except Exception as e:
        log.debug(f"USASpending fetch failed: {e}")
        return []


async def fetch_polygon_movers(client: httpx.AsyncClient) -> list[str]:
    """Top gainers/losers/active from Polygon — tickers with unusual market activity today."""
    if not POLYGON_KEY:
        return []
    tickers = set()
    for direction in ["gainers", "losers"]:
        try:
            r = await client.get(
                f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/{direction}",
                params={"apiKey": POLYGON_KEY, "include_otc": False},
                timeout=10,
            )
            if r.status_code == 200:
                for item in (r.json().get("tickers") or [])[:20]:
                    t = item.get("ticker", "")
                    if t and len(t) <= 5:
                        tickers.add(t)
        except Exception as e:
            log.debug(f"Polygon movers failed ({direction}): {e}")
    return list(tickers)


def _build_groq_prompt(articles: list[dict], contracts: list[dict], market_movers: list[str]) -> str:
    article_lines = []
    for i, a in enumerate(articles[:60], 1):
        line = f"{i}. [{a['source']}] {a['title']}"
        if a.get("summary"):
            line += f" — {a['summary'][:150]}"
        article_lines.append(line)

    contract_lines = []
    for c in contracts[:10]:
        contract_lines.append(f"- {c['title']} | {c.get('summary', '')[:100]}")

    mover_str = ", ".join(market_movers[:30]) if market_movers else "none"

    article_block = "\n".join(article_lines) if article_lines else "No new articles."
    contract_block = "\n".join(contract_lines) if contract_lines else "No new contracts."

    return f"""You are a market intelligence analyst scanning breaking news for stock market catalysts. Your job is to identify stories with REAL potential to move specific publicly traded stocks — not generic market commentary.

TODAY'S NEWS HEADLINES:
{article_block}

RECENT GOVERNMENT CONTRACT AWARDS (>$10M):
{contract_block}

TODAY'S UNUSUAL MARKET MOVERS (already moving):
{mover_str}

Scan all of the above and identify up to 6 stories that represent genuine, specific catalysts for publicly traded stocks. Focus on:
- Government contracts, grants, or procurement awards to specific companies
- FDA drug approvals, rejections, or clinical trial results
- New legislation or regulation that benefits/hurts a specific sector or company
- Geopolitical events that affect specific supply chains or industries
- Major partnerships, acquisitions, or licensing deals
- Breakthrough technology announcements with commercial applications

For each catalyst you find, respond with JSON only, in this exact format:
{{
  "flags": [
    {{
      "ticker": "TICKER",
      "company": "Company Name",
      "urgency": <1-10>,
      "catalyst_type": "government_contract | fda_approval | legislation | geopolitical | partnership | technology",
      "headline": "the specific headline that triggered this",
      "why_it_matters": "1-2 sentences explaining the market impact — be specific about dollar amounts, percentages, or strategic significance",
      "source": "source name",
      "link": "url if available"
    }}
  ]
}}

Rules:
- Only flag tickers you are highly confident exist as publicly traded US stocks
- urgency 9-10: immediate major catalyst (FDA approval, huge contract, legislation passed)
- urgency 7-8: significant but not immediate (contract awarded pending, bill proposed, trial results)
- urgency 5-6: worth watching but not urgent
- Skip ETFs, indices, and generic market commentary
- If a contract goes to a private company or subsidiary, flag the publicly traded parent
- If no genuine catalysts found, return {{"flags": []}}
- Return ONLY the JSON, no other text"""


async def add_to_watchlist(ticker: str, reason: str) -> bool:
    """Auto-add a ticker to watchlist if not already there."""
    try:
        db = supabase()
        existing = db.table("watchlist").select("id").eq("ticker", ticker.upper()).limit(1).execute()
        if existing.data:
            return False
        db.table("watchlist").insert({
            "ticker": ticker.upper(),
            "name": ticker.upper(),
            "notes": f"Auto-added by intelligence worker: {reason[:200]}",
        }).execute()
        log.info(f"Auto-added {ticker} to watchlist")
        return True
    except Exception as e:
        log.debug(f"Watchlist add failed for {ticker}: {e}")
        return False


def _dedup_headline(title: str) -> bool:
    """Returns True if headline is new (not seen before)."""
    global _seen_headlines
    key = title.lower().strip()[:100]
    if key in _seen_headlines:
        return False
    _seen_headlines.add(key)
    if len(_seen_headlines) > _MAX_SEEN:
        # Evict oldest half
        items = list(_seen_headlines)
        _seen_headlines = set(items[_MAX_SEEN // 2:])
    return True


async def run_once() -> dict:
    global _last_run_headlines

    from groq_pool import _load_all_keys
    _load_all_keys()  # Load GROQ_API_KEY_2 and backups

    log.info("Intelligence worker scanning feeds...")

    async with httpx.AsyncClient(timeout=20) as client:
        # Fetch everything concurrently
        articles_task = fetch_all_feeds()
        contracts_task = fetch_usaspending_contracts(client)
        movers_task = fetch_polygon_movers(client)

        articles, contracts, movers = await asyncio.gather(
            articles_task, contracts_task, movers_task,
            return_exceptions=True,
        )

    if isinstance(articles, Exception):
        articles = []
    if isinstance(contracts, Exception):
        contracts = []
    if isinstance(movers, Exception):
        movers = []

    # Filter to new headlines only
    new_articles = [a for a in articles if _dedup_headline(a["title"])]
    _last_run_headlines = new_articles[:60]

    if not new_articles and not contracts:
        return {"status": "ok", "new_articles": 0, "flags": 0}

    log.info(f"Intelligence: {len(new_articles)} new articles, {len(contracts)} contracts, {len(movers)} movers")

    prompt = _build_groq_prompt(new_articles, contracts, movers)
    raw = await _call_groq(prompt, max_tokens=800)
    if not raw:
        return {"status": "ok", "new_articles": len(new_articles), "flags": 0, "reason": "groq failed"}

    # Parse Groq response
    try:
        text = raw.strip()
        if "```" in text:
            parts = text.split("```")
            text = parts[1] if len(parts) >= 2 else text
            if text.startswith("json"):
                text = text[4:]
        parsed = json.loads(text.strip())
        flags = parsed.get("flags", [])
    except Exception as e:
        log.warning(f"Intelligence worker JSON parse failed: {e}\nRaw: {raw[:400]}")
        return {"status": "ok", "new_articles": len(new_articles), "flags": 0}

    flagged_tickers = []
    for flag in flags:
        ticker = str(flag.get("ticker", "")).upper().strip()
        urgency = int(flag.get("urgency", 5))
        catalyst = str(flag.get("catalyst_type", "news"))
        headline = str(flag.get("headline", ""))[:200]
        why = str(flag.get("why_it_matters", ""))[:500]
        source = str(flag.get("source", ""))
        link = str(flag.get("link", ""))
        company = str(flag.get("company", ticker))

        if not ticker or len(ticker) > 5 or urgency < 5:
            continue

        # Map urgency to severity
        sev = round(min(10.0, max(5.0, urgency * 1.0)), 1)

        body = why
        if link and link.startswith("http"):
            body += f"\n\nSource: {headline} ({source})"

        insert_signal(
            ticker,
            "convergence",
            sev,
            f"[INTELLIGENCE] {headline[:120]}",
            body,
            {
                "catalyst_type": catalyst,
                "company": company,
                "urgency": urgency,
                "source": source,
                "link": link,
                "headline": headline,
                "auto_detected": True,
            },
        )

        # Auto-add to watchlist
        await add_to_watchlist(ticker, why[:200])
        flagged_tickers.append(ticker)
        log.info(f"Intelligence flagged {ticker} (urgency {urgency}): {headline[:80]}")

    return {"status": "ok", "new_articles": len(new_articles), "contracts": len(contracts), "flags": len(flagged_tickers), "tickers": flagged_tickers}


async def main_loop():
    log.info("Intelligence worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Intelligence tick: {result}")
        except Exception as e:
            log.error(f"Intelligence loop error: {e}")
        await asyncio.sleep(1800)  # every 30 minutes
