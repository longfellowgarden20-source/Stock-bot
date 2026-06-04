---
name: env-keys
description: Status of all API keys — what's set, what's missing, VAPID details
metadata:
  type: project
---

# Environment Keys Status

File: `/Users/surfs/Desktop/stock-bot/.env.local`

## Set ✅
- `NEXT_PUBLIC_SUPABASE_URL` = https://csenaxjndmfxgvleuqyo.supabase.co
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` = set (JWT, ref: csenaxjndmfxgvleuqyo, role: anon)
- `SUPABASE_SERVICE_ROLE_KEY` = set (JWT, ref: csenaxjndmfxgvleuqyo, role: service_role)
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` = BBgJ3Sedhx_QSJLxiBMe8xQYoRcToBYd59YBSIHjSPWRcnT1WXJqzWVIzHlPXdK7rm8ngvl_DsP1J_25qOcxxsc
- `VAPID_PRIVATE_KEY` = set
- `VAPID_SUBJECT` = mailto:robthebob2003@gmail.com
- `SEC_USER_AGENT` = StockBot robthebob2003@gmail.com

## Missing ❌ (need from user)
- `POLYGON_API_KEY` — polygon.io (critical — price, volume, technical workers)
- `GROQ_API_KEY` — groq.com (critical — signal engine convergence synthesis)
- `FINNHUB_API_KEY` — finnhub.io (earnings, analyst workers)
- `FRED_API_KEY` — fred.stlouisfed.org (macro worker — yields)
- `QUIVER_API_KEY` — quiverquant.com (congress worker)
- `PUSH_NOTIFY_TOKEN` — user-defined shared secret (workers → /api/push/notify)
- `NEXT_PUBLIC_APP_URL` — Vercel URL once deployed
- `WORKER_SERVICE_URL` — Railway URL once deployed

## Skip for now (paid/optional)
- `UNUSUAL_WHALES_API_KEY` — ~$50/mo, options flow + dark pool workers will skip without it
- `NEWS_API_KEY` — news worker fallback
- `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` — reddit/sentiment worker

**Why:** VAPID keys must never be regenerated once push subscriptions exist — browsers will break.
**How to apply:** Always check this before telling user what's needed. Don't ask for keys already set.
