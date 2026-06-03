# CLAUDE.md — Stock Intelligence Bot

## Project Overview
A real-time stock intelligence platform built for active trading. Two core functions:
1. **Opportunity Scanner** — surfaces high-reward plays before they move by cross-referencing multiple signals simultaneously
2. **Portfolio Watchdog** — monitors owned positions 24/7 for news, filings, distress signals, and unusual activity

This is NOT a trade executor. It surfaces signals and alerts. The human makes the final call.

## Stack Decisions (Non-Negotiable)

**Frontend:** Next.js 15 App Router + TypeScript
**Database:** Supabase (postgres + realtime subscriptions)
**Background Jobs:** Railway.app (Python FastAPI workers for data ingestion)
**AI Analysis:** Groq (llama-3.3-70b-versatile for deep analysis, llama-3.1-8b-instant for fast summaries)
**Auth:** Supabase Google OAuth — single user only
**Styling:** Tailwind CSS — dark terminal aesthetic, no marketing fluff

**Why this stack:**
- Supabase Realtime lets the dashboard update without polling
- Railway workers run continuously outside Vercel's 10s function limit
- Groq is fast enough for real-time signal synthesis — sub 2 second responses
- Same stack as existing projects — no context switching

## Data Sources & APIs

| Signal Type | Source | API | Cost |
|---|---|---|---|
| Real-time price + volume | Polygon.io | REST + WebSocket | Free tier / $29/mo |
| Options flow + dark pool | Unusual Whales | REST | $50/mo |
| Technical indicators | Alpha Vantage | REST | Free tier |
| SEC filings (insider, 13F, 8-K) | SEC EDGAR | REST | Free |
| Breaking news | NewsAPI | REST | Free tier |
| Social sentiment | Reddit API | REST | Free |
| Congressional trades | Quiver Quantitative | REST | Free tier |
| Earnings data | Alpha Vantage / Polygon | REST | Free tier |
| Short interest | Finviz scrape / FINRA | REST | Free |

**Priority order for API keys to get first:**
1. Polygon.io — core price/volume data, everything depends on this
2. Unusual Whales — options flow is the highest-signal data source
3. NewsAPI — breaking news
4. Reddit — already have this from agency scraper

## Database Schema

### `watchlist`
```sql
id, ticker, name, sector, added_at, notes, alert_threshold_pct
```

### `portfolio`
```sql
id, ticker, shares, avg_cost, added_at, notes
```

### `signals`
```sql
id, ticker, signal_type, severity (1-10), title, body, raw_data (jsonb), created_at, read
```
Signal types: `price_move`, `volume_spike`, `options_unusual`, `dark_pool`, `insider_buy`, `insider_sell`, `news_breaking`, `sec_filing`, `sentiment_spike`, `short_squeeze`, `earnings_upcoming`, `analyst_change`, `congress_trade`

### `snapshots`
```sql
id, ticker, price, volume, change_pct, market_cap, short_interest, iv_rank, created_at
```
Stored every 5 minutes during market hours.

### `news`
```sql
id, ticker, headline, source, url, sentiment (bullish/bearish/neutral), published_at, created_at
```

### `alerts`
```sql
id, ticker, condition, threshold, triggered_at, notified
```

## Architecture

```
┌─────────────────────────────────────┐
│         Next.js Dashboard           │
│  - Real-time via Supabase channels  │
│  - Signal feed, portfolio, scanner  │
└──────────────┬──────────────────────┘
               │ Supabase Realtime
┌──────────────▼──────────────────────┐
│            Supabase DB              │
│  signals, snapshots, news, alerts   │
└──────────────▲──────────────────────┘
               │ writes
┌──────────────┴──────────────────────┐
│       Railway Python Workers        │
│                                     │
│  price_worker.py   — Polygon WS     │
│  options_worker.py — Unusual Whales │
│  news_worker.py    — NewsAPI        │
│  sec_worker.py     — EDGAR          │
│  reddit_worker.py  — Reddit API     │
│  sentiment_worker.py               │
│  signal_engine.py  — Groq synthesis │
└─────────────────────────────────────┘
```

**Key principle:** Workers write raw data to Supabase. The signal engine reads raw data, cross-references signals, and writes synthesized alerts. Dashboard only reads — never writes to signal tables directly.

## Signal Engine — The Core Intelligence

This is what makes the bot elite. Not individual signals but **signal convergence**.

Single signal = noise.
Multiple signals on same ticker in short window = real alert.

### Convergence scoring (signal_engine.py)
Each signal type has a base weight:
- Dark pool print: 8/10
- Insider buy: 9/10
- Unusual options sweep: 8/10
- Volume 10x avg: 7/10
- Short squeeze setup: 8/10
- Congress trade: 7/10
- News breaking: 5/10
- Reddit sentiment spike: 4/10
- Technical breakout: 5/10

When 2+ signals align on the same ticker within 30 minutes → Groq synthesis triggered → alert written to `signals` table → dashboard updates in real time.

### Groq prompt for signal synthesis
Keep it under 150 words, plain English, trader-focused. No fluff. Example output:
> "AAPL showing unusual call sweep ($2.1M) + dark pool print at $195 + volume 4x avg. Possible institutional accumulation ahead of earnings (June 15). Watch $196 for breakout confirmation. Risk: broad market weakness today."

## Workers — Build Order

1. `price_worker.py` — Polygon WebSocket, writes snapshots every 5 min
2. `news_worker.py` — NewsAPI polling every 2 min, writes to news table
3. `sec_worker.py` — EDGAR RSS feed, fires on new filings instantly
4. `options_worker.py` — Unusual Whales polling every 5 min
5. `reddit_worker.py` — Reddit API, tracks mention velocity per ticker
6. `signal_engine.py` — runs every 5 min, cross-references all tables, calls Groq

## Dashboard Pages

| Page | Purpose |
|---|---|
| `/dashboard` | Signal feed — real-time alerts sorted by severity |
| `/scanner` | Opportunity scanner — filter by signal type, sector, market cap |
| `/portfolio` | Your positions — P&L, watchdog alerts, news feed per ticker |
| `/watchlist` | Tickers you're monitoring — add/remove, set alert thresholds |
| `/signals/[id]` | Deep dive on a single signal — full Groq analysis, raw data |

## UI Rules

**Theme:** Dark terminal. Think Bloomberg terminal not Robinhood.
**Base:** `#0a0f1a`
**Green:** `#22c55e` (bullish signals)
**Red:** `#ef4444` (bearish signals, distress)
**Yellow:** `#f59e0b` (warnings, neutral signals)
**Blue:** `#0ea5e9` (info, price data)
**Orange:** `#f97316` (high severity alerts)

**Signal severity colors:**
- 9-10: red pulse animation — act now
- 7-8: orange — high priority
- 5-6: yellow — watch closely
- 1-4: blue — informational

**No candlestick charts in v1** — too much complexity, focus on signals first. Add charts in v2.

## Hard Rules

- Never auto-trade anything — signals only, human pulls the trigger
- Never expose API keys client-side — all data fetching in workers or API routes
- Rate limit all external API calls — respect free tier limits
- Cap Groq calls — only synthesize when 2+ signals converge, not on every data point
- All times in Eastern (market time) — display converted from UTC
- Market hours awareness — workers behave differently pre-market (4am-9:30am ET), market hours (9:30am-4pm ET), after hours (4pm-8pm ET)

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
POLYGON_API_KEY
UNUSUAL_WHALES_API_KEY
ALPHA_VANTAGE_API_KEY
NEWS_API_KEY
REDDIT_CLIENT_ID
REDDIT_CLIENT_SECRET
GROQ_API_KEY
QUIVER_API_KEY
```

## Build Order

1. Supabase schema — all tables, RLS policies, realtime enabled
2. Auth + Next.js shell — copy from agency scraper pattern
3. `price_worker.py` on Railway — Polygon snapshots flowing into DB
4. Dashboard signal feed — realtime subscription to signals table
5. `news_worker.py` — news flowing in
6. `sec_worker.py` — insider filing alerts
7. Portfolio page — positions + P&L
8. `options_worker.py` — Unusual Whales flow
9. `signal_engine.py` — cross-signal Groq synthesis
10. `reddit_worker.py` — sentiment layer
11. Scanner page — opportunity hunting UI
12. Push notifications — Expo or web push for mobile alerts

## Current Status
Project just created. Nothing built yet. Start with Supabase schema.
