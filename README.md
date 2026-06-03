# StockBot

Real-time stock intelligence platform — Next.js dashboard + Python workers.

## Architecture

```
┌──────────────────────────┐
│   Next.js Dashboard      │ ← Vercel
│  Realtime signal feed    │
└────────────┬─────────────┘
             │
┌────────────▼─────────────┐
│       Supabase           │ ← DB + Realtime + Auth
│ signals · snapshots ·    │
│ news · watchlist ·       │
│ portfolio · alerts       │
└────────────▲─────────────┘
             │ writes
┌────────────┴─────────────┐
│  Python Worker Service   │ ← Railway
│                          │
│  price_worker            │
│  news_worker             │
│  sec_worker              │
│  reddit_worker           │
│  signal_engine (Groq)    │
└──────────────────────────┘
```

## Setup

### 1. Supabase

1. Create a new project at supabase.com
2. SQL editor → paste contents of `supabase-schema.sql` → Run
3. Database → Replication → enable Realtime on `signals` and `snapshots` tables
4. Authentication → Providers → enable Google OAuth
5. Authentication → URL Configuration → add your Vercel URL to redirect URLs

### 2. Vercel (Dashboard)

1. Push to GitHub
2. Import to Vercel
3. Env vars (from `.env.example`):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Deploy

### 3. Railway (Workers)

1. New project → from GitHub → select repo, root directory `/workers`
2. Env vars:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `POLYGON_API_KEY` (polygon.io)
   - `NEWS_API_KEY` (newsapi.org)
   - `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`
   - `GROQ_API_KEY` (groq.com)
   - `SEC_USER_AGENT` (your email — required by SEC)
3. Generate public domain
4. Health check: `GET /health`

## How signals work

Each worker writes raw signals to the `signals` table. The signal_engine reads recent signals (last 30 min), detects ticker convergence (2+ different signal types on same ticker), and uses Groq to write a high-severity convergence alert.

**Single signal = noise. Multiple signals on same ticker = real opportunity.**

### Signal types

| Type | Source | Base Severity |
|---|---|---|
| `price_move` | Polygon | 6-8 |
| `volume_spike` | Polygon | 7-9 |
| `news_breaking` | Polygon News + NewsAPI | 5-7 |
| `sec_filing` | SEC EDGAR | 6-7 |
| `sentiment_spike` | Reddit API | 5-7 |
| `convergence` | Groq synthesis | 8-10 |

## Manual triggers (testing)

Hit these endpoints on your Railway URL:

```
POST /trigger/price
POST /trigger/news
POST /trigger/sec
POST /trigger/reddit
POST /trigger/engine
```

## Cost estimate

| Service | Free tier | Realistic monthly |
|---|---|---|
| Vercel | ✓ | $0 |
| Supabase | ✓ | $0 |
| Railway | $5 credit | $5-10 |
| Polygon.io | 5 req/min | $29 paid tier recommended |
| NewsAPI | 100 req/day | $0 (or paid) |
| Groq | generous | $0-5 |
| Reddit | ✓ | $0 |

**Total to run seriously: ~$35-50/mo.**

## Local dev

```bash
npm install
cp .env.example .env.local
# Fill in Supabase keys
npm run dev
```

Workers (separate terminal):
```bash
cd workers
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## Status

Foundation complete. Add API keys and deploy.
