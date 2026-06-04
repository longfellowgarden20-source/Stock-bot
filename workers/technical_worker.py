"""
Technical Signals Worker — RSI, MACD, Bollinger, moving averages, VWAP, 52-week highs.

Pulls daily aggregates from Polygon (we already pay for this data) and computes
classical technical indicators. Emits signals only on strong setups, not every reading.

Indicators:
- RSI 14 → oversold (<30) or overbought (>70)
- MACD → bullish/bearish crossover within last 2 days
- Bollinger Bands 20,2 → price breaking out above upper or below lower
- 50/200 SMA → golden cross / death cross
- 52-week high/low → new highs or lows
- VWAP deviation → intraday close > 2% above/below VWAP
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone, timedelta, date
from db import get_watchlist_tickers, insert_signal
from market_hours import is_market_hours

log = logging.getLogger("technical_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

# Cooldown — don't re-emit the same technical signal more than once per day per ticker
_signal_cooldown: dict[str, float] = {}  # f"{ticker}-{signal}" -> ts
_COOLDOWN_SEC = 86400


def _on_cooldown(ticker: str, kind: str) -> bool:
    key = f"{ticker}-{kind}"
    last = _signal_cooldown.get(key, 0)
    return (datetime.now(timezone.utc).timestamp() - last) < _COOLDOWN_SEC


def _mark(ticker: str, kind: str) -> None:
    _signal_cooldown[f"{ticker}-{kind}"] = datetime.now(timezone.utc).timestamp()


async def fetch_daily_bars(client: httpx.AsyncClient, ticker: str, days: int = 365) -> list[dict]:
    """Polygon daily aggregates. Returns chronological ascending list."""
    if not POLYGON_KEY:
        return []
    today = date.today()
    start = (today - timedelta(days=days)).isoformat()
    end = today.isoformat()
    url = f"{POLYGON_BASE}/v2/aggs/ticker/{ticker.upper()}/range/1/day/{start}/{end}"
    try:
        r = await client.get(url, params={"apiKey": POLYGON_KEY, "limit": 500, "sort": "asc"}, timeout=15)
        if r.status_code != 200:
            return []
        return r.json().get("results", []) or []
    except Exception as e:
        log.error(f"Daily bars fetch failed for {ticker}: {e}")
        return []


async def fetch_intraday_bars(client: httpx.AsyncClient, ticker: str) -> list[dict]:
    """Today's minute bars for VWAP calc."""
    if not POLYGON_KEY:
        return []
    today = date.today().isoformat()
    url = f"{POLYGON_BASE}/v2/aggs/ticker/{ticker.upper()}/range/5/minute/{today}/{today}"
    try:
        r = await client.get(url, params={"apiKey": POLYGON_KEY, "limit": 200, "sort": "asc"}, timeout=15)
        if r.status_code != 200:
            return []
        return r.json().get("results", []) or []
    except Exception as e:
        log.error(f"Intraday bars fetch failed for {ticker}: {e}")
        return []


# --- Indicator math ---

def sma(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def ema_series(values: list[float], period: int) -> list[float]:
    """Returns EMA at each index where it can be computed (len = len(values) - period + 1)."""
    if len(values) < period:
        return []
    k = 2 / (period + 1)
    # Seed with SMA of first `period` values
    seed = sum(values[:period]) / period
    out = [seed]
    for v in values[period:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, period + 1):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period

    for i in range(period + 1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gain = max(diff, 0)
        loss = max(-diff, 0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def macd(closes: list[float]) -> tuple[float, float, float] | None:
    """Returns (macd_line_latest, signal_latest, histogram_latest)."""
    if len(closes) < 35:
        return None
    ema12 = ema_series(closes, 12)
    ema26 = ema_series(closes, 26)
    # Align — ema26 starts later
    offset = len(ema12) - len(ema26)
    if offset < 0:
        return None
    macd_line = [ema12[i + offset] - ema26[i] for i in range(len(ema26))]
    if len(macd_line) < 9:
        return None
    signal_line = ema_series(macd_line, 9)
    if not signal_line:
        return None
    hist = macd_line[-1] - signal_line[-1]
    return macd_line[-1], signal_line[-1], hist


def macd_crossover(closes: list[float]) -> str | None:
    """Detect a fresh crossover in the last 2 bars. Returns 'bullish', 'bearish', or None."""
    if len(closes) < 36:
        return None
    # Recompute for last 2 bars
    today_macd = macd(closes)
    yest_macd = macd(closes[:-1])
    if not today_macd or not yest_macd:
        return None
    today_diff = today_macd[0] - today_macd[1]
    yest_diff = yest_macd[0] - yest_macd[1]
    if yest_diff <= 0 < today_diff:
        return "bullish"
    if yest_diff >= 0 > today_diff:
        return "bearish"
    return None


def bollinger(closes: list[float], period: int = 20, mult: float = 2.0) -> tuple[float, float, float] | None:
    """Returns (lower, mid, upper)."""
    if len(closes) < period:
        return None
    window = closes[-period:]
    mid = sum(window) / period
    var = sum((x - mid) ** 2 for x in window) / period
    sd = var ** 0.5
    return mid - mult * sd, mid, mid + mult * sd


def vwap_from_bars(bars: list[dict]) -> float | None:
    if not bars:
        return None
    total_pv = 0.0
    total_v = 0.0
    for b in bars:
        # Polygon VWAP is per bar — recompute manually
        h = b.get("h", 0)
        l = b.get("l", 0)
        c = b.get("c", 0)
        v = b.get("v", 0)
        if v <= 0:
            continue
        typical = (h + l + c) / 3
        total_pv += typical * v
        total_v += v
    return (total_pv / total_v) if total_v > 0 else None


async def fetch_spy_bars(client: httpx.AsyncClient, days: int = 10) -> list[dict]:
    """Fetch recent SPY daily bars for relative strength comparison."""
    return await fetch_daily_bars(client, "SPY", days=days)


async def process_ticker(client: httpx.AsyncClient, ticker: str, spy_bars: list[dict] | None = None) -> None:
    bars = await fetch_daily_bars(client, ticker, days=365)
    if len(bars) < 50:
        return

    # Filter bars that have all required fields to keep arrays in sync
    complete_bars = [b for b in bars if b.get("c") is not None and b.get("h") is not None and b.get("l") is not None and b.get("o") is not None]
    closes = [b["c"] for b in complete_bars]
    highs = [b["h"] for b in complete_bars]
    lows = [b["l"] for b in complete_bars]
    opens = [b["o"] for b in complete_bars]
    if len(closes) < 50:
        return

    price = closes[-1]

    # --- Gap detection (compare today's open vs yesterday's close) ---
    # Both from complete_bars so indices are guaranteed in sync
    if len(complete_bars) >= 2:
        today_open = opens[-1]
        yesterday_close = closes[-2]
        if yesterday_close > 0:
            gap_pct = ((today_open - yesterday_close) / yesterday_close) * 100
            if gap_pct >= 5.0 and not _on_cooldown(ticker, "gap_up_large"):
                _mark(ticker, "gap_up_large")
                _mark(ticker, "gap_up")
                insert_signal(
                    ticker, "technical", 8,
                    f"{ticker} gapped up {gap_pct:.1f}% at open",
                    f"Today's open ${today_open:.2f} is {gap_pct:.1f}% above yesterday's close ${yesterday_close:.2f}. Large gap — watch for gap fill or continuation. Current price ${price:.2f}.",
                    {"indicator": "gap_up", "gap_pct": round(gap_pct, 2), "today_open": today_open, "yesterday_close": yesterday_close, "price": price},
                )
            elif 2.0 <= gap_pct < 5.0 and not _on_cooldown(ticker, "gap_up"):
                _mark(ticker, "gap_up")
                insert_signal(
                    ticker, "technical", 6,
                    f"{ticker} gapped up {gap_pct:.1f}% at open",
                    f"Today's open ${today_open:.2f} is {gap_pct:.1f}% above yesterday's close ${yesterday_close:.2f}. Potential continuation or gap fill setup. Current price ${price:.2f}.",
                    {"indicator": "gap_up", "gap_pct": round(gap_pct, 2), "today_open": today_open, "yesterday_close": yesterday_close, "price": price},
                )
            elif gap_pct <= -5.0 and not _on_cooldown(ticker, "gap_down_large"):
                _mark(ticker, "gap_down_large")
                _mark(ticker, "gap_down")
                insert_signal(
                    ticker, "technical", 8,
                    f"{ticker} gapped down {abs(gap_pct):.1f}% at open",
                    f"Today's open ${today_open:.2f} is {abs(gap_pct):.1f}% below yesterday's close ${yesterday_close:.2f}. Large bearish gap — watch for continued selling or gap fill bounce. Current price ${price:.2f}.",
                    {"indicator": "gap_down", "gap_pct": round(gap_pct, 2), "today_open": today_open, "yesterday_close": yesterday_close, "price": price},
                )
            elif -5.0 < gap_pct <= -2.0 and not _on_cooldown(ticker, "gap_down"):
                _mark(ticker, "gap_down")
                insert_signal(
                    ticker, "technical", 6,
                    f"{ticker} gapped down {abs(gap_pct):.1f}% at open",
                    f"Today's open ${today_open:.2f} is {abs(gap_pct):.1f}% below yesterday's close ${yesterday_close:.2f}. Bearish gap — check for catalyst. Current price ${price:.2f}.",
                    {"indicator": "gap_down", "gap_pct": round(gap_pct, 2), "today_open": today_open, "yesterday_close": yesterday_close, "price": price},
                )

    # --- Relative strength vs SPY (market hours only) ---
    if is_market_hours() and spy_bars and len(spy_bars) >= 2:
        spy_closes = [b["c"] for b in spy_bars if b.get("c") is not None]
        if len(spy_closes) >= 2 and len(closes) >= 2:
            ticker_chg = (closes[-1] - closes[-2]) / closes[-2] * 100 if closes[-2] > 0 else 0
            spy_chg = (spy_closes[-1] - spy_closes[-2]) / spy_closes[-2] * 100 if spy_closes[-2] > 0 else 0
            # Ticker up on a day SPY is down >0.5%
            if ticker_chg > 0 and spy_chg <= -0.5 and not _on_cooldown(ticker, "rs_vs_spy"):
                _mark(ticker, "rs_vs_spy")
                insert_signal(
                    ticker, "technical", 6,
                    f"{ticker} showing relative strength vs SPY",
                    f"{ticker} is up {ticker_chg:.2f}% while SPY is down {abs(spy_chg):.2f}% today. Relative strength in a down tape — institutions may be accumulating or sector rotation into this name. Price ${price:.2f}.",
                    {"indicator": "relative_strength", "ticker_chg_pct": round(ticker_chg, 2), "spy_chg_pct": round(spy_chg, 2), "price": price},
                )

    # --- RSI ---
    rsi_val = rsi(closes, 14)
    if rsi_val is not None:
        if rsi_val <= 25 and not _on_cooldown(ticker, "rsi_oversold"):
            _mark(ticker, "rsi_oversold")
            insert_signal(
                ticker, "technical", 7,
                f"{ticker} RSI {rsi_val:.0f} — deeply oversold",
                f"14-day RSI at {rsi_val:.1f}, well below the 30 oversold line. Price ${price:.2f}. Mean reversion setup or further breakdown — watch volume on next bounce.",
                {"indicator": "rsi", "value": rsi_val, "price": price, "direction": "oversold"},
            )
        elif rsi_val >= 75 and not _on_cooldown(ticker, "rsi_overbought"):
            _mark(ticker, "rsi_overbought")
            insert_signal(
                ticker, "technical", 6,
                f"{ticker} RSI {rsi_val:.0f} — overbought",
                f"14-day RSI at {rsi_val:.1f}, above the 70 overbought line. Price ${price:.2f}. Profit-taking risk rising.",
                {"indicator": "rsi", "value": rsi_val, "price": price, "direction": "overbought"},
            )

    # --- MACD crossover ---
    cross = macd_crossover(closes)
    if cross == "bullish" and not _on_cooldown(ticker, "macd_bull"):
        _mark(ticker, "macd_bull")
        insert_signal(
            ticker, "technical", 7,
            f"{ticker} MACD bullish crossover",
            f"MACD line crossed above the signal line. Price ${price:.2f}. Momentum shift to upside — confirm with volume.",
            {"indicator": "macd", "direction": "bullish", "price": price},
        )
    elif cross == "bearish" and not _on_cooldown(ticker, "macd_bear"):
        _mark(ticker, "macd_bear")
        insert_signal(
            ticker, "technical", 6,
            f"{ticker} MACD bearish crossover",
            f"MACD line crossed below the signal line. Price ${price:.2f}. Momentum shift to downside.",
            {"indicator": "macd", "direction": "bearish", "price": price},
        )

    # --- Bollinger breakout ---
    bb = bollinger(closes, 20, 2.0)
    if bb:
        lower, mid, upper = bb
        if price > upper and not _on_cooldown(ticker, "bb_upper"):
            _mark(ticker, "bb_upper")
            insert_signal(
                ticker, "technical", 7,
                f"{ticker} broke upper Bollinger ${upper:.2f}",
                f"Price ${price:.2f} closed above upper band ${upper:.2f} (20,2). Volatility expansion or trend continuation.",
                {"indicator": "bollinger", "direction": "upper_break", "price": price, "upper": upper, "lower": lower},
            )
        elif price < lower and not _on_cooldown(ticker, "bb_lower"):
            _mark(ticker, "bb_lower")
            insert_signal(
                ticker, "technical", 7,
                f"{ticker} broke lower Bollinger ${lower:.2f}",
                f"Price ${price:.2f} closed below lower band ${lower:.2f} (20,2). Capitulation or accelerating breakdown.",
                {"indicator": "bollinger", "direction": "lower_break", "price": price, "upper": upper, "lower": lower},
            )

    # --- Golden / Death cross (50 SMA vs 200 SMA) ---
    if len(closes) >= 201:
        sma50_today = sma(closes, 50)
        sma200_today = sma(closes, 200)
        sma50_yest = sma(closes[:-1], 50)
        sma200_yest = sma(closes[:-1], 200)
        if all(x is not None for x in (sma50_today, sma200_today, sma50_yest, sma200_yest)):
            if sma50_yest <= sma200_yest and sma50_today > sma200_today and not _on_cooldown(ticker, "golden_cross"):
                _mark(ticker, "golden_cross")
                insert_signal(
                    ticker, "technical", 8,
                    f"{ticker} golden cross — 50d crossed above 200d",
                    f"50-day SMA (${sma50_today:.2f}) crossed above 200-day SMA (${sma200_today:.2f}). Classic long-term bullish signal. Price ${price:.2f}.",
                    {"indicator": "golden_cross", "sma50": sma50_today, "sma200": sma200_today, "price": price},
                )
            elif sma50_yest >= sma200_yest and sma50_today < sma200_today and not _on_cooldown(ticker, "death_cross"):
                _mark(ticker, "death_cross")
                insert_signal(
                    ticker, "technical", 8,
                    f"{ticker} death cross — 50d crossed below 200d",
                    f"50-day SMA (${sma50_today:.2f}) crossed below 200-day SMA (${sma200_today:.2f}). Long-term bearish trend signal. Price ${price:.2f}.",
                    {"indicator": "death_cross", "sma50": sma50_today, "sma200": sma200_today, "price": price},
                )

    # --- 52-week high / low ---
    # Use last 252 trading days (~52 weeks). Exclude today to detect a *new* high.
    if len(closes) >= 253:
        prior_window_high = max(highs[-253:-1])
        prior_window_low = min(lows[-253:-1])
        if price > prior_window_high and not _on_cooldown(ticker, "52w_high"):
            _mark(ticker, "52w_high")
            insert_signal(
                ticker, "technical", 7,
                f"{ticker} new 52-week high ${price:.2f}",
                f"Closed at ${price:.2f}, above prior 52-week high ${prior_window_high:.2f}. Breakouts at 52-week highs often continue if volume confirms.",
                {"indicator": "52w_high", "price": price, "prior_high": prior_window_high},
            )
        elif price < prior_window_low and not _on_cooldown(ticker, "52w_low"):
            _mark(ticker, "52w_low")
            insert_signal(
                ticker, "technical", 7,
                f"{ticker} new 52-week low ${price:.2f}",
                f"Closed at ${price:.2f}, below prior 52-week low ${prior_window_low:.2f}. Distribution or capitulation setup.",
                {"indicator": "52w_low", "price": price, "prior_low": prior_window_low},
            )

    # --- VWAP deviation (intraday, only during market hours) ---
    if is_market_hours():
        intraday = await fetch_intraday_bars(client, ticker)
        if intraday:
            vw = vwap_from_bars(intraday)
            last_close = intraday[-1].get("c")
            if vw and last_close and vw > 0:
                dev_pct = ((last_close - vw) / vw) * 100
                if abs(dev_pct) >= 2.0 and not _on_cooldown(ticker, f"vwap_{('up' if dev_pct > 0 else 'down')}"):
                    direction = "above" if dev_pct > 0 else "below"
                    _mark(ticker, f"vwap_{('up' if dev_pct > 0 else 'down')}")
                    insert_signal(
                        ticker, "technical", 6,
                        f"{ticker} {abs(dev_pct):.1f}% {direction} VWAP",
                        f"Trading at ${last_close:.2f}, {abs(dev_pct):.1f}% {direction} session VWAP ${vw:.2f}. Strong intraday {'buying' if dev_pct > 0 else 'selling'} pressure.",
                        {"indicator": "vwap", "vwap": vw, "price": last_close, "deviation_pct": dev_pct},
                    )


async def run_once() -> dict:
    if not POLYGON_KEY:
        return {"status": "skipped", "reason": "POLYGON_API_KEY not set"}
    tickers = get_watchlist_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no tickers"}

    processed = 0
    async with httpx.AsyncClient() as client:
        # Fetch SPY once for relative strength comparisons
        spy_bars = await fetch_spy_bars(client, days=10) if is_market_hours() else None

        for i in range(0, len(tickers), 5):
            batch = tickers[i:i + 5]
            await asyncio.gather(*[process_ticker(client, t, spy_bars) for t in batch], return_exceptions=True)
            processed += len(batch)
            await asyncio.sleep(1)

    return {"status": "ok", "processed": processed}


async def main_loop():
    log.info("Technical worker started")
    while True:
        try:
            # Run hourly during market hours, once daily after close
            result = await run_once()
            log.info(f"Technical tick: {result}")
        except Exception as e:
            log.error(f"Technical loop error: {e}")
        # Hourly — daily bars don't change minute-to-minute, but VWAP does
        await asyncio.sleep(3600)
