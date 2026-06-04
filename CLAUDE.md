# CLAUDE.md — Stock Intelligence Bot

## Project Overview
A real-time stock intelligence platform built for active trading. Two core functions:
1. **Opportunity Scanner** — surfaces high-reward plays before they move by cross-referencing multiple signals simultaneously
2. **Portfolio Watchdog** — monitors owned positions 24/7 for news, filings, distress signals, and unusual activity

This is NOT a trade executor. It surfaces signals and alerts. The human makes the final call.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 15 App Router + TypeScript |
| Styling | Tailwind CSS v4 — dark terminal aesthetic |
| Database | Supabase (Postgres + Realtime subscriptions) |
| Background workers | Railway.app — Python FastAPI |
| AI synthesis | Groq `llama-3.3-70b-versatile` (deep), `llama-3.1-8b-instant` (fast) |
| Auth | Supabase Google OAuth — single user only |
| Push notifications | Web Push API (VAPID), service worker in `public/sw.js` |

---

## Data Sources & APIs

| Signal Type | Source | Free Tier |
|---|---|---|
| Real-time price + volume | Polygon.io REST + WebSocket | Yes |
| Options flow + dark pool | Unusual Whales | $50/mo |
| Technical indicators | Computed in-house from Polygon aggregates | — |
| Analyst ratings + price targets | Finnhub | Free tier |
| SEC filings (insider, 13F, 8-K) | SEC EDGAR REST | Free |
| Congressional trades | Quiver Quantitative | Free tier |
| Short interest / FTDs | FINRA + SEC EDGAR ZIP downloads | Free |
| Macro (yields, VIX, dollar) | Polygon (I:VIX, ETFs) + FRED API | Free |
| Sector rotation | SPDR ETF aggregates via Polygon | Free |

---

## Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

# Data APIs
POLYGON_API_KEY
UNUSUAL_WHALES_API_KEY
FINNHUB_API_KEY
QUIVER_API_KEY
FRED_API_KEY

# AI
GROQ_API_KEY

# Push notifications
NEXT_PUBLIC_APP_URL              # e.g. https://stock-bot.vercel.app
NEXT_PUBLIC_VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT                    # mailto:you@example.com
PUSH_NOTIFY_TOKEN                # shared secret — workers use this to call /api/push/notify
```

---

## Database Schema

### `watchlist`
```sql
id, ticker, name, sector, added_at, notes, alert_threshold_pct, pinned, muted
```

### `portfolio`
```sql
id, ticker, shares, avg_cost, added_at, notes
```

### `signals`
```sql
id uuid PK
ticker text
signal_type text   -- see list below
severity int       -- 1–10
title text
body text
raw_data jsonb
created_at timestamptz
read boolean default false
```

Signal types: `price_move`, `volume_spike`, `options_unusual`, `dark_pool`, `insider_buy`,
`insider_sell`, `sec_filing`, `short_squeeze`, `earnings_upcoming`, `analyst_change`,
`congress_trade`, `technical`, `macro`, `sector_rotation`, `convergence`

### `snapshots`
```sql
id, ticker, price, volume, change_pct, market_cap, short_interest, iv_rank, created_at
```
Stored every 5 minutes during market hours.

### `push_subscriptions`
```sql
id, endpoint (unique), p256dh, auth, min_severity (default 7), created_at
```

---

## Workers (14 total on Railway)

All workers are Python FastAPI services in `workers/`. Each exports `run_once()` called by
`main.py` on a schedule (via `asyncio.create_task`).

| Worker file | What it does | Interval |
|---|---|---|
| `price_worker.py` | Polygon REST — price + volume snapshots | 5 min |
| `news_worker.py` | NewsAPI + Polygon news — breaking stories | 2 min |
| `sec_worker.py` | EDGAR RSS — insider filings, 8-Ks, 13Fs | 10 min |
| `options_worker.py` | Unusual Whales — sweeps >$25k, blocks >$50k, put/call skew | 5 min |
| `darkpool_worker.py` | Unusual Whales — dark pool prints >$1M, clusters >$5M | 5 min |
| `congress_worker.py` | Quiver Quantitative — STOCK Act disclosures | 6 hr |
| `squeeze_worker.py` | FINRA short volume + SEC FTD downloads | 1 hr |
| `technical_worker.py` | RSI, MACD, Bollinger, SMA 50/200, 52w high/low, VWAP | 15 min |
| `earnings_worker.py` | Earnings countdown (7/5/2/1 days) + historical move estimate | 1 hr |
| `analyst_worker.py` | Finnhub price targets + upgrade/downgrade waves | 1 hr |
| `macro_worker.py` | VIX, treasury yields (FRED), dollar (UUP) | 30 min |
| `sector_worker.py` | 11 SPDR ETF sector rotation detection | 1 hr |
| `sentiment_worker.py` | Reddit mention velocity per ticker | 15 min |
| `signal_engine.py` | Groq synthesis when ≥2 signal types on same ticker in 30 min, score ≥14 | 5 min |

### `workers/db.py`
Shared module. Key points:
- Use `supabase_admin` everywhere (service role key)
- `insert_signal()` returns the inserted row and fires a push notification (severity ≥ 8) via
  a daemon thread so it never blocks the event loop
- `_notify_push()` does a sync httpx POST to `NEXT_PUBLIC_APP_URL/api/push/notify` with
  `x-push-token: PUSH_NOTIFY_TOKEN`

### `workers/main.py`
- `WORKERS` dict maps name → module
- Generic `POST /trigger/{worker}` calls `WORKERS[worker].run_once()`
- `GET /health` lists any worker that hasn't run successfully in its expected interval

---

## Signal Convergence Engine (`signal_engine.py`)

The core intelligence. Single signal = noise. Multiple signals on same ticker in a short
window = real alert.

Weights per signal type:
```python
WEIGHTS = {
    'dark_pool':        8,
    'insider_buy':      9,
    'insider_sell':     9,
    'options_unusual':  8,
    'short_squeeze':    8,
    'congress_trade':   7,
    'volume_spike':     7,
    'technical':        5,
    'news_breaking':    5,
    'analyst_change':   6,
    'earnings_upcoming':5,
    'sentiment_spike':  4,
    'macro':            4,
    'sector_rotation':  3,
}
```

When ≥2 different signal types hit same ticker within 30 min AND total weight ≥14:
→ Groq `llama-3.3-70b` synthesis triggered (150 words max, trader-focused plain English)
→ `convergence` signal written to DB with severity = min(10, weight // 2)
→ Dashboard updates via Supabase Realtime

---

## Technical Indicators (`technical_worker.py`)

All computed in-house from Polygon `/v2/aggs` — no Alpha Vantage needed.

| Indicator | Logic |
|---|---|
| RSI | Wilder's smoothing, 14-period |
| MACD | EMA(12) − EMA(26), signal = EMA(9) of MACD. EMA seeded with SMA of first N values |
| Bollinger Bands | 20-period SMA ± 2 std dev |
| SMA 50 / SMA 200 | Golden cross / death cross detection |
| 52-week high/low | Breakout above 52w high = bullish signal |
| VWAP | (Σ price×volume) / Σ volume, reset daily |

Per-indicator cooldown dict prevents re-emitting the same setup more than once per day.

---

## Web Push Notifications

1. `public/sw.js` — service worker handles `push` event, shows notification
   - `requireInteraction: true` when severity ≥ 9
   - Click → focus existing tab or open new one
2. `app/api/push/subscribe/route.ts` — POST upserts subscription, DELETE removes it
3. `app/api/push/notify/route.ts` — called by workers; auth via `x-push-token` header;
   fetches subs where `min_severity ≤ signal.severity`; auto-removes expired (410) subs
4. `lib/web-push.ts` — wraps `web-push` npm package, lazy VAPID init

---

## Dashboard Features (`app/dashboard/DashboardClient.tsx`)

1. Real-time Supabase signal feed
2. Filter by signal type (multi-select)
3. Filter by severity threshold slider
4. Ticker search with URL sync (250ms debounce)
5. j/k keyboard navigation between signals
6. `o` to open focused signal detail
7. `r` to mark signal read
8. `p` to pin/unpin a ticker
9. `m` to mute a ticker
10. `x` to select signal, bulk actions (mark read, delete)
11. `a` to mark all read
12. `f` to force-trigger all workers
13. `+` to open QuickAddTicker modal
14. `?` to open KeyboardShortcutsHelp modal
15. `g d/s/p/w` two-key navigation shortcuts
16. Density toggle (compact / comfortable)
17. Sound alerts (WebAudio synth tone — no asset needed)
18. Web push toggle (PushToggle component)
19. Unread count in document title
20. Toast notifications for all user actions

---

## UI Rules

**Theme:** Dark terminal. Bloomberg, not Robinhood.
**Base:** `#0a0f1a`
**Accent/info:** `#0ea5e9`
**Bullish:** `#22c55e`
**Bearish:** `#ef4444`
**Warning:** `#f59e0b`
**High severity:** `#f97316` (orange pulse)

Severity color mapping:
- 9–10: red pulse — act now
- 7–8: orange — high priority
- 5–6: yellow — watch closely
- 1–4: blue — informational

Never use `transition-all`. Only animate `transform` and `opacity`.
Every clickable element needs hover + `focus-visible` states.

---

## Key Components

| File | Purpose |
|---|---|
| `app/components/SignalCard.tsx` | Signal display — density, pin, mute, select, expand |
| `app/components/AppShell.tsx` | Layout shell — wraps with ToastProvider |
| `app/components/Nav.tsx` | Sidebar nav with unread badge |
| `app/components/KeyboardShortcutsHelp.tsx` | `?` modal |
| `app/components/QuickAddTicker.tsx` | `+` modal — add ticker to watchlist |
| `app/components/Toaster.tsx` | Toast context + provider |
| `app/components/PushToggle.tsx` | Web push subscribe/unsubscribe UI |
| `app/hooks/useKeyboardShortcuts.ts` | Two-key sequence handler using mapRef pattern |
| `app/hooks/useLocalStorage.ts` | SSR-safe localStorage hook |
| `app/hooks/useDocumentTitle.ts` | Document title with unread count |

---

## Hard Rules

- Never auto-trade — signals only, human pulls the trigger
- Never expose `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`, or `PUSH_NOTIFY_TOKEN` client-side
- Rate limit all external APIs — respect free tier limits
- Cap Groq calls — only synthesize when ≥2 signals converge, never on every data point
- All times in Eastern (market time) — display converted from UTC
- Market hours awareness — workers should note pre-market (4–9:30 ET), regular (9:30–16:00), after-hours (16:00–20:00)
- Push notify endpoint is authenticated — always require `x-push-token` header

---

## File Naming Conventions

- Pages: `page.tsx`
- Client components with state: `[Feature]Client.tsx`
- Shared UI: `app/components/[Name].tsx`
- API routes: `app/api/[resource]/route.ts`
- Workers: `workers/[signal_type]_worker.py`

---

## Dashboard Pages

| Route | Purpose |
|---|---|
| `/dashboard` | Real-time signal feed |
| `/scanner` | Filter signals by type, sector, severity |
| `/portfolio` | Positions + P&L + per-ticker watchdog |
| `/watchlist` | Manage monitored tickers |
| `/signals/[id]` | Deep dive — full Groq analysis + raw data |

---

## Setup Order (from scratch)

1. `supabase-schema.sql` — create all tables + enable Realtime on `signals`
2. Copy auth + middleware from surfonly pattern
3. Deploy workers to Railway with all env vars
4. Verify `/health` endpoint shows all 14 workers alive
5. Set VAPID keys (`npx web-push generate-vapid-keys`)
6. Deploy Next.js to Vercel
7. Register service worker in browser — push toggle appears in dashboard

---

## Current Status

**All 14 workers built.** All dashboard features built. Push notifications wired end-to-end.
Next: swap in real API keys and do a live data test run.
