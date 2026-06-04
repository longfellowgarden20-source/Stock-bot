"""
EOD Price Prediction Worker — runs at market open, synthesizes all available signals
for portfolio tickers into a directional bias + price range using Groq.

Stores predictions in `eod_predictions` table. At close, actual price is filled in
so accuracy can be tracked over time.

Fields per prediction:
  ticker, date, open_price, predicted_low, predicted_high,
  bias (bullish/bearish/neutral), confidence_pct, key_factors (list),
  invalidation_level, analysis (Groq text), actual_close, error_pct
"""
import os
import logging
import httpx
import asyncio
import json
from datetime import datetime, timezone, date, timedelta
from db import get_watchlist_tickers, supabase
from market_hours import is_market_hours

log = logging.getLogger("prediction_worker")

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

def _groq_keys() -> list[str]:
    keys = []
    seen = set()
    for name in ["GROQ_API_KEY", "GROQ_BACKUP_API_KEY"] + [f"GROQ_API_KEY_{i}" for i in range(2, 6)]:
        k = os.environ.get(name, "").strip()
        if k and k not in seen:
            keys.append(k)
            seen.add(k)
    return keys

# Only predict for portfolio tickers (positions you hold)
def get_portfolio_tickers() -> list[str]:
    try:
        res = supabase().table("portfolio").select("ticker").execute()
        return sorted({r["ticker"].upper() for r in (res.data or [])})
    except Exception as e:
        log.error(f"Failed to fetch portfolio tickers: {e}")
        return []


async def fetch_snapshot(client: httpx.AsyncClient, ticker: str) -> dict | None:
    """Latest price snapshot from Supabase."""
    try:
        res = supabase().table("snapshots").select("*").eq("ticker", ticker.upper()).order("created_at", desc=True).limit(1).execute()
        return res.data[0] if res.data else None
    except Exception as e:
        log.debug(f"Snapshot fetch failed for {ticker}: {e}")
        return None


async def fetch_recent_signals(ticker: str, hours: int = 24) -> list[dict]:
    """Recent signals for this ticker — feeds into Groq context."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        res = supabase().table("signals").select("signal_type,severity,title,body,created_at").eq("ticker", ticker.upper()).gte("created_at", since).order("severity", desc=True).limit(15).execute()
        return res.data or []
    except Exception as e:
        log.debug(f"Recent signals fetch failed for {ticker}: {e}")
        return []


async def fetch_daily_bars(client: httpx.AsyncClient, ticker: str, days: int = 30) -> list[dict]:
    """Recent daily bars for volatility and trend context."""
    if not POLYGON_KEY:
        return []
    today = date.today()
    start = (today - timedelta(days=days)).isoformat()
    end = today.isoformat()
    try:
        r = await client.get(
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker.upper()}/range/1/day/{start}/{end}",
            params={"apiKey": POLYGON_KEY, "limit": 30, "sort": "desc"},
            timeout=10,
        )
        if r.status_code != 200:
            return []
        return r.json().get("results", []) or []
    except Exception as e:
        log.debug(f"Daily bars failed for {ticker}: {e}")
        return []


def _avg_daily_range_pct(bars: list[dict]) -> float:
    """Average (high-low)/close % over recent bars — proxy for typical daily volatility."""
    ranges = []
    for b in bars[:10]:
        h, l, c = b.get("h", 0), b.get("l", 0), b.get("c", 1)
        if c > 0:
            ranges.append((h - l) / c * 100)
    return sum(ranges) / len(ranges) if ranges else 2.0


def _safe_float(val, default: float) -> float:
    if val is None:
        return float(default)
    try:
        return float(val)
    except (TypeError, ValueError):
        return float(default)


async def _call_groq(prompt: str) -> str | None:
    """Call Groq API, rotating through all available keys on 429/error."""
    for key in _groq_keys():
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(
                    GROQ_URL,
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json={
                        "model": "llama-3.3-70b-versatile",
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": 400,
                        "temperature": 0.3,
                    },
                )
                if r.status_code == 200:
                    return r.json()["choices"][0]["message"]["content"].strip()
                log.debug(f"Groq returned {r.status_code}: {r.text[:200]}")
        except Exception as e:
            log.debug(f"Groq call failed: {e}")
    return None


async def predict_ticker(client: httpx.AsyncClient, ticker: str) -> dict | None:
    """Build EOD prediction for one ticker. Returns the prediction row or None."""
    today_str = date.today().isoformat()

    # Dedup — only one prediction per ticker per day
    try:
        existing = supabase().table("eod_predictions").select("id").eq("ticker", ticker).eq("date", today_str).limit(1).execute()
        if existing.data:
            log.debug(f"Prediction already exists for {ticker} today")
            return None
    except Exception as e:
        log.debug(f"Dedup check failed for {ticker}: {e}")

    snapshot = await fetch_snapshot(client, ticker)
    bars = await fetch_daily_bars(client, ticker, days=30)
    signals = await fetch_recent_signals(ticker, hours=24)

    open_price = snapshot.get("price") if snapshot else None
    if not open_price and bars:
        open_price = bars[0].get("o") or bars[0].get("c")
    if not open_price:
        log.debug(f"No price available for {ticker} — skipping prediction")
        return None

    avg_range = _avg_daily_range_pct(bars)
    change_pct = snapshot.get("change_pct") if snapshot else None

    # Build signal summary for Groq
    signal_lines = []
    for s in signals:
        signal_lines.append(f"- [{s['signal_type']} sev={s['severity']}] {s['title']}")
    signal_summary = "\n".join(signal_lines) if signal_lines else "No recent signals."

    # Build price context
    price_context = f"Current price: ${open_price:.2f}"
    if change_pct is not None:
        price_context += f" ({change_pct:+.2f}% today so far)"
    if bars:
        closes = [b["c"] for b in bars if b.get("c")]
        if len(closes) >= 5:
            avg5 = sum(closes[:5]) / 5
            price_context += f". 5-day avg close: ${avg5:.2f}"
        if len(closes) >= 20:
            avg20 = sum(closes[:20]) / 20
            price_context += f". 20-day avg: ${avg20:.2f}"
    price_context += f". Avg daily range: {avg_range:.1f}%"

    prompt = f"""You are a professional equity analyst. Predict the end-of-day closing price for {ticker} today ({today_str}).

{price_context}

Recent signals (last 24h):
{signal_summary}

Respond ONLY with valid JSON in this exact format:
{{
  "bias": "bullish" | "bearish" | "neutral",
  "confidence_pct": <integer 30-85>,
  "predicted_low": <price as float>,
  "predicted_high": <price as float>,
  "invalidation_level": <price as float>,
  "key_factors": ["factor 1", "factor 2", "factor 3"],
  "analysis": "<2-3 sentence plain-English trader summary>"
}}

Rules:
- predicted_low and predicted_high form the expected close price range for today
- invalidation_level is the price where your bias flips (support for bullish, resistance for bearish)
- confidence_pct reflects signal strength — 30 = very uncertain, 85 = strong conviction
- key_factors: 3 specific reasons driving your prediction
- analysis: plain English, trader-focused, no fluff
- Base the range on typical daily volatility ({avg_range:.1f}% avg range) unless signals suggest an outlier move"""

    raw = await _call_groq(prompt)
    if not raw:
        return None

    # Parse JSON from Groq response
    try:
        # Strip markdown code fences if present
        text = raw.strip()
        if "```" in text:
            parts = text.split("```")
            # Take the content between first and second fence
            text = parts[1] if len(parts) >= 2 else text
            if text.startswith("json"):
                text = text[4:]
        parsed = json.loads(text.strip())
    except Exception as e:
        log.warning(f"Failed to parse Groq JSON for {ticker}: {e}\nRaw: {raw[:300]}")
        return None

    row = {
        "ticker": ticker.upper(),
        "date": today_str,
        "open_price": round(float(open_price), 4),
        "predicted_low": round(_safe_float(parsed.get("predicted_low"), open_price * 0.98), 4),
        "predicted_high": round(_safe_float(parsed.get("predicted_high"), open_price * 1.02), 4),
        "bias": parsed.get("bias", "neutral") if parsed.get("bias") in ("bullish", "bearish", "neutral") else "neutral",
        "confidence_pct": int(_safe_float(parsed.get("confidence_pct"), 50)),
        "key_factors": parsed.get("key_factors") if isinstance(parsed.get("key_factors"), list) else [],
        "invalidation_level": round(_safe_float(parsed.get("invalidation_level"), open_price), 4),
        "analysis": str(parsed.get("analysis", ""))[:800],
        "actual_close": None,
        "error_pct": None,
    }

    try:
        res = supabase().table("eod_predictions").insert(row).execute()
        if res.data:
            log.info(f"Prediction stored for {ticker}: {row['bias']} ${row['predicted_low']:.2f}–${row['predicted_high']:.2f}")
            return res.data[0]
    except Exception as e:
        log.error(f"Failed to store prediction for {ticker}: {e}")

    return None


async def fill_actual_closes() -> None:
    """At close (after 4pm ET), fill in actual_close for today's predictions."""
    today_str = date.today().isoformat()
    try:
        pending = supabase().table("eod_predictions").select("*").eq("date", today_str).is_("actual_close", "null").execute()
        if not pending.data:
            return
        for row in pending.data:
            ticker = row["ticker"]
            snapshot = supabase().table("snapshots").select("price").eq("ticker", ticker).order("created_at", desc=True).limit(1).execute()
            if not snapshot.data:
                continue
            actual = float(snapshot.data[0]["price"])
            open_p = float(row["open_price"]) if row["open_price"] else actual
            error_pct = ((actual - open_p) / open_p * 100) if open_p > 0 else None
            supabase().table("eod_predictions").update({
                "actual_close": round(actual, 4),
                "error_pct": round(error_pct, 2) if error_pct is not None else None,
            }).eq("id", row["id"]).execute()
            log.info(f"Filled actual close for {ticker}: ${actual:.2f} (predicted ${row['predicted_low']:.2f}–${row['predicted_high']:.2f})")
    except Exception as e:
        log.error(f"fill_actual_closes failed: {e}")


def _is_market_open_et() -> bool:
    """True if current time is between 9:15am and 10:00am ET — the prediction window."""
    try:
        import zoneinfo
        et = datetime.now(zoneinfo.ZoneInfo("America/New_York"))
    except Exception:
        from datetime import timezone as tz
        utc = datetime.now(tz.utc)
        et_hour = (utc.hour - 4) % 24
        return 9 <= et_hour < 10
    return et.hour == 9 and 15 <= et.minute < 60


def _is_after_close_et() -> bool:
    """True if after 4pm ET — fill actual closes."""
    try:
        import zoneinfo
        et = datetime.now(zoneinfo.ZoneInfo("America/New_York"))
        return et.hour >= 16
    except Exception:
        from datetime import timezone as tz
        utc = datetime.now(tz.utc)
        et_hour = (utc.hour - 4) % 24
        return et_hour >= 16


async def run_once() -> dict:
    if not _groq_keys():
        return {"status": "skipped", "reason": "no GROQ_API_KEY"}

    # After close — fill actual prices
    if _is_after_close_et():
        await fill_actual_closes()
        return {"status": "ok", "action": "filled_actuals"}

    # Only generate predictions near open (9:15–10am ET)
    if not _is_market_open_et():
        return {"status": "skipped", "reason": "outside prediction window"}

    tickers = get_portfolio_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no portfolio tickers"}

    predictions = []
    async with httpx.AsyncClient() as client:
        for ticker in tickers:
            try:
                pred = await predict_ticker(client, ticker)
                if pred:
                    predictions.append(ticker)
            except Exception as e:
                log.error(f"Prediction failed for {ticker}: {e}")
            await asyncio.sleep(2)  # rate limit Groq

    return {"status": "ok", "predicted": predictions}


async def main_loop():
    log.info("Prediction worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Prediction tick: {result}")
        except Exception as e:
            log.error(f"Prediction loop error: {e}")
        await asyncio.sleep(1800)  # check every 30 min — only acts during window
