"""
Weekly Review Worker — runs Sunday at 6pm ET.

Two analyses:
1. Weekly pattern review — what setups worked/failed this week
2. Cross-ticker pattern mining — across ALL history, what signal combinations
   produce the highest win rate

Both get stored in prediction_lessons (ticker=GROQ_WEEKLY / GROQ_PATTERNS)
and injected into Monday morning's entry decisions.
"""
import logging
import asyncio
import httpx
from datetime import datetime, timezone, date, timedelta
from db import supabase, insert_signal
from market_hours import now_et, is_weekday

log = logging.getLogger("weekly_review_worker")

_last_review_date: date | None = None


async def _call_groq(prompt: str, max_tokens: int = 600) -> str | None:
    from groq_pool import call_llm
    return await call_llm(prompt, primary_env_vars=["GROQ_BACKUP_API_KEY"], max_tokens=max_tokens, temperature=0.2)


async def run_weekly_pattern_review() -> dict:
    """#6 — Review this week's trades and write a weekly thesis."""
    today = now_et().date()
    week_start = (today - timedelta(days=7)).isoformat()

    try:
        res = (
            supabase().table("sandbox_trades")
            .select("*")
            .eq("status", "closed")
            .gte("exit_date", week_start)
            .execute()
        )
        trades = res.data or []
    except Exception as e:
        return {"status": "error", "reason": str(e)}

    if len(trades) < 3:
        return {"status": "skipped", "reason": f"only {len(trades)} trades this week — not enough data"}

    wins = [t for t in trades if (t.get("pnl") or 0) > 0]
    losses = [t for t in trades if (t.get("pnl") or 0) < 0]
    gross_pnl = sum((t.get("pnl") or 0) for t in trades)
    win_rate = len(wins) / len(trades) * 100

    # Build trade summary
    lines = []
    for t in trades:
        outcome = "WIN" if (t.get("pnl") or 0) > 0 else "LOSS"
        signals = t.get("signals_at_entry") or []
        sig_str = "+".join(s.get("type", "?")[:8] for s in signals[:3])
        lines.append(
            f"[{outcome}] {t.get('ticker')} {(t.get('direction') or '').upper()} "
            f"conf={t.get('confidence_used', '?')} signals={sig_str or 'none'} "
            f"exit={t.get('exit_reason')} pnl={t.get('pnl_pct') or 0:+.1f}%"
        )
    trade_block = "\n".join(lines)

    prompt = f"""You are reviewing your paper trading performance for the week of {week_start} to {today}.

WEEK SUMMARY:
{len(wins)}W / {len(losses)}L — Win rate: {win_rate:.1f}% — Gross P&L: ${gross_pnl:+.2f}

ALL TRADES THIS WEEK:
{trade_block}

Write a focused weekly review:

**WHAT WORKED THIS WEEK**: Which setup types, signal combinations, or tickers produced wins? Be specific.

**WHAT FAILED**: What patterns keep showing up in the losses? Common exit reasons, sectors, timing?

**BEST SETUP THIS WEEK**: Describe the single best trade setup you took — what made it work?

**RULES FOR NEXT WEEK**: Give 3 specific rules based on this week's data. These will be fed into Monday's entry decisions.

Be specific — reference actual tickers, signal types, and percentages from the data above."""

    analysis = await _call_groq(prompt, max_tokens=600)
    if not analysis:
        return {"status": "error", "reason": "groq failed"}

    try:
        supabase().table("prediction_lessons").upsert({
            "ticker": "GROQ_WEEKLY",
            "date": today.isoformat(),
            "bias": "long" if gross_pnl >= 0 else "short",
            "actual_bias": "long" if win_rate >= 50 else "short",
            "in_range": win_rate >= 50,
            "lesson": analysis[:2000],
            "confidence_pct": int(win_rate),
            "key_factors": {
                "wins": len(wins), "losses": len(losses),
                "win_rate": round(win_rate, 1),
                "gross_pnl": round(gross_pnl, 2),
                "week_start": week_start,
                "source": "weekly_review",
            },
        }, on_conflict="ticker,date").execute()
    except Exception as e:
        log.error(f"Weekly review store failed: {e}")

    insert_signal(
        "GROQ_WEEKLY", "convergence", 6.0,
        f"Weekly Review {week_start} — {win_rate:.0f}% win rate",
        analysis[:1000],
        {"wins": len(wins), "losses": len(losses), "gross_pnl": round(gross_pnl, 2)},
    )

    log.info(f"Weekly review stored: {len(wins)}W/{len(losses)}L {win_rate:.1f}%")
    return {"status": "ok", "trades": len(trades), "win_rate": round(win_rate, 1)}


async def run_cross_ticker_pattern_mining() -> dict:
    """#7 — Mine ALL historical trades to find highest win-rate signal combos."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("ticker,direction,pnl,signals_at_entry,exit_reason,confidence_used,entry_date")
            .eq("status", "closed")
            .execute()
        )
        all_trades = res.data or []
    except Exception as e:
        return {"status": "error", "reason": str(e)}

    if len(all_trades) < 20:
        return {"status": "skipped", "reason": f"only {len(all_trades)} total trades — need 20+ for pattern mining"}

    def bucket_stats() -> tuple[str, str, str, str, str]:
        # Signal combo win rates
        combo_stats: dict[str, dict] = {}
        direction_stats: dict[str, dict] = {}
        trade_type_stats: dict[str, dict] = {}
        exit_stats: dict[str, dict] = {}
        confidence_buckets: dict[str, dict] = {}

        for t in all_trades:
            signals = t.get("signals_at_entry") or []
            is_win = (t.get("pnl") or 0) > 0
            direction = t.get("direction", "long")
            trade_type = t.get("trade_type", "day")
            reason = t.get("exit_reason", "unknown")
            conf = float(t.get("confidence_used") or 0)

            # Signal combos
            sig_types = sorted(set(s.get("type", "?") for s in signals[:3]))
            combo = "+".join(sig_types) if sig_types else "no_signals"
            key = f"{combo}:{direction}"
            combo_stats.setdefault(key, {"wins": 0, "total": 0})
            combo_stats[key]["total"] += 1
            if is_win: combo_stats[key]["wins"] += 1

            # Direction
            direction_stats.setdefault(direction, {"wins": 0, "total": 0})
            direction_stats[direction]["total"] += 1
            if is_win: direction_stats[direction]["wins"] += 1

            # Trade type
            trade_type_stats.setdefault(trade_type, {"wins": 0, "total": 0})
            trade_type_stats[trade_type]["total"] += 1
            if is_win: trade_type_stats[trade_type]["wins"] += 1

            # Exit reason
            exit_stats.setdefault(reason, {"wins": 0, "total": 0})
            exit_stats[reason]["total"] += 1
            if is_win: exit_stats[reason]["wins"] += 1

            # Confidence buckets
            cb = "high(80+)" if conf >= 80 else "med(65-79)" if conf >= 65 else "low(<65)"
            confidence_buckets.setdefault(cb, {"wins": 0, "total": 0})
            confidence_buckets[cb]["total"] += 1
            if is_win: confidence_buckets[cb]["wins"] += 1

        def fmt(d: dict, min_trades: int = 3) -> str:
            rows = [(k, v) for k, v in d.items() if v["total"] >= min_trades]
            rows.sort(key=lambda x: x[1]["wins"] / x[1]["total"], reverse=True)
            return "\n".join(f"  {k}: {v['wins']}/{v['total']} ({v['wins']/v['total']*100:.0f}% WR)" for k, v in rows) or "  Not enough data."

        qualified = {k: v for k, v in combo_stats.items() if v["total"] >= 5}
        sorted_combos = sorted(qualified.items(), key=lambda x: x[1]["wins"] / x[1]["total"], reverse=True)
        combo_block = "\n".join(f"  {k}: {v['wins']}/{v['total']} ({v['wins']/v['total']*100:.0f}% WR)" for k, v in sorted_combos[:12]) or "  Not enough data."

        return combo_block, fmt(direction_stats), fmt(trade_type_stats), fmt(exit_stats), fmt(confidence_buckets)

    combo_block, direction_block, type_block, exit_block, conf_block = bucket_stats()
    qualified_count = len([k for k, v in {}.items()])  # placeholder — recalculate below

    today = now_et().date()

    prompt = f"""You are analyzing ALL {len(all_trades)} historical sandbox trades to find actionable patterns.

SIGNAL COMBO WIN RATES (long/short, 5+ trades):
{combo_block}

DIRECTION WIN RATES:
{direction_block}

TRADE TYPE WIN RATES (day vs swing):
{type_block}

EXIT REASON WIN RATES:
{exit_block}

CONFIDENCE BUCKET WIN RATES:
{conf_block}

Based on this full statistical breakdown, write:

**HIGHEST WIN-RATE SETUPS**: Which specific combos, directions, and confidence levels are most profitable? Be specific with numbers.

**SETUPS TO AVOID**: What combinations, directions, or confidence levels are consistently losing?

**3 CONCRETE RULES FOR ENTRY DECISIONS**: Write 3 rules that DIRECTLY come from this data. Example: "Prefer swing over day trades — X% vs Y% WR." or "Skip short trades with confidence <70 — only Z% WR."

These rules will be injected into every future entry decision."""

    analysis = await _call_groq(prompt, max_tokens=500)
    if not analysis:
        return {"status": "skipped", "reason": "groq failed"}

    try:
        supabase().table("prediction_lessons").upsert({
            "ticker": "GROQ_PATTERNS",
            "date": today.isoformat(),
            "bias": "long",
            "actual_bias": "long",
            "in_range": True,
            "lesson": analysis[:2000],
            "confidence_pct": 80,
            "key_factors": {
                "total_trades": len(all_trades),
                "source": "pattern_mining",
            },
        }, on_conflict="ticker,date").execute()
    except Exception as e:
        log.error(f"Pattern mining store failed: {e}")

    log.info(f"Pattern mining complete: {len(all_trades)} trades, {len(qualified)} combos analyzed")
    return {"status": "ok", "trades_analyzed": len(all_trades), "combos": len(qualified)}


async def run_once() -> dict:
    et = now_et()
    today = et.date()

    # Only Sunday between 6-7pm ET
    is_sunday = today.weekday() == 6
    total_min = et.hour * 60 + et.minute
    in_window = 18 * 60 <= total_min < 19 * 60

    if not is_sunday or not in_window:
        return {"status": "skipped", "reason": "not Sunday 6-7pm ET"}

    global _last_review_date
    if _last_review_date == today:
        return {"status": "skipped", "reason": "already ran today"}
    _last_review_date = today

    weekly, patterns = await asyncio.gather(
        run_weekly_pattern_review(),
        run_cross_ticker_pattern_mining(),
    )
    return {"status": "ok", "weekly": weekly, "patterns": patterns}


async def main_loop():
    log.info("Weekly review worker started")
    while True:
        try:
            result = await run_once()
            if result["status"] == "ok":
                log.info(f"Weekly review: {result}")
        except Exception as e:
            log.error(f"Weekly review loop error: {e}")
        await asyncio.sleep(3600)  # check every hour
