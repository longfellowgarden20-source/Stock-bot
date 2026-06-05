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

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

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
    from groq_pool import call_llm
    return await call_llm(prompt, primary_env_vars=["GROQ_BACKUP_API_KEY"], max_tokens=400, temperature=0.3)


async def predict_ticker(client: httpx.AsyncClient, ticker: str) -> dict | None:
    """Build EOD prediction for one ticker, injecting past lessons to improve accuracy."""
    today_str = date.today().isoformat()

    # Dedup — only one prediction per ticker per day
    try:
        existing = supabase().table("eod_predictions").select("id").eq("ticker", ticker).eq("date", today_str).limit(1).execute()
        if existing.data:
            log.debug(f"Prediction already exists for {ticker} today")
            return None
    except Exception as e:
        log.debug(f"Dedup check failed for {ticker}: {e}")

    # Fetch all context concurrently
    snapshot_task = fetch_snapshot(client, ticker)
    bars_task = fetch_daily_bars(client, ticker, days=30)
    signals_task = fetch_recent_signals(ticker, hours=24)
    lessons_task = fetch_lessons(ticker, limit=8)

    snapshot, bars, signals, lessons = await asyncio.gather(
        snapshot_task, bars_task, signals_task, lessons_task,
        return_exceptions=True,
    )
    # Handle any gather exceptions gracefully
    if isinstance(snapshot, Exception): snapshot = None
    if isinstance(bars, Exception): bars = []
    if isinstance(signals, Exception): signals = []
    if isinstance(lessons, Exception): lessons = []

    open_price = snapshot.get("price") if snapshot else None
    if not open_price and bars:
        open_price = bars[0].get("o") or bars[0].get("c")
    if not open_price:
        log.debug(f"No price available for {ticker} — skipping prediction")
        return None

    avg_range = _avg_daily_range_pct(bars)
    change_pct = snapshot.get("change_pct") if snapshot else None

    # Build signal summary
    signal_lines = [f"- [{s['signal_type']} sev={s['severity']}] {s['title']}" for s in signals]
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

    # Build lessons block — this is the key improvement over vanilla predictions
    lessons_block = ""
    if lessons:
        lesson_lines = []
        correct_count = sum(1 for l in lessons if l.get("in_range") and l.get("bias") == l.get("actual_bias"))
        lesson_lines.append(f"Your last {len(lessons)} predictions for {ticker}: {correct_count}/{len(lessons)} correct.")
        for l in lessons:
            status = "✓ CORRECT" if (l.get("in_range") and l.get("bias") == l.get("actual_bias")) else "✗ WRONG"
            lesson_lines.append(f"- {l['date']} [{status}] predicted {l.get('bias')}, actual {l.get('actual_bias')}, confidence {l.get('confidence_pct')}%")
            if l.get("lesson") and "Correct prediction" not in l["lesson"]:
                lesson_lines.append(f"  Lesson: {l['lesson'][:200]}")
        lessons_block = "\nYour past prediction history and self-critiques for this ticker:\n" + "\n".join(lesson_lines)

    prompt = f"""You are a professional equity analyst. Predict the end-of-day closing price for {ticker} today ({today_str}).

{price_context}

Recent signals (last 24h):
{signal_summary}
{lessons_block}

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
- Base the range on typical daily volatility ({avg_range:.1f}% avg range) unless signals suggest an outlier move
- Use your past lessons to avoid repeating the same mistakes — if you were consistently wrong on this ticker, adjust confidence accordingly"""

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


async def fetch_lessons(ticker: str, limit: int = 8) -> list[dict]:
    """Fetch recent lessons for this ticker to inject into the prediction prompt."""
    try:
        res = (
            supabase().table("prediction_lessons")
            .select("date,bias,actual_bias,in_range,lesson,confidence_pct")
            .eq("ticker", ticker.upper())
            .order("date", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.debug(f"Lessons fetch failed for {ticker}: {e}")
        return []


def _actual_bias(open_price: float, actual_close: float) -> str:
    """Determine actual direction from open to close."""
    if actual_close > open_price * 1.005:
        return "bullish"
    if actual_close < open_price * 0.995:
        return "bearish"
    return "neutral"


async def generate_lesson(pred: dict, actual_close: float) -> str | None:
    """Ask Groq to self-critique a wrong/low-confidence prediction."""
    ticker = pred["ticker"]
    predicted_low = float(pred.get("predicted_low") or 0)
    predicted_high = float(pred.get("predicted_high") or 0)
    bias = pred.get("bias", "neutral")
    actual_bias = _actual_bias(float(pred.get("open_price") or actual_close), actual_close)
    in_range = predicted_low <= actual_close <= predicted_high if predicted_low and predicted_high else False
    key_factors = pred.get("key_factors") or []

    # Only generate lessons for wrong predictions — saves Groq calls
    bias_wrong = bias != actual_bias
    range_missed = not in_range
    if not bias_wrong and not range_missed:
        return "Correct prediction — bias and range both accurate."

    factors_str = "\n".join(f"- {f}" for f in key_factors) if key_factors else "No factors recorded."

    prompt = f"""You are reviewing your own stock prediction for {ticker} to learn from your mistake.

Your prediction:
- Bias: {bias}
- Predicted range: ${predicted_low:.2f}–${predicted_high:.2f}
- Key factors you cited:
{factors_str}

What actually happened:
- Actual close: ${actual_close:.2f}
- Actual direction: {actual_bias}
- Was actual price in your predicted range? {"Yes" if in_range else "No"}
- Bias correct? {"Yes" if not bias_wrong else "No"}

Write a 2-3 sentence self-critique:
1. What did you get wrong and why?
2. What signal or factor did you miss or overweight?
3. What should you watch for next time with {ticker}?

Be specific. No generic statements. Focus on what would actually improve the next prediction."""

    return await _call_groq(prompt)


async def fill_actual_closes() -> None:
    """At close (after 4pm ET): fill actual_close, compute accuracy, generate lessons."""
    today_str = date.today().isoformat()
    try:
        pending = (
            supabase().table("eod_predictions")
            .select("*")
            .eq("date", today_str)
            .is_("actual_close", "null")
            .execute()
        )
        if not pending.data:
            return

        for row in pending.data:
            ticker = row["ticker"]
            snapshot = (
                supabase().table("snapshots")
                .select("price")
                .eq("ticker", ticker)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            if not snapshot.data:
                continue

            actual = float(snapshot.data[0]["price"])
            open_p = float(row["open_price"]) if row["open_price"] else actual
            # error_pct: how far actual close moved from open (market reality, not prediction quality)
            error_pct = ((actual - open_p) / open_p * 100) if open_p > 0 else None

            # Determine if prediction was correct
            pred_low = float(row.get("predicted_low") or 0)
            pred_high = float(row.get("predicted_high") or 0)
            in_range = pred_low <= actual <= pred_high if pred_low and pred_high else False
            actual_b = _actual_bias(open_p, actual)

            # Update the prediction row
            supabase().table("eod_predictions").update({
                "actual_close": round(actual, 4),
                "error_pct": round(error_pct, 2) if error_pct is not None else None,
            }).eq("id", row["id"]).execute()

            log.info(f"Filled actual close for {ticker}: ${actual:.2f} predicted ${pred_low:.2f}–${pred_high:.2f} {'✓' if in_range else '✗'}")

            # Generate and store a lesson — always, but lesson text differs for right vs wrong
            await _store_lesson(row, actual, in_range, actual_b)
            await asyncio.sleep(2)  # rate-limit Groq lesson calls

    except Exception as e:
        log.error(f"fill_actual_closes failed: {e}")


async def _store_lesson(pred: dict, actual_close: float, in_range: bool, actual_bias: str) -> None:
    """Generate Groq lesson and write to prediction_lessons table."""
    ticker = pred["ticker"]
    today_str = pred["date"]

    # Dedup — don't re-generate if lesson already exists
    try:
        existing = supabase().table("prediction_lessons").select("id").eq("ticker", ticker).eq("date", today_str).limit(1).execute()
        if existing.data:
            return
    except Exception:
        pass

    lesson_text = await generate_lesson(pred, actual_close)
    if not lesson_text:
        lesson_text = "Lesson generation failed — no Groq response."

    try:
        supabase().table("prediction_lessons").insert({
            "ticker": ticker.upper(),
            "date": today_str,
            "bias": pred.get("bias"),
            "actual_bias": actual_bias,
            "in_range": in_range,
            "predicted_low": pred.get("predicted_low"),
            "predicted_high": pred.get("predicted_high"),
            "actual_close": round(actual_close, 4),
            "confidence_pct": pred.get("confidence_pct"),
            "lesson": lesson_text[:1000],
            "key_factors": pred.get("key_factors"),
        }).execute()
        log.info(f"Lesson stored for {ticker} ({today_str}): {'correct' if in_range and pred.get('bias') == actual_bias else 'wrong'}")
    except Exception as e:
        log.error(f"Failed to store lesson for {ticker}: {e}")


def _is_market_open_et() -> bool:
    """True if current time is between 9:15am and 10:30am ET — the prediction window."""
    try:
        import zoneinfo
        et = datetime.now(zoneinfo.ZoneInfo("America/New_York"))
        total = et.hour * 60 + et.minute
    except Exception:
        from datetime import timezone as tz
        utc = datetime.now(tz.utc)
        total = (utc.hour * 60 + utc.minute - 240) % (24 * 60)  # subtract 4h for ET
    return 9 * 60 + 15 <= total <= 10 * 60 + 30


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
    from groq_pool import _load_keys
    if not _load_keys(["GROQ_BACKUP_API_KEY"]):
        return {"status": "skipped", "reason": "no GROQ keys available"}

    # After close — fill actual prices and generate lessons
    if _is_after_close_et():
        await fill_actual_closes()
        return {"status": "ok", "action": "filled_actuals_and_lessons"}

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
