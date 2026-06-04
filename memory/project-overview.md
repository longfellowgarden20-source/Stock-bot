---
name: project-overview
description: Full architecture, stack, workers, signal types, deploy targets for stock-bot
metadata:
  type: project
---

# Stock Intelligence Bot — Full Project Overview

**Purpose:** Real-time stock signal platform. NOT a trade executor. Surfaces signals, human decides.
Two functions: Opportunity Scanner + Portfolio Watchdog.

## Stack
- **Frontend:** Next.js 15 App Router + TypeScript, Tailwind CSS v4, dark terminal theme (#0a0f1a base)
- **Database:** Supabase (Postgres + Realtime on `signals` and `snapshots` tables)
- **Workers:** Python FastAPI — all in `workers/`, deployed to Railway
- **AI:** Groq `llama-3.3-70b-versatile` for convergence synthesis, `llama-3.1-8b-instant` for fast
- **Auth:** Supabase Google OAuth, single user, protected by `middleware.ts`
- **Push:** Web Push API (VAPID), service worker at `public/sw.js`

## Database Tables
- `watchlist` — ticker, name, sector, notes, alert_threshold_pct, **pinned**, **muted**, added_at
- `portfolio` — ticker, shares, avg_cost, notes, added_at
- `signals` — id, ticker, signal_type, severity (1-10), title, body, raw_data jsonb, read, created_at
- `snapshots` — ticker, price, volume, change_pct, market_cap, short_interest, iv_rank, created_at
- `news` — ticker, headline, source, url, sentiment, published_at, created_at
- `alerts` — ticker, condition, threshold, triggered_at, notified, created_at
- `push_subscriptions` — endpoint (unique), p256dh, auth, user_agent, min_severity (default 7)

Realtime enabled on `signals` and `snapshots`.

## Workers (all in workers/, deployed as one FastAPI service on Railway)
| Worker | File | Interval | Key API |
|---|---|---|---|
| price_worker | price_worker.py | 5 min (extended hours) | Polygon |
| news_worker | news_worker.py | 2 min | NewsAPI + Polygon news |
| sec_worker | sec_worker.py | 10 min | SEC EDGAR RSS |
| options_worker | options_worker.py | 5 min | Unusual Whales |
| darkpool_worker | darkpool_worker.py | 5 min | Unusual Whales |
| congress_worker | congress_worker.py | 6 hr | Quiver Quantitative |
| squeeze_worker | squeeze_worker.py | 1 hr | FINRA + SEC EDGAR |
| technical_worker | technical_worker.py | 15 min | Polygon aggregates |
| earnings_worker | earnings_worker.py | 1 hr | Finnhub |
| analyst_worker | analyst_worker.py | 1 hr | Finnhub |
| macro_worker | macro_worker.py | 30 min | Polygon (VIX, ETFs) + FRED |
| sector_worker | sector_worker.py | 1 hr | Polygon SPDR ETFs |
| reddit_worker | reddit_worker.py | 15 min | Reddit API |
| signal_engine | signal_engine.py | 5 min | Groq |

`main.py` — FastAPI entry point, starts all workers via `asyncio.create_task`. Exposes `GET /health` and `POST /trigger/{worker}`.

`db.py` — shared Supabase client (service role), `get_watchlist_tickers()`, `insert_signal()`, `insert_snapshot()`, `insert_news()`. Push notifications fire via daemon thread for severity >= 8.

`market_hours.py` — ET timezone utils: `is_market_hours()`, `is_pre_market()`, `is_after_hours()`, `is_extended_hours()`.

## Signal Engine (signal_engine.py)
Core intelligence. Detects convergence: ≥2 different signal types on same ticker within 30 min AND total severity score ≥14. Calls Groq to synthesize 100-word trader-focused alert. Writes `convergence` signal. Uses 80% overlap dedup check to avoid re-Groqing same set.

Signal weights: dark_pool=8, insider_buy/sell=9, options_unusual=8, short_squeeze=8, congress_trade=7, volume_spike=7, technical=5, news_breaking=5, analyst_change=6, earnings_upcoming=5, sentiment_spike=4, macro=4, sector_rotation=3.

## Frontend Pages
- `/dashboard` — DashboardClient.tsx — real-time signal feed
- `/scanner` — ScannerClient.tsx
- `/portfolio` — PortfolioClient.tsx
- `/watchlist` — WatchlistClient.tsx
- `/signals/[id]` — deep dive + raw data

## Dashboard Features (DashboardClient.tsx)
Realtime Supabase subscription, filter by type/severity/time, search with URL sync, j/k nav, o=open, r=read, p=pin, m=mute, x=select, a=mark all read, f=force scan, +=QuickAddTicker, ?=help modal, g d/s/p/w nav, density toggle, sound alerts (WebAudio), push toggle, unread count in title, toasts.

Pinned/muted state stored in localStorage (not DB). Convergence signals get a featured strip at top.

## Key Components
- `SignalCard.tsx` — severity-colored cards, pin/mute/expand/select
- `AppShell.tsx` — wraps with ToastProvider
- `Nav.tsx` — sidebar with unread badge
- `KeyboardShortcutsHelp.tsx` — ? modal
- `QuickAddTicker.tsx` — + modal
- `Toaster.tsx` — toast context
- `PushToggle.tsx` — web push subscribe/unsubscribe
- `hooks/useKeyboardShortcuts.ts` — two-key sequence handler
- `hooks/useLocalStorage.ts` — SSR-safe
- `hooks/useDocumentTitle.ts`

## API Routes
- `app/api/refresh/route.ts` — POST triggers all workers via WORKER_SERVICE_URL
- `app/api/signals/route.ts` — GET/PATCH signals
- `app/api/push/notify/route.ts` — called by workers (x-push-token auth)
- `app/api/push/subscribe/route.ts` — POST/DELETE subscriptions
- `app/api/watchlist/route.ts`
- `app/api/portfolio/route.ts`

## UI Rules
Dark terminal. Base #0a0f1a. Accent #0ea5e9. Bullish #22c55e. Bearish #ef4444. Warning #f59e0b. High sev #f97316.
Never use transition-all. Only animate transform and opacity.
Severity: 9-10=red pulse, 7-8=orange, 5-6=yellow, 1-4=blue.

## Deploy
- Frontend → Vercel
- Workers → Railway (single service, all 14 workers in one process)
- `workers/railway.toml` + `workers/Dockerfile` already present

## Current Status
All 14 workers built. All dashboard features built. Push notifications wired. Schema deployed to Supabase. Realtime enabled. Currently adding API keys to .env.local before live test.

**Why:** This is a live trading intelligence tool. The user actively trades and wants real signals, not toy data.
**How to apply:** Always treat this as production-grade. Rate limits matter. Never mock data in workers. Signal quality > signal quantity.
