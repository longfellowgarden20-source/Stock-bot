# Railway Environment Setup — Finnhub Load Balancing

## Add These 2 Keys to Railway (3 minutes)

### Key 1: Already Set
- Variable: `FINNHUB_API_KEY`
- Value: [Already configured]
- Email: robthebob2003@gmail.com

### Key 2: ADD NOW
- Variable: `FINNHUB_API_KEY_2`
- Value: `d8i4nm9r01qm63b9t5bgd8i4nm9r01qm63b9t5c0`
- Email: blackgio@gmail.com

### Key 3: ADD NOW
- Variable: `FINNHUB_API_KEY_3`
- Value: `d8i4p5hr01qm63b9tdn0d8i4p5hr01qm63b9tdng`
- Email: riley@gmail.com

## Steps

1. Go to Railway dashboard: https://railway.app/project/[project-id]
2. Select `stock-bot` service
3. Click **Variables** tab
4. Click **New Variable**
5. Enter:
   - Name: `FINNHUB_API_KEY_2`
   - Value: `d8i4nm9r01qm63b9t5bgd8i4nm9r01qm63b9t5c0`
6. Save
7. Repeat for `FINNHUB_API_KEY_3` with: `d8i4p5hr01qm63b9tdn0d8i4p5hr01qm63b9tdng`
8. **Redeploy** (Railway will auto-redeploy or manually trigger redeploy)

## What Happens After

- Price worker gets 3 Finnhub keys (180 calls/min total)
- Polygon rate limit no longer blocks trading
- Sandbox can enter trades continuously
- Fallback chain: Polygon → Finnhub Key 1 → Finnhub Key 2 → Finnhub Key 3 → Yahoo

## Cost

**$0** — All free tier with different email accounts
