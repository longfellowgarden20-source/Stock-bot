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
from datetime import datetime, timedelta, timezone, date
from db import supabase, insert_signal
from market_hours import now_et, is_weekday

log = logging.getLogger("signal_engine")

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
    from groq_pool import call_llm

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

    content = await call_llm(
        prompt,
        max_tokens=400,
        temperature=0.3,
        model=GROQ_MODEL,
        system="You are an experienced trader writing internal alerts. Direct, specific, never generic.",
    )
    if not content:
        return None
    return {"synthesis": content, "score": total_score}

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

    # Daily recap at 4:15–4:20 PM ET, weekdays only — runs inside run_once so main.py loop picks it up
    et = now_et()
    if is_weekday() and et.hour == 16 and 15 <= et.minute < 20:
        try:
            recap_result = await daily_recap()
            log.info(f"Daily recap: {recap_result}")
        except Exception as recap_err:
            log.error(f"Daily recap error: {recap_err}")

    return {"status": "ok", "convergences": convergences, "tickers_analyzed": len(groups)}


_recap_last_date: date | None = None


async def daily_recap() -> dict:
    """
    Runs once at 4:15 PM ET after market close.
    Fetches today's signals, picks top 5 tickers by total severity, asks Groq for
    a 150-word plain-English recap, writes a MARKET convergence signal.
    """
    global _recap_last_date
    today = now_et().date()
    if _recap_last_date == today:
        return {"status": "skipped", "reason": "already ran today"}
    # Mark immediately so a retry in the same 5-min window doesn't double-fire
    _recap_last_date = today

    # Fetch all signals from the last 10 hours (covers the full trading day)
    since = (datetime.now(timezone.utc) - timedelta(hours=10)).isoformat()
    res = supabase().table("signals").select("*").gte("created_at", since).order("created_at", desc=True).execute()
    signals = res.data or []

    # Filter out convergence / MARKET signals so we don't recurse
    signals = [s for s in signals if s.get("signal_type") != "convergence" and s.get("ticker") != "MARKET"]
    if not signals:
        return {"status": "skipped", "reason": "no signals today"}

    # Group by ticker, sum severity
    by_ticker: dict[str, list[dict]] = {}
    for s in signals:
        t = s.get("ticker", "").upper()
        if not t:
            continue
        by_ticker.setdefault(t, []).append(s)

    # Top 5 tickers by total severity
    ranked = sorted(by_ticker.items(), key=lambda kv: sum(x["severity"] for x in kv[1]), reverse=True)[:5]
    if not ranked:
        return {"status": "skipped", "reason": "no tickers"}

    # Build context for Groq
    lines = []
    for ticker, sigs in ranked:
        total_sev = sum(s["severity"] for s in sigs)
        types = list({s["signal_type"] for s in sigs})
        titles = [s["title"] for s in sigs[:3]]
        lines.append(f"- {ticker} (total severity {total_sev}, types: {', '.join(types)}): {'; '.join(titles)}")
    context = "\n".join(lines)

    date_str = today.strftime("%B %d, %Y")
    prompt = f"""You are a trading analyst writing a daily recap for {date_str}. Here are the top 5 tickers by signal activity today:

{context}

Write a plain-English daily recap in 150 words or less. Cover:
1. The standout tickers and what drove their activity
2. Any sector or macro themes worth noting
3. One key thing to watch tomorrow

No bullet points. Direct sentences. Trader-focused."""

    from groq_pool import call_llm
    try:
        content = await call_llm(
            prompt,
            max_tokens=350,
            temperature=0.3,
            model=GROQ_MODEL,
            system="You are an experienced trader writing end-of-day internal recaps. Direct, specific, never generic.",
        )
    except Exception as e:
        log.error(f"Daily recap Groq error: {e}")
        return {"status": "error", "reason": str(e)}

    if not content:
        return {"status": "skipped", "reason": "Groq returned empty response"}

    tickers_covered = [t for t, _ in ranked]
    insert_signal(
        "MARKET",
        "convergence",
        6,
        f"Daily Market Recap — {date_str}",
        content,
        {
            "recap_type": "daily",
            "tickers_covered": tickers_covered,
            "signals_analyzed": len(signals),
            "date": today.isoformat(),
        },
    )
    log.info(f"Daily recap written for {date_str}, tickers: {tickers_covered}")
    return {"status": "ok", "tickers": tickers_covered}


async def main_loop():
    log.info("Signal engine started")
    while True:
        try:
            result = await run_once()
            log.info(f"Signal engine tick: {result}")

            # Daily recap at 4:15 PM ET (16:15), weekdays only
            et = now_et()
            if is_weekday() and et.hour == 16 and et.minute >= 15 and et.minute < 20:
                recap_result = await daily_recap()
                log.info(f"Daily recap: {recap_result}")
        except Exception as e:
            log.error(f"Signal engine error: {e}")
        await asyncio.sleep(300)  # 5 min
