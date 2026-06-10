"""
Macro Worker — tracks VIX, treasury yields, dollar index, sector rotation.

Data sources:
- Polygon for VIX (^VIX), TLT (long bonds proxy), DXY (dollar index proxy via UUP)
- FRED (free, optional) — DGS10, DGS2, federal funds rate

Signals:
- macro_vix: VIX spike >25 or crash to <12
- macro_yields: 10Y yield breakout above 4.5% or below 3.5%
- macro_curve: 2s10s curve flip (inversion in/out)
- macro_dollar: DXY breakout
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone, timedelta, date
from db import insert_signal

log = logging.getLogger("macro_worker")

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"
FRED_KEY = os.environ.get("FRED_API_KEY", "")
FRED_BASE = "https://api.stlouisfed.org/fred"

_signal_cooldown: dict[str, float] = {}
_COOLDOWN = 86400 * 2  # 48h between macro signals of the same kind

# Latest readings cache — read by morning_outlook_worker
_latest: dict[str, float | None] = {"vix": None, "uup": None, "ten_y": None, "two_y": None}

def get_latest_readings() -> dict[str, float | None]:
    return dict(_latest)


def _on_cooldown(kind: str) -> bool:
    last = _signal_cooldown.get(kind, 0)
    return (datetime.now(timezone.utc).timestamp() - last) < _COOLDOWN


def _mark(kind: str) -> None:
    _signal_cooldown[kind] = datetime.now(timezone.utc).timestamp()


async def fetch_polygon_close(client: httpx.AsyncClient, ticker: str) -> float | None:
    """Most recent price — tries snapshot first (real-time), falls back to daily close."""
    if not POLYGON_KEY:
        return None
    # Try snapshot for real-time price (works pre-market too)
    try:
        r = await client.get(
            f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}",
            params={"apiKey": POLYGON_KEY},
            timeout=8,
        )
        if r.status_code == 200:
            d = r.json()
            if d.get("status") == "OK" and "ticker" in d:
                t = d["ticker"]
                p = (t.get("lastTrade") or {}).get("p") or (t.get("day") or {}).get("c")
                if p:
                    return float(p)
    except Exception:
        pass
    # Fallback: daily agg
    today = date.today()
    start = (today - timedelta(days=5)).isoformat()
    try:
        r = await client.get(
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start}/{today.isoformat()}",
            params={"apiKey": POLYGON_KEY, "limit": 5, "sort": "desc"},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        results = r.json().get("results", [])
        if not results:
            return None
        return float(results[0].get("c", 0))
    except Exception as e:
        log.error(f"Polygon close failed for {ticker}: {e}")
        return None


async def fetch_fred_series(client: httpx.AsyncClient, series_id: str) -> list[tuple[str, float]]:
    """FRED series observations — most recent first."""
    if not FRED_KEY:
        return []
    try:
        r = await client.get(
            f"{FRED_BASE}/series/observations",
            params={
                "series_id": series_id,
                "api_key": FRED_KEY,
                "file_type": "json",
                "sort_order": "desc",
                "limit": 10,
            },
            timeout=15,
        )
        if r.status_code != 200:
            return []
        obs = r.json().get("observations", [])
        out: list[tuple[str, float]] = []
        for o in obs:
            v = o.get("value")
            if v and v != ".":
                try:
                    out.append((o.get("date", ""), float(v)))
                except ValueError:
                    pass
        return out
    except Exception as e:
        log.error(f"FRED fetch failed for {series_id}: {e}")
        return []


async def check_vix(client: httpx.AsyncClient) -> None:
    """VIX — the REAL implied-volatility index.

    Source priority:
      1. FRED VIXCLS  — the actual VIX index (free, reliable)
      2. Polygon I:VIX — paid-tier index quote

    We deliberately do NOT fall back to the VIXY/VXX/UVXY ETFs: their share price
    (e.g. VIXY ~$26, UVXY ~$33) is NOT the VIX index value, and feeding it into
    _latest['vix'] corrupted every "VIX > threshold" regime check — it was making
    the sandbox skip ALL entries on normal days (real VIX ~20) because the ETF
    price sat above the 28 limit. Use the real index only."""
    vix_close = None
    fred_vix = await fetch_fred_series(client, "VIXCLS")
    if fred_vix:
        vix_close = fred_vix[0][1]
    if vix_close is None:
        vix_close = await fetch_polygon_close(client, "I:VIX")
    if vix_close is None:
        return
    _latest["vix"] = vix_close

    if vix_close >= 30 and not _on_cooldown("vix_high"):
        _mark("vix_high")
        insert_signal(
            "SPY", "macro", 8,
            f"VIX at {vix_close:.1f} — fear gauge elevated",
            f"VIX closed at {vix_close:.1f}, well above the calm-market 15 baseline. Options premium is rich — selling vol may pay; long-dated calls expensive. Watch SPY for direction.",
            {"indicator": "vix", "value": vix_close, "regime": "high_fear"},
        )
    elif vix_close <= 12 and not _on_cooldown("vix_low"):
        _mark("vix_low")
        insert_signal(
            "SPY", "macro", 6,
            f"VIX at {vix_close:.1f} — complacency",
            f"VIX at {vix_close:.1f}, extremely low. Cheap hedges available; market positioning often gets one-sided here. Risk of vol shock rising.",
            {"indicator": "vix", "value": vix_close, "regime": "complacency"},
        )


async def check_yields(client: httpx.AsyncClient) -> None:
    """10-year and 2-year treasury yields via FRED."""
    if not FRED_KEY:
        return
    ten_y = await fetch_fred_series(client, "DGS10")
    two_y = await fetch_fred_series(client, "DGS2")
    if not ten_y:
        return

    ten_latest = ten_y[0][1]
    _latest["ten_y"] = ten_latest
    ten_prior = ten_y[1][1] if len(ten_y) > 1 else None

    if ten_latest >= 4.75 and not _on_cooldown("yields_high"):
        _mark("yields_high")
        insert_signal(
            "TLT", "macro", 7,
            f"10Y yield {ten_latest:.2f}% — pressure on growth",
            f"10-year treasury yield closed at {ten_latest:.2f}%. Rising yields tend to compress growth stock multiples — watch QQQ, ARKK, high-multiple names.",
            {"indicator": "10y_yield", "value": ten_latest, "regime": "high"},
        )
    elif ten_latest <= 3.0 and not _on_cooldown("yields_low"):
        _mark("yields_low")
        insert_signal(
            "TLT", "macro", 7,
            f"10Y yield {ten_latest:.2f}% — tailwind for growth",
            f"10Y at {ten_latest:.2f}%. Lower discount rate supports long-duration growth names. Bonds also rallying.",
            {"indicator": "10y_yield", "value": ten_latest, "regime": "low"},
        )

    # Curve inversion check (2s10s)
    if two_y:
        two_latest = two_y[0][1]
        _latest["two_y"] = two_latest
        spread = ten_latest - two_latest
        two_prior = two_y[1][1] if len(two_y) > 1 else None
        prior_spread = (ten_prior - two_prior) if (ten_prior is not None and two_prior is not None) else None

        if spread < 0 and prior_spread is not None and prior_spread >= 0 and not _on_cooldown("curve_invert"):
            _mark("curve_invert")
            insert_signal(
                "SPY", "macro", 8,
                f"2s10s curve inverted ({spread:.2f}%)",
                f"10Y yield {ten_latest:.2f}% fell below 2Y yield {two_latest:.2f}%. Inversion historically precedes recessions by 6-18 months — defensive sectors often outperform here.",
                {"indicator": "yield_curve", "spread": spread, "ten_y": ten_latest, "two_y": two_latest, "event": "invert"},
            )
        elif spread > 0 and prior_spread is not None and prior_spread <= 0 and not _on_cooldown("curve_steepen"):
            _mark("curve_steepen")
            insert_signal(
                "SPY", "macro", 8,
                f"2s10s curve un-inverted ({spread:.2f}%)",
                f"Curve steepening — historically the actual recession start, not the inversion. 10Y {ten_latest:.2f}%, 2Y {two_latest:.2f}%.",
                {"indicator": "yield_curve", "spread": spread, "ten_y": ten_latest, "two_y": two_latest, "event": "steepen"},
            )


async def check_dollar(client: httpx.AsyncClient) -> None:
    """Dollar index proxy via UUP ETF."""
    uup_close = await fetch_polygon_close(client, "UUP")
    if uup_close is None:
        return
    _latest["uup"] = uup_close
    # UUP ranges roughly 24-32; signal extremes
    if uup_close >= 31 and not _on_cooldown("dollar_strong"):
        _mark("dollar_strong")
        insert_signal(
            "UUP", "macro", 6,
            f"Dollar strengthening — UUP ${uup_close:.2f}",
            f"Dollar index proxy at ${uup_close:.2f}. Strong dollar pressures international stocks, commodities, multinationals' overseas earnings.",
            {"indicator": "dollar", "value": uup_close, "regime": "strong"},
        )
    elif uup_close <= 26 and not _on_cooldown("dollar_weak"):
        _mark("dollar_weak")
        insert_signal(
            "UUP", "macro", 6,
            f"Dollar weakening — UUP ${uup_close:.2f}",
            f"UUP at ${uup_close:.2f}. Weak dollar typically lifts commodities (GLD, oil), international stocks, multinationals' reported earnings.",
            {"indicator": "dollar", "value": uup_close, "regime": "weak"},
        )


async def check_credit_spreads(client: httpx.AsyncClient) -> None:
    """High-yield credit spread (HYG implied spread from FRED)."""
    if not FRED_KEY:
        return
    # BAMLH0A0HYM2 = US High Yield OAS (Option-Adjusted Spread)
    hyg_spreads = await fetch_fred_series(client, "BAMLH0A0HYM2")
    if not hyg_spreads:
        return
    current_spread = hyg_spreads[0][1]
    if current_spread >= 700 and not _on_cooldown("credit_stress"):
        _mark("credit_stress")
        insert_signal(
            "HYG", "macro", 7,
            f"Credit stress — HY spreads at {current_spread:.0f} bps",
            f"High-yield spreads at {current_spread:.0f} bps, indicating credit stress. Watch for flight-to-quality into treasuries.",
            {"indicator": "hy_spreads", "value": current_spread, "regime": "stress"},
        )

async def check_inflation(client: httpx.AsyncClient) -> None:
    """Inflation proxy via commodity prices."""
    if not FRED_KEY:
        return
    # DCOILWTICO = crude oil price
    crude = await fetch_fred_series(client, "DCOILWTICO")
    if crude:
        crude_price = crude[0][1]
        if crude_price >= 110 and not _on_cooldown("inflation_crude"):
            _mark("inflation_crude")
            insert_signal(
                "XLE", "macro", 6,
                f"Oil spike — {crude_price:.0f}/bbl inflation pressure",
                f"Crude oil at ${crude_price:.0f}/barrel. Watch for inflation spillovers; energy sector favors.",
                {"indicator": "crude", "value": crude_price, "regime": "elevated"},
            )

async def run_once() -> dict:
    fired_before = len(_signal_cooldown)
    async with httpx.AsyncClient() as client:
        await check_vix(client)
        await check_yields(client)
        await check_dollar(client)
        await check_credit_spreads(client)
        await check_inflation(client)
    return {"status": "ok", "signals_tracked": len(_signal_cooldown), "new": len(_signal_cooldown) - fired_before}


async def main_loop():
    log.info("Macro worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Macro tick: {result}")
        except Exception as e:
            log.error(f"Macro loop error: {e}")
        # Poll every 2 min pre-market (4–10am ET), every 30 min otherwise
        from market_hours import now_et, is_weekday
        et = now_et()
        total_min = et.hour * 60 + et.minute
        is_premarket_window = is_weekday() and (240 <= total_min <= 600)  # 4am–10am ET
        await asyncio.sleep(120 if is_premarket_window else 1800)
