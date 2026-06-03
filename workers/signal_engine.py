"""
Signal Engine — the brain of the operation.

Reads raw signals from all workers, detects ticker convergence (multiple signals same ticker
within 30 min), and uses Groq to synthesize a single high-severity convergence alert.

Single-signal noise stays in the feed unchanged. Multi-signal convergence is what we Groq-amplify.
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timedelta, timezone
from db import supabase, insert_signal

log = logging.getLogger("signal_engine")

GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile"


async def fetch_recent_signals(minutes: int = 30) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
    res = supabase().table("signals").select("*").gte("created_at", since).order("created_at", desc=True).execute()
    return res.data or []


def group_by_ticker(signals: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for s in signals:
        t = s.get("ticker", "").upper()
        if not t:
            continue
        # Exclude convergence signals from the input — they're our output, not input
        if s.get("signal_type") == "convergence":
            continue
        groups.setdefault(t, []).append(s)
    return groups


def already_synthesized(ticker: str, signal_ids: list[str]) -> bool:
    """Avoid re-Groqing the same convergence over and over."""
    res = supabase().table("signals").select("raw_data").eq("ticker", ticker.upper()).eq("signal_type", "convergence").order("created_at", desc=True).limit(1).execute()
    if not res.data:
        return False
    raw = res.data[0].get("raw_data") or {}
    prev_ids = set(raw.get("synthesized_from", []))
    new_ids = set(signal_ids)
    # If we already synthesized from a superset (>=80% overlap), skip
    if new_ids and len(prev_ids & new_ids) >= len(new_ids) * 0.8:
        return True
    return False


async def synthesize_with_groq(client: httpx.AsyncClient, ticker: str, signals: list[dict]) -> dict | None:
    if not GROQ_KEY:
        return None

    # Build context
    lines = [f"- [{s['signal_type']}, sev {s['severity']}] {s['title']}: {s['body']}" for s in signals]
    context = "\n".join(lines)
    total_score = sum(s["severity"] for s in signals)

    prompt = f"""You are a trading analyst. Multiple signals just fired on ticker {ticker} within 30 minutes:

{context}

Total convergence score: {total_score} across {len(signals)} signals.

Write a concise trader-focused synthesis in plain English. Max 100 words. No fluff, no hedging. Address:
1. What's likely happening (e.g. institutional accumulation, retail FOMO, pending catalyst)
2. The most important level or price point to watch
3. One specific risk to be aware of

Output format: 2-3 short paragraphs. No headers, no bullet points. Direct sentences only."""

    try:
        r = await client.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"},
            json={
                "model": GROQ_MODEL,
                "max_tokens": 400,
                "temperature": 0.3,
                "messages": [
                    {"role": "system", "content": "You are an experienced trader writing internal alerts. Direct, specific, never generic."},
                    {"role": "user", "content": prompt},
                ],
            },
            timeout=20,
        )
        if r.status_code != 200:
            log.warning(f"Groq {r.status_code}: {r.text[:200]}")
            return None
        content = r.json()["choices"][0]["message"]["content"].strip()
        return {"synthesis": content, "score": total_score}
    except Exception as e:
        log.error(f"Groq error for {ticker}: {e}")
        return None


async def run_once() -> dict:
    recent = await fetch_recent_signals(30)
    if not recent:
        return {"status": "ok", "convergences": 0}
    groups = group_by_ticker(recent)

    convergences = 0
    async with httpx.AsyncClient() as client:
        for ticker, sigs in groups.items():
            # Only synthesize on real convergence — different signal types matter more than count
            unique_types = {s["signal_type"] for s in sigs}
            # Skip if all signals are the same type or only 1 signal
            if len(sigs) < 2 or len(unique_types) < 2:
                continue
            # Skip if we already wrote a convergence for these signals
            sig_ids = [s["id"] for s in sigs]
            if already_synthesized(ticker, sig_ids):
                continue

            total_score = sum(s["severity"] for s in sigs)
            # Need at least score 14 to trigger Groq (cost control)
            if total_score < 14:
                continue

            result = await synthesize_with_groq(client, ticker, sigs)
            if not result:
                continue

            # Severity based on total score
            sev = min(10, 6 + int(total_score / 8))

            insert_signal(
                ticker,
                "convergence",
                sev,
                f"{ticker} — {len(sigs)} signals converging",
                result["synthesis"],
                {
                    "synthesized_from": sig_ids,
                    "total_score": total_score,
                    "signal_types": list(unique_types),
                },
            )
            convergences += 1

    return {"status": "ok", "convergences": convergences, "tickers_analyzed": len(groups)}


async def main_loop():
    log.info("Signal engine started")
    while True:
        try:
            result = await run_once()
            log.info(f"Signal engine tick: {result}")
        except Exception as e:
            log.error(f"Signal engine error: {e}")
        await asyncio.sleep(300)  # 5 min
