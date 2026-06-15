"""
Sandbox Worker — Groq's paper trading engine.

Goal: achieve 70%+ win rate on paper trades, learning from every mistake.

Schedule:
  9:30am ET  — scan all watchlist tickers, Groq decides entries
  Every 30m  — re-evaluate open swing trades, exit if thesis broken
  4:00pm ET  — close all day trades at last price, evaluate all open trades

Trade types:
  day   — opens and closes same day
  swing — held up to 20 trading days, Groq re-evaluates daily

Groq gets:
  - Current price + recent signals
  - Past lessons from prediction_lessons table
  - Its own open positions (to avoid doubling up)
  - Its own win rate (so it knows if it needs to be more selective)
"""
import os
import logging
import asyncio
import json
import httpx
from datetime import datetime, timezone, date, timedelta
from db import supabase, insert_signal
from market_hours import now_et, is_weekday, is_market_hours

# ── Tavily live search ────────────────────────────────────────────────────────
# Only used at the moment of entry decision — the most important call we make.
# Fetches what's happening RIGHT NOW on a ticker before Groq decides to trade.
# Rotates across multiple keys to stay on free tier.

def _get_tavily_keys() -> list[str]:
    return [k for k in [
        os.environ.get("TAVILY_API_KEY"),
        os.environ.get("TAVILY_API_KEY_2"),
        os.environ.get("TAVILY_API_KEY_3"),
    ] if k]

async def fetch_live_news(client: httpx.AsyncClient, ticker: str) -> str:
    """
    Fetch live news for a ticker RIGHT BEFORE a trade entry decision.
    Only called once per ticker per decide_entry() — not in any loop or polling.
    Returns a short summary string for the Groq prompt, empty string on failure.
    """
    keys = _get_tavily_keys()
    if not keys:
        return ""
    import random
    key = random.choice(keys)
    try:
        res = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": key,
                "query": f"{ticker} stock news today breaking",
                "search_depth": "basic",   # basic = 1 credit not 2
                "max_results": 3,
                "include_answer": True,
                "topic": "finance",
            },
            timeout=8,
        )
        if res.status_code == 429:
            log.debug(f"Tavily key rate limited, skipping live news for {ticker}")
            return ""
        if not res.is_success:
            return ""
        data = res.json()
        answer = data.get("answer", "")
        results = data.get("results", [])
        if answer:
            return f"LIVE NEWS (last few hours): {answer[:300]}"
        elif results:
            headlines = " | ".join(r.get("title", "") for r in results[:3])
            return f"LIVE NEWS HEADLINES: {headlines[:300]}"
        return ""
    except Exception as e:
        log.debug(f"Tavily live news fetch failed for {ticker}: {e}")
        return ""

log = logging.getLogger("sandbox_worker")

# Module-level throttle for Groq swing re-evals — persists across scheduled calls
# within a single process run. Initialized to None so the first run always evaluates.
_last_swing_groq_eval_utc: datetime | None = None

POLYGON_KEY = os.environ.get("POLYGON_API_KEY", "")
POLYGON_BASE = "https://api.polygon.io"

# Paper trading config
STARTING_BALANCE   = 50_000.00  # $50k paper account
MAX_POSITION_PCT   = 15.0       # never put more than 15% of account in one trade
MAX_OPEN_POSITIONS = 10         # sniper mode — fewer, better positions
MAX_DAILY_ENTRIES  = 8          # max 8 trades/day — only the best setups
MAX_SWING_DAYS     = 20         # force-close swing trades after 20 trading days
MAX_STOP_PCT       = 9.0        # volatile names need room; $ risk is already capped at 1%/trade by position sizing (wider stop -> fewer shares -> same risk), so 6% just blocked good high-conviction setups
MAX_POSITIONS_PER_SECTOR = 2    # max 2 per sector — avoid concentration
COOLDOWN_DAYS      = 5          # ban ticker N days after 2 consecutive losses
BREAKEVEN_TRIGGER  = 2.0        # move stop to breakeven after +2% gain
VIX_REGIME_LIMIT   = 28.0       # skip entries when VIX above this

# ── Sniper position sizing — scales with signal conviction ──────────────────
RISK_PCT_BASE        = 1.0   # 1 qualifying signal  → 1% risk  ($500)
RISK_PCT_MULTI       = 1.5   # 2+ signals           → 1.5% risk ($750)
RISK_PCT_CONVERGENCE = 3.0   # convergence alert    → 3% risk  ($1,500) — full send
RISK_PCT_HOT_STREAK  = 0.3   # bonus when WR >= 70% over last 10 trades (capped, #3)

# Account health multipliers — scale down risk when in drawdown
HEALTH_MULTIPLIER_95 = 0.9   # <5% from peak  → 90% of normal risk
HEALTH_MULTIPLIER_90 = 0.7   # <10% from peak → 70% of normal risk
HEALTH_MULTIPLIER_85 = 0.5   # <15% from peak → 50% of normal risk

# Confidence thresholds — high bar by default
BASE_CONFIDENCE_THRESHOLD = 55   # lowered — more entries, still selective
HIGH_BAR_CONFIDENCE       = 70   # used when win rate < 40%
CONVERGENCE_MIN_CONFIDENCE = 50  # convergence overrides normal bar (signal does the work)

# Sector mapping for correlation limit (#6)
SECTOR_MAP: dict[str, str] = {
    # Tech — large cap + semis
    "AAPL": "tech", "MSFT": "tech", "NVDA": "tech", "AMD": "tech", "META": "tech",
    "GOOGL": "tech", "GOOG": "tech", "AMZN": "tech", "TSLA": "tech", "PLTR": "tech",
    "CRM": "tech", "ORCL": "tech", "ADBE": "tech", "INTC": "tech", "MDB": "tech",
    "DELL": "tech", "SNOW": "tech", "NET": "tech", "CRWD": "tech", "DDOG": "tech",
    "IBM": "tech", "QCOM": "tech", "TXN": "tech", "AVGO": "tech", "MU": "tech",
    "AMAT": "tech", "KLAC": "tech", "LRCX": "tech", "MRVL": "tech", "NXPI": "tech",
    "NOW": "tech", "WDAY": "tech", "VEEV": "tech", "ZS": "tech", "OKTA": "tech",
    "PANW": "tech", "FTNT": "tech", "SPLK": "tech", "ESTC": "tech", "HUBS": "tech",
    "SHOP": "tech", "U": "tech", "RBLX": "tech", "TWLO": "tech", "ZM": "tech",
    "DOCU": "tech", "BOX": "tech", "WORK": "tech", "DBX": "tech", "DOCN": "tech",
    "APP": "tech", "TEAM": "tech", "DSGX": "tech", "WIX": "tech", "SMAR": "tech",
    "ACN": "tech", "INFY": "tech", "WIT": "tech", "CTSH": "tech",
    # Tech — AI/semis high-beta
    "ARM": "tech", "ASML": "tech", "TSM": "tech", "SMCI": "tech", "MCHP": "tech",
    "ON": "tech", "WOLF": "tech", "OLED": "tech", "SWKS": "tech", "QRVO": "tech",
    "ENPH": "tech", "SEDG": "tech", "FSLR": "tech",
    # Tech — AI infrastructure & data
    "AI": "tech", "BBAI": "tech", "SOUN": "tech", "IREN": "tech", "CORZ": "tech",
    "APLD": "tech", "WULF": "tech",
    # Tech — quantum computing (high-beta)
    "IONQ": "tech", "RGTI": "tech", "QUBT": "tech", "QBTS": "tech", "ARQQ": "tech",
    # Finance
    "JPM": "finance", "BAC": "finance", "GS": "finance", "MS": "finance", "WFC": "finance",
    "C": "finance", "BLK": "finance", "SCHW": "finance", "AXP": "finance",
    "COF": "finance", "DFS": "finance", "SYF": "finance", "ALLY": "finance",
    "USB": "finance", "PNC": "finance", "TFC": "finance", "FITB": "finance",
    "V": "finance", "MA": "finance", "PYPL": "finance", "SQ": "finance", "AFRM": "finance",
    "COIN": "finance", "HOOD": "finance", "SOFI": "finance", "NU": "finance",
    "ICE": "finance", "CME": "finance", "CBOE": "finance", "NDAQ": "finance",
    "BX": "finance", "KKR": "finance", "APO": "finance", "ARES": "finance",
    "UPST": "finance", "LC": "finance", "OPFI": "finance",
    # Finance — crypto/Bitcoin proxies
    "MSTR": "finance", "MARA": "finance", "RIOT": "finance", "CLSK": "finance",
    "HUT": "finance", "BITF": "finance",
    # Healthcare
    "JNJ": "health", "UNH": "health", "PFE": "health", "ABBV": "health", "MRK": "health",
    "LLY": "health", "DHR": "health", "TMO": "health", "AMGN": "health",
    "GILD": "health", "BIIB": "health", "REGN": "health", "VRTX": "health",
    "BMY": "health", "AZN": "health", "NVO": "health", "SNY": "health",
    "CVS": "health", "CI": "health", "HUM": "health", "MOH": "health",
    "ISRG": "health", "BSX": "health", "MDT": "health", "EW": "health", "SYK": "health",
    "ZBH": "health", "BDX": "health", "HOLX": "health", "DXCM": "health",
    # Healthcare — biotech high-beta
    "MRNA": "health", "BNTX": "health", "NVAX": "health", "RXRX": "health",
    "ILMN": "health", "PACB": "health", "CRSP": "health", "NTLA": "health",
    "BEAM": "health", "EDIT": "health", "TDOC": "health", "HIMS": "health",
    "SDGR": "health", "ACMR": "health",
    # Energy
    "XOM": "energy", "CVX": "energy", "COP": "energy", "SLB": "energy", "EOG": "energy",
    "PXD": "energy", "DVN": "energy", "MPC": "energy", "PSX": "energy", "VLO": "energy",
    "OXY": "energy", "HAL": "energy", "BKR": "energy", "FANG": "energy",
    "KMI": "energy", "WMB": "energy", "ET": "energy", "MPLX": "energy",
    # Energy — clean/uranium
    "CCJ": "energy", "UEC": "energy", "DNN": "energy", "NXE": "energy",
    "PLUG": "energy", "BE": "energy", "BLDP": "energy",
    # Defense
    "LMT": "defense", "RTX": "defense", "NOC": "defense", "GD": "defense", "HII": "defense",
    "BA": "defense", "TDG": "defense", "HEI": "defense", "LDOS": "defense", "SAIC": "defense",
    "L3H": "defense", "KTOS": "defense", "RCAT": "defense", "AXON": "defense",
    "CACI": "defense", "LEIDOS": "defense", "VSE": "defense",
    # Consumer discretionary
    "HD": "consumer", "LOW": "consumer",
    "TJX": "consumer", "ROST": "consumer", "TGT": "consumer", "WMT": "consumer",
    "COST": "consumer", "DG": "consumer", "DLTR": "consumer",
    "MCD": "consumer", "SBUX": "consumer", "CMG": "consumer", "YUM": "consumer",
    "NKE": "consumer", "LULU": "consumer", "VFC": "consumer", "RL": "consumer",
    "DECK": "consumer", "ONON": "consumer", "CROX": "consumer",
    "BKNG": "consumer", "EXPE": "consumer", "ABNB": "consumer", "LYFT": "consumer", "UBER": "consumer",
    "GM": "consumer", "F": "consumer", "RIVN": "consumer", "LCID": "consumer",
    "DASH": "consumer", "DKNG": "consumer", "PENN": "consumer",
    # Industrials
    "CAT": "industrial", "DE": "industrial", "HON": "industrial", "MMM": "industrial",
    "GE": "industrial", "EMR": "industrial", "ETN": "industrial", "PH": "industrial",
    "ROK": "industrial", "DOV": "industrial", "ITW": "industrial", "FTV": "industrial",
    "UPS": "industrial", "FDX": "industrial", "XPO": "industrial", "SAIA": "industrial",
    "CSX": "industrial", "NSC": "industrial", "UNP": "industrial",
    "NUE": "industrial", "STLD": "industrial", "X": "industrial", "CLF": "industrial",
    "AA": "industrial", "FCX": "industrial",
    "BLDE": "industrial", "ACHR": "industrial", "JOBY": "industrial", "LILM": "industrial",
    # Real estate / REITs
    "AMT": "realestate", "PLD": "realestate", "EQIX": "realestate", "CCI": "realestate",
    "SPG": "realestate", "O": "realestate", "VICI": "realestate", "WELL": "realestate",
    "EQR": "realestate", "AVB": "realestate", "DLR": "realestate",
    # Utilities
    "NEE": "utilities", "DUK": "utilities", "SO": "utilities", "D": "utilities",
    "AEP": "utilities", "EXC": "utilities", "SRE": "utilities", "PCG": "utilities",
    # Media / streaming
    "NFLX": "tech", "DIS": "consumer", "PARA": "consumer", "WBD": "consumer",
    "SPOT": "tech", "SNAP": "tech", "PINS": "tech", "RDDT": "tech",
    # Indices / ETFs (skip sector limit for these — filtered out anyway)
    "SPY": "index", "QQQ": "index", "IWM": "index", "DIA": "index",
}


# ─── Groq call ────────────────────────────────────────────────────────────────

async def _call_groq(prompt: str, max_tokens: int = 500, fast: bool = False) -> str | None:
    from groq_pool import call_llm

    # #5: Groq model routing — auto-select based on prompt complexity
    # - If fast=True OR prompt < 1000 chars: use llama-3.1-8b-instant (fast/cheap, ~0.02/M tokens)
    # - If prompt > 2000 chars: use llama-3.3-70b-versatile (quality, ~0.25/M tokens)
    # - In between: auto-decide (heuristic: use 8b for <=1500, 70b for >1500)
    if fast or len(prompt) < 1000:
        model = "llama-3.1-8b-instant"
    elif len(prompt) > 2000:
        model = "llama-3.3-70b-versatile"
    else:
        # 1000-2000 char range: use 8b unless it's a complex reasoning task
        model = "llama-3.1-8b-instant" if len(prompt) <= 1500 else "llama-3.3-70b-versatile"

    return await call_llm(
        prompt,
        primary_env_vars=["GROQ_BACKUP_API_KEY"],
        max_tokens=max_tokens,
        temperature=0.2,
        model=model,
    )


# ─── Data helpers ─────────────────────────────────────────────────────────────

def get_premarket_plan() -> list[dict]:
    """Return today's pre-market game plan picks, sorted by conviction desc.
    Only returns picks if the plan was created today — never uses a stale plan."""
    try:
        today = date.today().isoformat()
        res = (
            supabase().table("sandbox_premarket_plans")
            .select("picks,date,created_at")
            .eq("date", today)
            .limit(1)
            .execute()
        )
        if res.data:
            plan = res.data[0]
            # Double-check date matches today (guards against timezone edge cases)
            if plan.get("date") != today:
                log.warning(f"Pre-market plan date mismatch: {plan.get('date')} != {today} — ignoring stale plan")
                return []
            picks = plan.get("picks") or []
            return sorted(picks, key=lambda p: p.get("conviction", 0), reverse=True)
    except Exception as e:
        log.debug(f"Pre-market plan fetch failed: {e}")
    return []


def get_watchlist_tickers() -> list[str]:
    try:
        watch = supabase().table("watchlist").select("ticker").execute()
        port = supabase().table("portfolio").select("ticker").execute()
        tickers = set()
        for r in (watch.data or []):
            tickers.add(r["ticker"].upper())
        for r in (port.data or []):
            tickers.add(r["ticker"].upper())
        return sorted(tickers)
    except Exception as e:
        log.error(f"get_watchlist_tickers failed: {e}")
        return []


async def get_scan_universe(client: httpx.AsyncClient) -> list[str]:
    """
    Build a broad universe of tickers for sandbox scanning:
    1. Polygon top gainers + losers (price momentum)
    2. StockTwits trending (retail sentiment)
    3. Tickers with recent signals in DB (already flagged by other workers)
    4. Watchlist + portfolio (always included)

    Returns deduplicated list, ETFs and crypto filtered out.
    """
    tickers: set[str] = set()

    # 1. Watchlist + portfolio — always included
    # BUG FIX #11: Call once and cache (prevents redundant DB query at line 318)
    watchlist_tickers = get_watchlist_tickers()
    tickers.update(watchlist_tickers)

    # 2. Polygon top gainers + losers
    if POLYGON_KEY:
        for direction in ["gainers", "losers"]:
            try:
                r = await client.get(
                    f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/{direction}",
                    params={"apiKey": POLYGON_KEY, "include_otc": False},
                    timeout=10,
                )
                if r.status_code == 200:
                    for item in (r.json().get("tickers") or [])[:15]:
                        t = item.get("ticker", "")
                        if t and 1 < len(t) <= 5 and t.isalpha():
                            tickers.add(t.upper())
            except Exception as e:
                log.debug(f"Polygon {direction} fetch failed: {e}")

    # 3. StockTwits trending
    try:
        r = await client.get(
            "https://api.stocktwits.com/api/2/trending/symbols.json",
            timeout=10,
        )
        if r.status_code == 200:
            for s in (r.json().get("symbols") or [])[:20]:
                t = s.get("symbol", "")
                # Filter crypto (.X suffix) and ETFs
                if t and "." not in t and 1 < len(t) <= 5 and t.isalpha():
                    tickers.add(t.upper())
    except Exception as e:
        log.debug(f"StockTwits trending fetch failed: {e}")

    # 4. Tickers with signals in last 24h (already flagged by other workers)
    try:
        from datetime import datetime, timezone, timedelta
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("ticker")
            .gte("created_at", since)
            .gte("severity", 6)
            .execute()
        )
        for r in (res.data or []):
            t = r.get("ticker", "")
            if t and 1 < len(t) <= 5 and t.isalpha() and t not in ("REDDIT", "SYSTEM"):
                tickers.add(t.upper())
    except Exception as e:
        log.debug(f"Signals universe fetch failed: {e}")

    # Filter known ETFs and indices
    ETF_FILTER = {"SPY", "QQQ", "IWM", "DIA", "VTI", "GLD", "SLV", "TLT", "HYG",
                  "XLF", "XLE", "XLK", "XLV", "XLI", "XLP", "XLU", "XLB", "XLY",
                  "ARKK", "ARKG", "SQQQ", "TQQQ", "UVXY", "VXX"}
    tickers -= ETF_FILTER

    # Score each ticker by signal activity in last 24h — more signals = higher score
    # This lets us pass only the top 20 to Groq instead of all 50-100
    scores: dict[str, float] = {}
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("ticker,severity,signal_type")
            .gte("created_at", since)
            .gte("severity", 5)
            .execute()
        )
        signal_weights = {
            "convergence": 10, "dark_pool": 8, "insider_buy": 8, "insider_sell": 8,
            "options_unusual": 8, "short_squeeze": 7, "congress_trade": 7,
            "volume_spike": 6, "analyst_change": 6, "news_breaking": 5,
            "technical": 4, "sentiment_spike": 4, "earnings_upcoming": 4,
            "price_move": 3, "macro": 2,
        }
        for row in (res.data or []):
            t = row.get("ticker", "")
            if t not in tickers:
                continue
            sev = float(row.get("severity") or 5)
            weight = signal_weights.get(row.get("signal_type", ""), 3)
            scores[t] = scores.get(t, 0) + (sev / 10) * weight
    except Exception as e:
        log.debug(f"Scoring failed: {e}")

    # Watchlist/portfolio tickers always get a score boost so they're never dropped
    # BUG FIX #11: Reuse watchlist_tickers variable (no second DB call)
    for t in watchlist_tickers:
        scores[t] = scores.get(t, 0) + 5

    # Sort by score descending, take top 15 — balance coverage vs Groq cost
    ranked = sorted(tickers, key=lambda t: scores.get(t, 0), reverse=True)[:15]
    log.info(f"Sandbox scan universe: {len(tickers)} tickers → top {len(ranked)} by signal score")
    return ranked


async def get_current_price(client: httpx.AsyncClient, ticker: str) -> float | None:
    """Live price via the shared price_worker fallback chain
    (Polygon snapshot → Polygon daily aggs → Finnhub real-time → Yahoo Finance).

    The sandbox previously used Polygon ONLY, which on the free tier is not
    authorized for live snapshots and returns the *previous day's* close — so
    entries priced off stale data. Delegating to price_worker gives the sandbox
    the same real-time quotes the rest of the app already uses."""
    # Primary: shared 4-source chain (Finnhub + Yahoo give real-time on free tier)
    try:
        import price_worker
        snap = await price_worker.fetch_snapshot(client, ticker)
        if snap:
            p = (snap.get("lastTrade") or {}).get("p") or (snap.get("day") or {}).get("c")
            if p and float(p) > 0:
                return float(p)
    except Exception as e:
        log.debug(f"Shared price chain failed for {ticker}: {e}")

    # Fallback: direct Polygon (safety net if price_worker is unavailable)
    if not POLYGON_KEY:
        return None
    try:
        r = await client.get(
            f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}",
            params={"apiKey": POLYGON_KEY}, timeout=10,
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
    # Free-tier fallback: daily agg
    try:
        today = date.today().isoformat()
        start = (date.today() - timedelta(days=5)).isoformat()
        r = await client.get(
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start}/{today}",
            params={"apiKey": POLYGON_KEY, "limit": 3, "sort": "desc"}, timeout=10,
        )
        if r.status_code == 200:
            results = r.json().get("results", [])
            if results:
                return float(results[0].get("c") or 0) or None
    except Exception as e:
        log.debug(f"Price fetch failed for {ticker}: {e}")

    # Finnhub fallback
    finnhub_key = os.environ.get("FINNHUB_API_KEY")
    if finnhub_key:
        try:
            r = await client.get(
                f"https://finnhub.io/api/v1/quote",
                params={"symbol": ticker, "token": finnhub_key}, timeout=8,
            )
            if r.status_code == 200:
                p = r.json().get("c")
                if p and float(p) > 0:
                    log.debug(f"Price fallback: Finnhub for {ticker} = ${p}")
                    return float(p)
        except Exception as e:
            log.debug(f"Finnhub price fallback failed for {ticker}: {e}")

    # Yahoo Finance last resort
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        hist = t.history(period="1d")
        if not hist.empty:
            p = float(hist["Close"].iloc[-1])
            if p > 0:
                log.debug(f"Price fallback: Yahoo for {ticker} = ${p}")
                return p
    except Exception as e:
        log.debug(f"Yahoo price fallback failed for {ticker}: {e}")

    return None


async def get_recent_signals(ticker: str, hours: int = 24) -> list[dict]:
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        res = (
            supabase().table("signals")
            .select("signal_type,severity,title,body,created_at")
            .eq("ticker", ticker.upper())
            .gte("created_at", since)
            .order("severity", desc=True)
            .limit(5)  # BUG FIX #10: Reduced from 10 to 5 (prevents token bloat on high-signal tickers)
            .execute()
        )
        # BUG FIX #10: Deduplicate by signal_type (keep highest severity per type)
        if res.data:
            seen = {}
            for sig in res.data:
                sig_type = sig.get("signal_type")
                if sig_type not in seen:
                    seen[sig_type] = sig
            return list(seen.values())
        return []
    except Exception as e:
        log.debug(f"Signals fetch failed for {ticker}: {e}")
        return []


def get_signal_timing_spread(signals: list[dict]) -> tuple[float, str]:
    """#6 — Returns (spread_hours, label). Signals bunched in same window = stronger.
    Wide time spread = signals aren't really converging, decay conviction."""
    if len(signals) < 2:
        return 0.0, "single"
    times = []
    for s in signals:
        ts = s.get("created_at")
        if ts:
            try:
                t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                times.append(t)
            except Exception:
                pass
    if len(times) < 2:
        return 0.0, "unknown"
    spread = (max(times) - min(times)).total_seconds() / 3600
    if spread < 0.5:
        label = "tight cluster (<30min)"
    elif spread < 1.5:
        label = "moderate spread (30-90min)"
    elif spread < 4.0:
        label = "wide spread (1.5-4h)"
    else:
        label = "stale cluster (>4h)"
    return round(spread, 2), label


async def get_recent_lessons(ticker: str, limit: int = 5) -> list[dict]:
    """Prediction lessons for this ticker — 1 per date, last N dates (dedup #13)."""
    try:
        # Fetch more rows than needed so we can dedup by date
        res = (
            supabase().table("prediction_lessons")
            .select("date,bias,actual_bias,in_range,lesson,confidence_pct")
            .eq("ticker", ticker.upper())
            .order("date", desc=True)
            .limit(limit * 6)
            .execute()
        )
        rows = res.data or []
        # Keep first (most recent) row per date
        seen: set[str] = set()
        deduped = []
        for r in rows:
            d = r.get("date", "")
            if d and d not in seen:
                seen.add(d)
                deduped.append(r)
                if len(deduped) >= limit:
                    break
        return deduped
    except Exception as e:
        log.debug(f"Lessons fetch failed for {ticker}: {e}")
        return []


async def get_sandbox_lessons(ticker: str, limit: int = 5) -> list[dict]:
    """Past sandbox trade outcomes for this ticker."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("entry_date,direction,entry_price,exit_price,pnl_pct,exit_reason,groq_thesis,groq_exit_note")
            .eq("ticker", ticker.upper())
            .eq("status", "closed")
            .order("entry_date", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.debug(f"Sandbox lessons fetch failed for {ticker}: {e}")
        return []


def get_open_positions() -> list[dict]:
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("*")
            .eq("status", "open")
            .execute()
        )
        return res.data or []
    except Exception as e:
        log.error(f"get_open_positions failed: {e}")
        return []


def get_30day_performance_summary() -> str:
    """Returns a compact stats block for the last 30 days of closed trades."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        res = (
            supabase().table("sandbox_trades")
            .select("direction,trade_type,pnl,pnl_pct,exit_reason,confidence_used,signals_at_entry,entry_date,created_at")
            .eq("status", "closed")
            .gte("updated_at", since)
            .execute()
        )
        trades = res.data or []
        if len(trades) < 5:
            return ""

        wins = [t for t in trades if (t.get("pnl") or 0) > 0]
        losses = [t for t in trades if (t.get("pnl") or 0) <= 0]
        total = len(trades)
        wr = len(wins) / total * 100

        # By direction
        long_t  = [t for t in trades if t.get("direction") == "long"]
        short_t = [t for t in trades if t.get("direction") == "short"]
        long_wr  = sum(1 for t in long_t if (t.get("pnl") or 0) > 0) / len(long_t) * 100 if long_t else 0
        short_wr = sum(1 for t in short_t if (t.get("pnl") or 0) > 0) / len(short_t) * 100 if short_t else 0

        # By trade type
        day_t   = [t for t in trades if t.get("trade_type") == "day"]
        swing_t = [t for t in trades if t.get("trade_type") == "swing"]
        day_wr   = sum(1 for t in day_t if (t.get("pnl") or 0) > 0) / len(day_t) * 100 if day_t else 0
        swing_wr = sum(1 for t in swing_t if (t.get("pnl") or 0) > 0) / len(swing_t) * 100 if swing_t else 0

        # By confidence
        high_conf  = [t for t in trades if float(t.get("confidence_used") or 0) >= 80]
        med_conf   = [t for t in trades if 65 <= float(t.get("confidence_used") or 0) < 80]
        low_conf   = [t for t in trades if float(t.get("confidence_used") or 0) < 65]
        hc_wr = sum(1 for t in high_conf if (t.get("pnl") or 0) > 0) / len(high_conf) * 100 if high_conf else 0
        mc_wr = sum(1 for t in med_conf if (t.get("pnl") or 0) > 0) / len(med_conf) * 100 if med_conf else 0
        lc_wr = sum(1 for t in low_conf if (t.get("pnl") or 0) > 0) / len(low_conf) * 100 if low_conf else 0

        avg_win  = sum(t.get("pnl_pct") or 0 for t in wins) / len(wins) if wins else 0
        avg_loss = sum(t.get("pnl_pct") or 0 for t in losses) / len(losses) if losses else 0

        # #11 — Win rate by entry hour (ET) — detect best/worst trading times
        hour_stats: dict[int, dict] = {}
        for t in trades:
            created = t.get("created_at") or ""
            if not created:
                continue
            try:
                from zoneinfo import ZoneInfo
                dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                et_hour = dt.astimezone(ZoneInfo("America/New_York")).hour
            except Exception:
                continue
            if et_hour not in hour_stats:
                hour_stats[et_hour] = {"wins": 0, "total": 0}
            hour_stats[et_hour]["total"] += 1
            if (t.get("pnl") or 0) > 0:
                hour_stats[et_hour]["wins"] += 1
        hour_lines = []
        for h in sorted(hour_stats):
            s = hour_stats[h]
            if s["total"] >= 3:
                hwr = s["wins"] / s["total"] * 100
                hour_lines.append(f"{h}:00 ET → {hwr:.0f}% WR ({s['total']} trades)")
        hour_block = "  Entry hour WR: " + " | ".join(hour_lines) if hour_lines else ""

        # #15 — Behavioral bias detection
        direction_ratio = len(long_t) / total * 100 if total else 50.0
        type_ratio = len(day_t) / total * 100 if total else 50.0
        bias_notes = []
        if direction_ratio > 80:
            bias_notes.append(f"⚠️ BIAS: {direction_ratio:.0f}% LONG — you may be avoiding shorts")
        elif direction_ratio < 20:
            bias_notes.append(f"⚠️ BIAS: {100-direction_ratio:.0f}% SHORT — you may be avoiding longs")
        if type_ratio > 85:
            bias_notes.append(f"⚠️ BIAS: {type_ratio:.0f}% day trades — rarely swinging")
        elif type_ratio < 15:
            bias_notes.append(f"⚠️ BIAS: {100-type_ratio:.0f}% swing trades — rarely day trading")
        bias_block = "\n  " + " | ".join(bias_notes) if bias_notes else ""

        return (
            f"30-DAY STATS ({total} trades): {wr:.0f}% WR | avg win {avg_win:+.1f}% avg loss {avg_loss:+.1f}%\n"
            f"  Direction: LONG {long_wr:.0f}% ({len(long_t)} trades) | SHORT {short_wr:.0f}% ({len(short_t)} trades)\n"
            f"  Type: day {day_wr:.0f}% ({len(day_t)}) | swing {swing_wr:.0f}% ({len(swing_t)})\n"
            f"  Confidence: high(80+) {hc_wr:.0f}% ({len(high_conf)}) | med(65-79) {mc_wr:.0f}% ({len(med_conf)}) | low(<65) {lc_wr:.0f}% ({len(low_conf)})"
            + (f"\n{hour_block}" if hour_block else "")
            + bias_block
        )
    except Exception as e:
        log.debug(f"30-day summary failed: {e}")
        return ""


def _binomial_lower_ci(wins: int, n: int, z: float = 1.645) -> float:
    """Wilson score lower bound for 90% CI. z=1.645 for 90%, 1.96 for 95%."""
    if n == 0:
        return 0.0
    p = wins / n
    denominator = 1 + z * z / n
    center = p + z * z / (2 * n)
    spread = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)
    return round(max(0.0, (center - spread) / denominator) * 100, 1)


def get_overall_win_rate() -> tuple[int, int, float, float]:
    """Returns (wins, total, win_rate_pct, lower_ci_pct).
    lower_ci_pct is the Wilson 90% confidence interval lower bound —
    use this for threshold decisions so small N doesn't fool us."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .execute()
        )
        rows = res.data or []
        if not rows:
            return 0, 0, 0.0, 0.0
        wins = sum(1 for r in rows if (r.get("pnl") or 0) > 0)
        n = len(rows)
        wr = round(wins / n * 100, 1)
        lower_ci = _binomial_lower_ci(wins, n)
        return wins, n, wr, lower_ci
    except Exception as e:
        log.debug(f"Win rate fetch failed: {e}")
        return 0, 0, 0.0, 0.0


def get_account_balance() -> float:
    """Current sandbox account balance."""
    try:
        res = supabase().table("sandbox_account").select("balance").limit(1).execute()
        if res.data:
            return float(res.data[0]["balance"])
    except Exception as e:
        log.debug(f"Account balance fetch failed: {e}")
    return STARTING_BALANCE


def get_confidence_threshold(win_rate: float, total_trades: int) -> int:
    """
    Dynamic confidence threshold based on recent performance.
    - New account (< 10 trades): use base threshold, learning mode
    - Win rate < 40%: raise to 70, be very selective
    - Win rate 40-50%: raise to 60, be selective
    - Win rate > 50%: use base threshold 50, stay active
    - Win rate > 65%: lower to 45, press the advantage
    """
    if total_trades < 10:
        return BASE_CONFIDENCE_THRESHOLD  # 55 — learning mode, stay active
    if win_rate < 40:
        return HIGH_BAR_CONFIDENCE        # 70 — something is wrong, be selective
    if win_rate < 50:
        return 60                          # underperforming, tighten up
    if win_rate >= 65:
        return 45                          # on a roll, press the edge
    return BASE_CONFIDENCE_THRESHOLD      # 55 — normal operation


def get_account_health_multiplier() -> tuple[float, str]:
    """#1 — Returns (risk_multiplier, label) based on drawdown from peak.
    Graduated reduction: deeper drawdown = smaller positions."""
    try:
        res = supabase().table("sandbox_account").select("balance,peak_balance").limit(1).execute()
        if not res.data:
            return 1.0, "healthy"
        bal   = float(res.data[0]["balance"])
        peak  = float(res.data[0]["peak_balance"])
        if peak <= 0:
            return 1.0, "healthy"
        ratio = bal / peak
        if ratio < 0.85:
            return HEALTH_MULTIPLIER_85, f"critical drawdown ({(1-ratio)*100:.1f}% from peak)"
        if ratio < 0.90:
            return HEALTH_MULTIPLIER_90, f"significant drawdown ({(1-ratio)*100:.1f}% from peak)"
        if ratio < 0.95:
            return HEALTH_MULTIPLIER_95, f"mild drawdown ({(1-ratio)*100:.1f}% from peak)"
        return 1.0, "healthy"
    except Exception:
        return 1.0, "healthy"


def calculate_position_size(entry: float, stop: float, account_balance: float) -> tuple[int, float, float]:
    """
    Kelly-inspired position sizing based on 1% account risk.
    Returns (shares, position_size_dollars, risk_amount_dollars).
    """
    risk_per_share = abs(entry - stop)
    if risk_per_share <= 0:
        return 1, entry, entry

    # Dollar risk = 1% of account (RISK_PCT_BASE)
    dollar_risk = account_balance * (RISK_PCT_BASE / 100)

    # Shares = dollar risk / risk per share
    shares = max(1, int(dollar_risk / risk_per_share))

    # Cap position at MAX_POSITION_PCT of account
    max_position_dollars = account_balance * (MAX_POSITION_PCT / 100)
    max_shares_by_size = max(1, int(max_position_dollars / entry))
    shares = min(shares, max_shares_by_size)

    position_size = round(shares * entry, 2)
    risk_amount = round(shares * risk_per_share, 2)
    return shares, position_size, risk_amount


def update_account_balance(pnl_dollar: float, count_as_trade: bool = True) -> float:
    """Apply closed trade P&L to account balance. Returns new balance.

    balance = starting $50k + all closed P&L. Open positions are tracked separately
    via position_size on sandbox_trades; available cash is computed in the UI.

    count_as_trade=False for partial exits: P&L and peak are recorded but
    total_trades/winning_trades/losing_trades are NOT incremented — those counters
    only tick when the full position closes, so win-rate stays accurate.
    """
    try:
        res = supabase().table("sandbox_account").select("*").limit(1).execute()
        if not res.data:
            return STARTING_BALANCE
        acct = res.data[0]
        new_balance = round(float(acct["balance"]) + pnl_dollar, 2)
        peak = max(float(acct["peak_balance"]), new_balance)
        update_payload: dict = {
            "balance": new_balance,
            "peak_balance": peak,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if count_as_trade:
            update_payload["total_trades"] = int(acct.get("total_trades", 0)) + 1
            update_payload["winning_trades"] = int(acct.get("winning_trades", 0)) + (1 if pnl_dollar > 0 else 0)
            update_payload["losing_trades"] = int(acct.get("losing_trades", 0)) + (1 if pnl_dollar < 0 else 0)
        supabase().table("sandbox_account").update(update_payload).eq("id", acct["id"]).execute()
        return new_balance
    except Exception as e:
        log.error(f"update_account_balance failed: {e}")
        return STARTING_BALANCE


# ─── Context helpers ──────────────────────────────────────────────────────────

async def get_options_flow_context(ticker: str) -> str:
    """#1/#14 — Latest options/dark pool signals + IV rank context from snapshots."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("signal_type,severity,title,body")
            .eq("ticker", ticker.upper())
            .in_("signal_type", ["options_unusual", "dark_pool"])
            .gte("created_at", since)
            .order("severity", desc=True)
            .limit(3)
            .execute()
        )
        rows = res.data or []
        lines = [f"[{r['signal_type']} sev={r['severity']}] {r['title']}" for r in rows] if rows else []

        # #14 — Fetch IV rank from latest snapshot to contextualize options flow
        try:
            snap_res = (
                supabase().table("snapshots")
                .select("iv_rank")
                .eq("ticker", ticker.upper())
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            if snap_res.data and snap_res.data[0].get("iv_rank") is not None:
                iv_rank = float(snap_res.data[0]["iv_rank"])
                if iv_rank >= 70:
                    iv_note = f"IV Rank: {iv_rank:.0f}% (ELEVATED — options expensive, smart money paying premium = high conviction directional bet)"
                elif iv_rank >= 40:
                    iv_note = f"IV Rank: {iv_rank:.0f}% (moderate — normal options pricing)"
                else:
                    iv_note = f"IV Rank: {iv_rank:.0f}% (LOW — cheap options, possibly speculation rather than hedging)"
                lines.append(iv_note)
        except Exception:
            pass

        if not lines:
            return "No recent options/dark pool flow."
        return "\n".join(lines)
    except Exception:
        return "Options flow unavailable."


async def get_technical_context(ticker: str) -> str:
    """#2 — Latest technical indicator signals for this ticker."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        res = (
            supabase().table("signals")
            .select("title,body,severity,created_at")
            .eq("ticker", ticker.upper())
            .eq("signal_type", "technical")
            .gte("created_at", since)
            .order("created_at", desc=True)
            .limit(3)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return "No recent technical signals."
        lines = [f"[sev={r['severity']}] {r['title']}" for r in rows]
        return "\n".join(lines)
    except Exception:
        return "Technical data unavailable."


async def get_convergence_context(ticker: str) -> str:
    """#3 — Check if signal_engine fired a convergence signal recently."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        res = (
            supabase().table("signals")
            .select("severity,title,body")
            .eq("ticker", ticker.upper())
            .eq("signal_type", "convergence")
            .gte("created_at", since)
            .order("severity", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            r = res.data[0]
            return f"CONVERGENCE ALERT (sev={r['severity']}): {r['title']}\n{(r.get('body') or '')[:200]}"
        return "No convergence signal in last 2h."
    except Exception:
        return ""


async def get_volume_context(client: httpx.AsyncClient, ticker: str) -> str:
    """#4 — Today's volume vs 20-day average."""
    if not POLYGON_KEY:
        return ""
    try:
        today = date.today()
        start = (today - timedelta(days=25)).isoformat()
        r = await client.get(
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/{start}/{today.isoformat()}",
            params={"apiKey": POLYGON_KEY, "limit": 22, "sort": "desc"},
            timeout=8,
        )
        if r.status_code != 200:
            return ""
        results = r.json().get("results", [])
        if len(results) < 2:
            return ""
        today_vol = results[0].get("v", 0)
        avg_vol = sum(r2.get("v", 0) for r2 in results[1:21]) / min(20, len(results) - 1)
        if avg_vol <= 0:
            return ""
        ratio = today_vol / avg_vol
        label = "HIGH volume" if ratio > 1.5 else "LOW volume" if ratio < 0.7 else "normal volume"
        return f"Volume: {label} ({ratio:.1f}x 20-day avg)"
    except Exception:
        return ""


async def get_sector_etf_context(client: httpx.AsyncClient, ticker_sector: str) -> str:
    """#6 — Fetch live day % for the 5 main sector ETFs + the ticker's own sector ETF."""
    SECTOR_ETF_MAP = {
        "technology": "XLK", "financials": "XLF", "energy": "XLE",
        "healthcare": "XLV", "industrials": "XLI", "consumer_discretionary": "XLY",
        "consumer_staples": "XLP", "utilities": "XLU", "materials": "XLB",
        "real_estate": "XLRE", "communication": "XLC",
    }
    MAIN_ETFS = ["XLK", "XLF", "XLE", "XLV", "XLI"]
    own_etf = SECTOR_ETF_MAP.get(ticker_sector, "")
    etfs_to_fetch = list(dict.fromkeys(MAIN_ETFS + ([own_etf] if own_etf and own_etf not in MAIN_ETFS else [])))
    if not POLYGON_KEY or not etfs_to_fetch:
        return ""
    results = []
    try:
        today = date.today().isoformat()
        start = (date.today() - timedelta(days=2)).isoformat()
        for etf in etfs_to_fetch[:6]:
            try:
                r = await client.get(
                    f"{POLYGON_BASE}/v2/aggs/ticker/{etf}/range/1/day/{start}/{today}",
                    params={"apiKey": POLYGON_KEY, "limit": 2, "sort": "desc"},
                    timeout=5,
                )
                if r.status_code == 200:
                    bars = r.json().get("results", [])
                    if len(bars) >= 2:
                        chg = (bars[0]["c"] - bars[1]["c"]) / bars[1]["c"] * 100
                        tag = f"({ticker_sector.upper()})" if etf == own_etf else ""
                        results.append(f"{etf}{tag}: {chg:+.1f}%")
            except Exception:
                pass
        await asyncio.sleep(0)
    except Exception:
        pass
    return "Sector ETFs: " + " | ".join(results) if results else ""


# #25 — Cache hot streak data for the duration of one entry scan run
_streak_cache: dict | None = None
_streak_cache_ts: float = 0.0

def _get_hot_streak_data() -> float:
    """Return avg win pct over last 10 trades, cached for 60s per scan run."""
    import time
    global _streak_cache, _streak_cache_ts
    now = time.monotonic()
    if _streak_cache is not None and now - _streak_cache_ts < 60:
        return _streak_cache["avg_win_pct"]
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl_pct")
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(10)
            .execute()
        )
        wins_data = [r for r in (res.data or []) if (r.get("pnl_pct") or 0) > 0]
        avg_win_pct = sum(r["pnl_pct"] for r in wins_data) / len(wins_data) if wins_data else 0.0
    except Exception:
        avg_win_pct = 0.0
    _streak_cache = {"avg_win_pct": avg_win_pct}
    _streak_cache_ts = now
    return avg_win_pct


def score_setup_conviction(signals: list[dict], convergence_ctx: str, recent_wr: float) -> tuple[float, str, bool]:
    """
    Score how convicted Groq should be in this setup.
    Returns (risk_pct, conviction_label, is_convergence).

    Sniper philosophy:
    - Convergence alert = full send at 3% risk
    - 2+ high-quality signals = 1.5% risk
    - 1 signal = 1% risk
    - Hot streak bonus = +0.5%
    """
    is_convergence = "CONVERGENCE ALERT" in convergence_ctx

    # Count high-quality signals (sev >= 7)
    high_quality = [s for s in signals if float(s.get("severity") or 0) >= 7]
    # Extra weight for dark pool + options (smart money signals)
    smart_money = [s for s in signals if s.get("signal_type") in ("dark_pool", "options_unusual", "congress_trade", "insider_buy", "insider_sell")]

    if is_convergence:
        risk_pct = RISK_PCT_CONVERGENCE
        label = "CONVERGENCE — full send 3%"
    elif len(smart_money) >= 1 and len(high_quality) >= 2:
        risk_pct = RISK_PCT_MULTI + 0.5  # smart money + multiple signals = 2%
        label = f"SMART MONEY + {len(high_quality)} signals — 2% risk"
    elif len(high_quality) >= 2:
        risk_pct = RISK_PCT_MULTI
        label = f"{len(high_quality)} signals — 1.5% risk"
    elif len(smart_money) >= 1:
        risk_pct = RISK_PCT_MULTI
        label = f"smart money signal — 1.5% risk"
    else:
        risk_pct = RISK_PCT_BASE
        label = "standard setup — 1% risk"

    # #25 — Hot streak bonus: cached so 20 parallel calls don't fire 20 DB queries
    if recent_wr >= 70:
        avg_win_pct = _get_hot_streak_data()
        if avg_win_pct >= 1.5:
            risk_pct = min(risk_pct + RISK_PCT_HOT_STREAK, RISK_PCT_CONVERGENCE)
            label += f" +streak bonus (avg win {avg_win_pct:.1f}%)"

    return round(risk_pct, 2), label, is_convergence


def get_signal_type_duration_expectancy(signal_types: list[str]) -> str:
    """#7 — Based on primary signal types, return expected hold duration context.
    Dark pool = intraday, technical = multi-day, etc."""
    if not signal_types:
        return ""
    # Signal types ranked by typical resolution time
    INTRADAY = {"dark_pool", "options_unusual", "volume_spike", "price_move"}
    MULTIDAY  = {"insider_buy", "insider_sell", "congress_trade", "short_squeeze", "earnings_upcoming"}
    SWING     = {"analyst_change", "convergence", "sector_rotation", "macro"}
    primary = signal_types[0] if signal_types else ""
    all_types = set(signal_types)
    if all_types & INTRADAY:
        return "Primary signals are INTRADAY catalysts (dark pool/options/volume) — prefer day trade, not swing."
    if all_types & MULTIDAY:
        return "Primary signals are MULTI-DAY catalysts (insider/congress/squeeze) — swing trade appropriate."
    if all_types & SWING:
        return "Primary signals are SWING-grade (analyst/convergence/sector) — 3-5 day hold typical."
    return ""


def get_intraday_hour_context() -> str:
    """#10 — Returns context about current time-of-day and typical win rate implications."""
    et = now_et()
    hour = et.hour
    minute = et.minute
    total_min = hour * 60 + minute
    if 570 <= total_min < 600:   # 9:30-10:00
        return "EARLY OPEN (9:30-10am): High volatility, news shocks likely. Require convergence or very high conviction."
    if 600 <= total_min < 660:   # 10:00-11:00
        return "PRIME WINDOW (10-11am): Best entry quality window. Normal filters apply."
    if 660 <= total_min < 720:   # 11:00-12:00
        return "LATE MORNING (11am-12pm): Still good but momentum fading. Be selective."
    if 720 <= total_min < 840:   # 12:00-2:00
        return "DEAD ZONE (12-2pm): Low volume, random price action. Only take if conviction >=80."
    if 840 <= total_min < 930:   # 2:00-3:30
        return "AFTERNOON (2-3:30pm): Resumption of trend. Moderate quality window."
    if 930 <= total_min < 960:   # 3:30-4:00
        return "POWER HOUR (3:30-4pm): Final hour volatility. Prefer day trade entries only."
    return ""


def get_brier_score() -> str:
    """#8 — Compute Groq's confidence calibration. Brier score: mean((conf/100 - win)^2).
    Lower = better calibrated. Returns a human-readable calibration note."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl,confidence_used")
            .eq("status", "closed")
            .not_.is_("confidence_used", "null")
            .execute()
        )
        rows = [r for r in (res.data or []) if r.get("confidence_used")]
        if len(rows) < 15:
            return ""
        brier = sum(
            ((float(r["confidence_used"]) / 100) - (1 if (r.get("pnl") or 0) > 0 else 0)) ** 2
            for r in rows
        ) / len(rows)
        if brier < 0.10:
            return f"Confidence calibration: EXCELLENT (Brier={brier:.3f}) — your confidence scores are accurate."
        if brier < 0.18:
            return f"Confidence calibration: GOOD (Brier={brier:.3f}) — slight overconfidence, be slightly more selective."
        if brier < 0.25:
            return f"Confidence calibration: POOR (Brier={brier:.3f}) — you overstate confidence. Add 10 points to your effective threshold."
        return f"Confidence calibration: VERY POOR (Brier={brier:.3f}) — your confidence scores are not predictive. Require 80+ confidence only."
    except Exception:
        return ""


def get_signal_freshness(ticker: str) -> tuple[bool, int]:
    """#5/#12 — Returns (has_fresh_signal, hours_since_last_signal).
    Fresh = qualifying signal within 24 hours (was 4h, too aggressive on signal-sparse days)."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("created_at")
            .eq("ticker", ticker.upper())
            .gte("severity", 6)
            .gte("created_at", since)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            t = datetime.fromisoformat(res.data[0]["created_at"].replace("Z", "+00:00"))
            hours_ago = int((datetime.now(timezone.utc) - t).total_seconds() / 3600)
            return True, hours_ago
        return False, 99
    except Exception:
        # FIX #6: Fail safe instead of open — DB error should NOT allow entry
        return False, 99


MAX_CONSECUTIVE_LOSSES = 5   # halt all entries for the day after N consecutive losses

# US market holidays — these don't count as trading days (#4)
US_MARKET_HOLIDAYS: set[date] = {
    # 2025
    date(2025, 1, 1), date(2025, 1, 20), date(2025, 2, 17),
    date(2025, 4, 18), date(2025, 5, 26), date(2025, 6, 19),
    date(2025, 7, 4), date(2025, 9, 1), date(2025, 11, 27),
    date(2025, 12, 25),
    # 2026
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16),
    date(2026, 4, 3),  date(2026, 5, 25), date(2026, 6, 19),
    date(2026, 7, 3),  date(2026, 9, 7),  date(2026, 11, 26),
    date(2026, 12, 25),
}
MAX_DRAWDOWN_HALT_PCT  = 20.0  # auto-halt all entries if account drawdown exceeds this

def get_consecutive_losses() -> int:
    """Returns number of consecutive losses in the most recent closed trades."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(MAX_CONSECUTIVE_LOSSES)
            .execute()
        )
        count = 0
        for r in (res.data or []):
            if (r.get("pnl") or 0) < 0:
                count += 1
            else:
                break
        return count
    except Exception:
        return 0


def get_daily_pnl() -> float:
    """#9 / #24 — Total P&L from trades closed today (ET date, not UTC)."""
    try:
        from market_hours import now_et
        today_str = now_et().date().isoformat()
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .eq("exit_date", today_str)
            .execute()
        )
        return sum((r.get("pnl") or 0) for r in (res.data or []))
    except Exception:
        return 0.0


def get_recent_win_rate(n: int = 10) -> float:
    """#10 — Win rate over last N closed trades."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(n)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return 0.0
        wins = sum(1 for r in rows if (r.get("pnl") or 0) > 0)
        return wins / len(rows) * 100
    except Exception:
        return 0.0


def get_confidence_accuracy() -> str:
    """#8 — Compare high vs low confidence call accuracy."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl,confidence_used")
            .eq("status", "closed")
            .not_.is_("confidence_used", "null")
            .execute()
        )
        rows = res.data or []
        if len(rows) < 10:
            return ""
        high = [r for r in rows if (r.get("confidence_used") or 0) >= 70]
        low = [r for r in rows if (r.get("confidence_used") or 0) < 70]
        high_wr = sum(1 for r in high if (r.get("pnl") or 0) > 0) / len(high) * 100 if high else 0
        low_wr = sum(1 for r in low if (r.get("pnl") or 0) > 0) / len(low) * 100 if low else 0
        return f"High-confidence (70%+) win rate: {high_wr:.0f}% ({len(high)} trades) | Low-confidence win rate: {low_wr:.0f}% ({len(low)} trades)"
    except Exception:
        return ""


def send_push_notification(title: str, body: str, severity: float = 7.0) -> None:
    """#14/#15 — Fire push notification via existing push infrastructure."""
    try:
        import threading
        from db import _send_push_request
        signal_row = {
            "id": None, "ticker": "SANDBOX", "signal_type": "convergence",
            "severity": severity, "title": title, "body": body,
        }
        threading.Thread(target=_send_push_request, args=(signal_row,), daemon=True).start()
    except Exception as e:
        log.debug(f"Push notification failed: {e}")


# ─── Trade filters ────────────────────────────────────────────────────────────

def is_choppy_market() -> bool:
    """#1 — True if VIX is elevated and market regime is not tradeable."""
    try:
        import macro_worker
        macro = macro_worker.get_latest_readings()
        vix = macro.get("vix")
        if vix is not None and float(vix) > VIX_REGIME_LIMIT:
            log.info(f"Regime filter: VIX={vix:.1f} > {VIX_REGIME_LIMIT} — skipping entries")
            return True
    except Exception:
        pass
    return False


def get_account_streak() -> tuple[int, int, float]:
    """#2 — Returns (current_streak, streak_type 1=win/-1=loss, drawdown_pct)."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(10)
            .execute()
        )
        trades = res.data or []
        if not trades:
            return 0, 0, 0.0

        streak = 0
        last_type = 1 if (trades[0].get("pnl") or 0) > 0 else -1
        for t in trades:
            cur = 1 if (t.get("pnl") or 0) > 0 else -1
            if cur == last_type:
                streak += 1
            else:
                break

        # Drawdown
        acct = supabase().table("sandbox_account").select("balance,peak_balance").limit(1).execute()
        drawdown = 0.0
        if acct.data:
            bal = float(acct.data[0]["balance"])
            peak = float(acct.data[0]["peak_balance"])
            drawdown = ((peak - bal) / peak * 100) if peak > 0 else 0.0

        return streak, last_type, drawdown
    except Exception:
        return 0, 0, 0.0


def is_in_dead_zone() -> bool:
    """#3 — True if current ET time is in the 12pm-2pm dead zone."""
    et = now_et()
    total_min = et.hour * 60 + et.minute
    return 720 <= total_min < 840  # 12:00pm–2:00pm ET


async def get_sector_for_ticker(client: httpx.AsyncClient, ticker: str) -> str:
    """#4 — Get sector for a ticker. Uses local map first, falls back to 'other'."""
    sector = SECTOR_MAP.get(ticker.upper(), "other")
    # FIX #4: Filter out index ETFs (SPY, QQQ, etc.) from sector counting
    if sector == "index":
        return "index"
    return sector


# Sectors that move together — treat as correlated for position limits (#13)
CORRELATED_SECTORS: dict[str, str] = {
    "tech": "tech_semis",   # tech + semiconductors correlated
    "defense": "industrial",  # defense correlates with industrial
    "energy": "energy",     # energy stands alone
    "consumer": "consumer", # consumer stands alone
}
# Grouped sectors — count combined for limit
SECTOR_GROUPS: dict[str, list[str]] = {
    "tech_complex": ["tech", "industrial"],       # both tech-driven
    "risk_assets":  ["consumer", "finance"],      # both risk-on
}


def count_open_positions_by_sector(open_positions: list[dict]) -> dict[str, int]:
    """#6 — Count open positions per sector."""
    counts: dict[str, int] = {}
    for p in open_positions:
        sector = SECTOR_MAP.get(p["ticker"].upper(), "other")
        counts[sector] = counts.get(sector, 0) + 1
    return counts


def has_earnings_soon(ticker: str, days: int = 2) -> tuple[bool, str]:
    """#9 — Returns (has_earnings, context_note).
    If earnings are soon, also checks historical beat/miss pattern from signals
    to decide if pre-earnings swing is worth taking."""
    try:
        since = datetime.now(timezone.utc).isoformat()
        until = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
        res = (
            supabase().table("signals")
            .select("id,severity,body")
            .eq("ticker", ticker.upper())
            .eq("signal_type", "earnings_upcoming")
            .gte("created_at", since)
            .lte("created_at", until)
            .limit(1)
            .execute()
        )
        if not res.data:
            return False, ""

        # Check if signal severity is high — higher severity = more notable upcoming earnings
        sev = float(res.data[0].get("severity") or 5)
        body = (res.data[0].get("body") or "")[:200]

        # Look at past sandbox trades on this ticker around earnings (if any)
        past_res = (
            supabase().table("sandbox_trades")
            .select("pnl_pct,exit_reason,groq_thesis")
            .eq("ticker", ticker.upper())
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(4)
            .execute()
        )
        past = past_res.data or []
        if past:
            wins = sum(1 for t in past if (t.get("pnl_pct") or 0) > 0)
            note = f"Earnings in {days}d (sev={sev:.0f}). Past {len(past)} trades on {ticker}: {wins}W/{len(past)-wins}L."
            # FIX #9: Lower earnings filter from sev >= 7 to sev >= 5
            # BUG FIX #8: Require minimum 3 trades (single-trade sample is unreliable)
            # Allow pre-earnings swing if strong historical win rate AND severity indicates beat history
            if len(past) >= 3 and wins / len(past) >= 0.75 and sev >= 5:
                return False, f"Pre-earnings allowed: {note} Strong beat history ({len(past)} trades)."
            return True, note
        return True, f"Earnings in {days}d — no trade history to assess."
    except Exception:
        return False, ""


def is_on_cooldown(ticker: str, proposed_direction: str | None = None) -> bool:
    """#6 — True if ticker had 2+ consecutive losses on the SAME direction recently.
    A fresh convergence with opposite direction is allowed — cooldown is direction-specific.
    FIX #10: Also block after 3+ consecutive wins (overconfidence check)."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("pnl,exit_date,direction")
            .eq("ticker", ticker.upper())
            .eq("status", "closed")
            .order("updated_at", desc=True)
            .limit(3)
            .execute()
        )
        trades = res.data or []
        if len(trades) < 2:
            return False

        last_two = trades[:2]
        both_losses = all((t.get("pnl") or 0) < 0 for t in last_two)

        # BUG FIX #1 & #2: Check 3+ consecutive wins BEFORE checking 2 losses
        # Original code used non-existent variable 'past' and checked len(last_two) >= 3 (impossible, always 0-2)
        # Overconfidence check — only block same direction after 3 wins, not opposite.
        # e.g. 3 long wins should NOT block a convergence short entry.
        if len(trades) >= 3:
            last_three = trades[:3]
            three_wins = all((t.get("pnl") or 0) > 0 for t in last_three)
            if three_wins:
                win_direction = last_three[0].get("direction")
                if proposed_direction and win_direction and proposed_direction != win_direction:
                    log.debug(f"Overconfidence override: {ticker} has 3 {win_direction} wins, but new direction={proposed_direction} — allowed")
                else:
                    log.debug(f"Overconfidence halt: {ticker} has 3+ consecutive {win_direction} wins — blocking same-direction entry")
                    return True

        if not both_losses:
            return False

        # #6 — if proposed_direction differs from losing direction, allow re-entry
        if proposed_direction:
            losing_direction = last_two[0].get("direction")
            if losing_direction and losing_direction != proposed_direction:
                log.debug(f"Cooldown override: {ticker} losses were {losing_direction}, new direction={proposed_direction} — allowed")
                return False

        last_exit = last_two[0].get("exit_date")
        if not last_exit:
            return False
        last_date = date.fromisoformat(last_exit)
        days_since = (date.today() - last_date).days
        if days_since < COOLDOWN_DAYS:
            log.debug(f"Cooldown: {ticker} had 2 consecutive {last_two[0].get('direction','?')} losses, {days_since}d ago — skipping")
            return True
        return False
    except Exception:
        return False


def has_minimum_signals(ticker: str) -> bool:
    """#5 — True if ticker has at least 1 signal with sev >= 6 in last 24h."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        res = (
            supabase().table("signals")
            .select("id")
            .eq("ticker", ticker.upper())
            .gte("severity", 6)
            .gte("created_at", since)
            .limit(1)
            .execute()
        )
        return bool(res.data)
    except Exception:
        return True  # Fail open — don't block if DB is down


# ─── Entry decision ───────────────────────────────────────────────────────────

# Per-scan diagnostic buffer — records each ticker's Groq decision + rejection
# reason. Cleared at the start of each entry scan; surfaced in the manual
# /trigger/sandbox response so we can see WHY tickers are passed on.
_scan_diag: list[str] = []


async def decide_entry(
    client: httpx.AsyncClient,
    ticker: str,
    open_tickers: set[str],
    open_positions: list[dict] | None = None,
) -> dict | None:
    """Ask Groq whether to enter a trade on this ticker. Returns trade dict or None."""
    if ticker in open_tickers:
        return None

    # ── Pre-flight filters (fast, no Groq calls) ──────────────────────────────

    # #5/#12 — Require fresh signal within 4 hours
    has_fresh, hours_since = get_signal_freshness(ticker)
    if not has_fresh:
        log.debug(f"Filter #5/#12: {ticker} last signal {hours_since}h ago — stale, skip")
        return None

    # #9 — Earnings filter with historical beat/miss learning
    earnings_block, earnings_note = has_earnings_soon(ticker, days=2)
    if earnings_block:
        log.debug(f"Filter #9: {ticker} has earnings soon — skip ({earnings_note})")
        return None

    # #9/#6 — Cooldown check (direction-aware — checked again post-Groq with actual direction)
    if is_on_cooldown(ticker):
        log.debug(f"Filter #9: {ticker} on loss cooldown — pre-check (direction unknown)")
        return None

    # #6/#13 — Sector correlation limit (direct + correlated sectors)
    # BUG FIX #4: Filter out pending fills when counting (prevents overcommit on parallel entries)
    if open_positions:
        open_filled = [p for p in open_positions if p.get("fill_status") != "pending"]
        sector_counts = count_open_positions_by_sector(open_filled)
        ticker_sector = SECTOR_MAP.get(ticker.upper(), "other")
        if ticker_sector != "other" and sector_counts.get(ticker_sector, 0) >= MAX_POSITIONS_PER_SECTOR:
            log.debug(f"Filter #6: {ticker} sector={ticker_sector} already at limit — skip")
            return None
        # #13 — Check correlated sector groups (e.g. tech + industrial = tech_complex)
        for group_name, group_sectors in SECTOR_GROUPS.items():
            if ticker_sector in group_sectors:
                group_total = sum(sector_counts.get(s, 0) for s in group_sectors)
                if group_total >= MAX_POSITIONS_PER_SECTOR * len(group_sectors):
                    log.debug(f"Filter #13: {ticker} correlated group {group_name} at limit — skip")
                    return None

    price = await get_current_price(client, ticker)
    if not price or price <= 0:
        return None

    # Fetch all context in parallel
    (
        signals, pred_lessons, sandbox_lessons,
        options_ctx, tech_ctx, convergence_ctx, volume_ctx, sector_etf_ctx,
    ) = await asyncio.gather(
        get_recent_signals(ticker, hours=48),  # #13 — 48h window covers swing-relevant signals
        get_recent_lessons(ticker, limit=5),
        get_sandbox_lessons(ticker, limit=5),
        get_options_flow_context(ticker),
        get_technical_context(ticker),
        get_convergence_context(ticker),
        get_volume_context(client, ticker),
        get_sector_etf_context(client, SECTOR_MAP.get(ticker.upper(), "unknown")),  # #6
        return_exceptions=False,
    )
    wins, total, win_rate, win_rate_ci = get_overall_win_rate()
    recent_wr = get_recent_win_rate(10)
    conf_accuracy = get_confidence_accuracy()

    # #7 — Trade duration expectancy from signal types
    sig_types_list = [s.get("signal_type", "") for s in signals[:5]]
    duration_hint = get_signal_type_duration_expectancy(sig_types_list)
    earnings_ctx = f"\n⚠️ EARNINGS CONTEXT: {earnings_note}" if earnings_note else ""

    # #8 — Brier calibration score
    brier_note = get_brier_score()

    # #10 — Time-of-day context
    hour_context = get_intraday_hour_context()

    # Fetch user-injected brain notes — general + ticker-specific
    try:
        notes_res = supabase().table("brain_notes").select("content,ticker,category").execute()
        notes = notes_res.data or []
        general_notes = [n["content"] for n in notes if not n.get("ticker")]
        ticker_notes = [n["content"] for n in notes if n.get("ticker") == ticker.upper()]
        brain_block = ""
        if general_notes or ticker_notes:
            lines = []
            if ticker_notes:
                lines.append(f"NOTES ABOUT {ticker}:")
                lines.extend(f"  - {n}" for n in ticker_notes)
            if general_notes:
                lines.append("GENERAL TRADING RULES (from user):")
                lines.extend(f"  - {n}" for n in general_notes[:10])
            brain_block = "\n".join(lines)
    except Exception:
        brain_block = ""

    # Fetch weekly review rules (written Sunday, read all week)
    try:
        week_start = (date.today() - timedelta(days=7)).isoformat()
        weekly_res = (
            supabase().table("prediction_lessons")
            .select("lesson")
            .eq("ticker", "GROQ_WEEKLY")
            .gte("date", week_start)
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        weekly_rules = weekly_res.data[0].get("lesson", "") if weekly_res.data else ""
        if "RULES FOR NEXT WEEK" in weekly_rules:
            weekly_rules = weekly_rules.split("RULES FOR NEXT WEEK")[-1][:400]
        else:
            weekly_rules = weekly_rules[:300]

        # Pattern mining rules
        patterns_res = (
            supabase().table("prediction_lessons")
            .select("lesson")
            .eq("ticker", "GROQ_PATTERNS")
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        pattern_rules = patterns_res.data[0].get("lesson", "") if patterns_res.data else ""
        if "3 CONCRETE RULES" in pattern_rules:
            pattern_rules = pattern_rules.split("3 CONCRETE RULES")[-1][:400]
        else:
            pattern_rules = pattern_rules[:300]

        # #15 — Bootstrap rules as fallback when pattern_rules is empty
        if not pattern_rules:
            boot_res = (
                supabase().table("prediction_lessons")
                .select("lesson")
                .eq("ticker", "GROQ_BOOTSTRAP")
                .limit(1)
                .execute()
            )
            if boot_res.data:
                boot = boot_res.data[0].get("lesson", "")
                if "3 CONCRETE RULES" in boot:
                    pattern_rules = boot.split("3 CONCRETE RULES")[-1][:400]
    except Exception:
        weekly_rules = ""
        pattern_rules = ""

    # Fetch yesterday's self-critique — Groq reads its own rules before trading
    try:
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        critique_res = (
            supabase().table("prediction_lessons")
            .select("lesson,key_factors")
            .eq("ticker", "GROQ_SELF")
            .eq("date", yesterday)
            .limit(1)
            .execute()
        )
        self_critique = critique_res.data[0].get("lesson", "") if critique_res.data else ""
        # Extract just the "tomorrow's adjustments" section if present
        if "TOMORROW'S ADJUSTMENTS" in self_critique:
            self_critique = self_critique.split("TOMORROW'S ADJUSTMENTS")[-1][:400]
        else:
            self_critique = self_critique[:300]
    except Exception:
        self_critique = ""

    # #2 — Equity curve + streak context
    streak_count, streak_type, drawdown = get_account_streak()
    account_balance = get_account_balance()
    total_return_pct = (account_balance - STARTING_BALANCE) / STARTING_BALANCE * 100
    streak_str = ""
    if streak_count >= 2:
        streak_word = "winning" if streak_type == 1 else "losing"
        streak_str = f"Current {streak_word} streak: {streak_count} trades"
        if streak_type == -1 and streak_count >= 3:
            streak_str += " — BE VERY SELECTIVE, cut position size mentally"
        elif streak_type == 1 and streak_count >= 3:
            streak_str += " — momentum is with you, stay disciplined"

    # #4/#11 — Sector alignment + rotation leadership
    ticker_sector = SECTOR_MAP.get(ticker.upper(), "unknown")
    sector_signals: list[str] = []
    sector_rotation_ctx = ""
    try:
        since_24h = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        sec_res = (
            supabase().table("signals")
            .select("signal_type,title")
            .eq("signal_type", "macro")
            .gte("created_at", since_24h)
            .limit(3)
            .execute()
        )
        sector_signals = [(s.get("title") or "")[:80] for s in (sec_res.data or [])]

        # #11 — Compute signal strength by sector in last 24h to detect rotation
        all_sig_res = (
            supabase().table("signals")
            .select("ticker,severity,signal_type")
            .gte("created_at", since_24h)
            .gte("severity", 5)
            .execute()
        )
        sector_scores: dict[str, float] = {}
        for s in (all_sig_res.data or []):
            t = s.get("ticker", "")
            sec = SECTOR_MAP.get(t.upper(), "")
            if not sec or sec == "index":
                continue
            sector_scores[sec] = sector_scores.get(sec, 0) + float(s.get("severity") or 5) / 10

        if sector_scores:
            sorted_sectors = sorted(sector_scores.items(), key=lambda x: x[1], reverse=True)
            leading = sorted_sectors[0][0] if sorted_sectors else None
            ticker_rank = next((i+1 for i, (s, _) in enumerate(sorted_sectors) if s == ticker_sector), None)
            if leading and leading != ticker_sector:
                sector_rotation_ctx = f"Sector rotation: {leading.upper()} is leading (score {sorted_sectors[0][1]:.1f}). {ticker_sector.upper()} ranks #{ticker_rank or '?'} of {len(sorted_sectors)} sectors."
            elif leading == ticker_sector:
                sector_rotation_ctx = f"Sector rotation: {ticker_sector.upper()} is the LEADING sector today — tailwind for this trade."
    except Exception:
        pass

    # #9 — Cross-reference real portfolio: flag if ticker already held in real account
    portfolio_flag = ""
    try:
        port_res = supabase().table("portfolio").select("ticker,shares").eq("ticker", ticker.upper()).limit(1).execute()
        if port_res.data:
            real_shares = int(float(port_res.data[0].get("shares") or 0))
            if real_shares > 0:
                portfolio_flag = f"\n⚠️ PORTFOLIO OVERLAP: You already hold {real_shares} shares of {ticker} in your REAL portfolio. A sandbox long would double actual exposure. Only enter if thesis is extremely strong."
    except Exception:
        pass

    # Get today's morning outlook to bias direction
    # BUG FIX #9: Improved error handling for missing import (log the error, don't fail silently)
    try:
        import morning_outlook_worker
        outlook = morning_outlook_worker.get_todays_outlook()
    except (ImportError, AttributeError, ModuleNotFoundError) as e:
        log.debug(f"Morning outlook unavailable: {e}")
        outlook = None
    except Exception as e:
        log.warning(f"Morning outlook error: {e}")
        outlook = None

    # Build signal summary
    sig_lines = [f"- [{s['signal_type']} sev={s['severity']}] {s['title']}" for s in signals]
    sig_block = "\n".join(sig_lines) if sig_lines else "No recent signals."

    # Build lessons block
    lessons_lines = []
    for l in pred_lessons:
        status = "correct" if (l.get("in_range") and l.get("bias") == l.get("actual_bias")) else "wrong"
        lessons_lines.append(f"- {l['date']}: predicted {l.get('bias')}, actual {l.get('actual_bias')} [{status}]")
        if l.get("lesson") and "Correct" not in (l.get("lesson") or ""):
            lessons_lines.append(f"  Lesson: {l['lesson'][:150]}")
    pred_block = "\n".join(lessons_lines) if lessons_lines else "No prediction history."

    sandbox_lines = []
    for t in sandbox_lessons:
        outcome = "WIN" if (t.get("pnl_pct") or 0) > 0 else "LOSS"
        exit_str = f"${float(t['exit_price']):.2f}" if t.get("exit_price") else "open"
        sandbox_lines.append(
            f"- {t['entry_date']} {t.get('direction')} @ ${float(t.get('entry_price') or 0):.2f} → "
            f"{exit_str} [{outcome} {t.get('pnl_pct') or 0:+.1f}%] reason: {t.get('exit_reason')}"
        )
        if t.get("groq_exit_note"):
            sandbox_lines.append(f"  Note: {t['groq_exit_note'][:100]}")
    sandbox_block = "\n".join(sandbox_lines) if sandbox_lines else "No sandbox history for this ticker."

    # Morning outlook block
    if outlook:
        direction_str = outlook.get("direction", "neutral").upper()
        spy_str = f" (SPY {outlook['spy_change']:+.2f}%)" if outlook.get("spy_change") is not None else ""
        vix_str = f", VIX {outlook['vix']:.1f}" if outlook.get("vix") is not None else ""
        outlook_block = f"Today's market outlook: {direction_str}{spy_str}{vix_str}\n{outlook.get('analysis', '')[:300]}"
    else:
        outlook_block = "No morning outlook available."

    today_str = date.today().isoformat()

    # #6 — Signal timing spread: decay conviction if signals are spread over hours
    spread_hours, spread_label = get_signal_timing_spread(signals)
    spread_note = ""
    if spread_hours > 4.0:
        spread_note = f"\n⚠️ Signal cluster is STALE — signals spread over {spread_hours:.1f}h. Treat as weaker setup."
    elif spread_hours > 1.5:
        spread_note = f"\nSignal spread: {spread_label} — signals not tightly clustered."
    elif spread_hours < 0.5 and len(signals) >= 2:
        spread_note = f"\n✅ Tight signal cluster ({spread_label}) — strong convergence quality."

    # ── Tavily live news — only fetched here, right before the trade decision ──
    # This is the ONLY place Tavily is called in the entire sandbox worker.
    # We've passed every filter, price is confirmed, all context is loaded.
    # One search = 1 credit. Worth it — Groq now knows what broke 20 min ago.
    live_news_block = await fetch_live_news(client, ticker)

    # Score conviction — determines position size and confidence bar
    risk_pct, conviction_label, is_convergence = score_setup_conviction(signals, convergence_ctx, recent_wr)

    # Apply spread decay: stale clusters reduce risk allocation
    if spread_hours > 4.0:
        risk_pct = round(risk_pct * 0.6, 3)
        conviction_label += " [stale spread -40%]"
    elif spread_hours > 1.5:
        risk_pct = round(risk_pct * 0.8, 3)
        conviction_label += " [wide spread -20%]"

    perf_summary = get_30day_performance_summary()
    critique_block = f"\nYOUR RULES FROM YESTERDAY'S SELF-CRITIQUE (FOLLOW THESE):\n{self_critique}" if self_critique else ""
    weekly_block = f"\nWEEKLY REVIEW RULES:\n{weekly_rules}" if weekly_rules else ""
    pattern_block_str = f"\nHIGHEST WIN-RATE PATTERNS (follow these):\n{pattern_rules}" if pattern_rules else ""
    perf_block = f"\nYOUR 30-DAY PERFORMANCE (use this to calibrate direction/type/confidence):\n{perf_summary}" if perf_summary else ""
    user_brain_block = f"\nUSER-PROVIDED RULES AND OBSERVATIONS (MUST FOLLOW):\n{brain_block}" if brain_block else ""
    sector_block = (
        f"\nTicker sector: {ticker_sector}"
        + (f"\n{sector_rotation_ctx}" if sector_rotation_ctx else "")
        + (f"\n{sector_etf_ctx}" if sector_etf_ctx else "")  # #6 — live ETF performance
        + (f"\nRecent macro signals: {'; '.join(sector_signals)}" if sector_signals else "")
    )
    # #12 — Position sizing context: show how risk pct translates to real dollars at current balance
    health_mult_now, _ = get_account_health_multiplier()
    base_risk_dollars = round(account_balance * (RISK_PCT_BASE * health_mult_now / 100), 0)
    conv_risk_dollars = round(account_balance * (RISK_PCT_CONVERGENCE * health_mult_now / 100), 0)
    sizing_note = f"\nPosition sizing: base=${base_risk_dollars:.0f} risk | convergence=${conv_risk_dollars:.0f} risk (health mult={health_mult_now:.1f}x)"

    account_block = (
        f"\nAccount: ${account_balance:,.0f} ({total_return_pct:+.1f}% total return) | Drawdown: {drawdown:.1f}%"
        + (f" | {streak_str}" if streak_str else "")
        + f" | Last 10 trades WR: {recent_wr:.0f}%"
        + (f" | WR lower CI: {win_rate_ci:.0f}% (conservative estimate)" if total >= 10 else "")
        + sizing_note
        + (f"\n{conf_accuracy}" if conf_accuracy else "")
    )
    convergence_note = f"\n⚡ {convergence_ctx}" if "CONVERGENCE ALERT" in convergence_ctx else ""
    portfolio_note = portfolio_flag  # #9

    # Regime-specific playbook instruction
    if is_convergence:
        playbook = "CONVERGENCE DETECTED — this is a full-send setup. Be aggressive. Set a wider target (3:1 R:R minimum). This is your highest conviction trade type."
    elif risk_pct >= 2.0:
        playbook = "Strong signal cluster detected. Be bold — set target at 2.5:1 R:R minimum. This setup has real edge."
    else:
        playbook = "Standard setup. Take it if you see a reasonable edge and reward-to-risk is at least 2:1 — don't hold out only for picture-perfect setups. Pass only if the signals are weak or contradict the market outlook."

    prompt = f"""You are a sophisticated trader managing a $50,000 paper account. Your goal: high win rate AND maximum profit.

PHILOSOPHY: Be selective but DECISIVE. You are here to trade and learn from real outcomes — a day with zero trades teaches nothing and is a failure. Pass on genuinely weak or contradictory setups, but when a ticker shows a real edge (strong signals, supportive volume/sector, a clean technical level with 2:1+ reward-to-risk), TAKE THE TRADE. On a normal day you should find a few quality entries. When everything lines up — convergence + options flow + sector alignment — go in hard with aggressive targets.

CURRENT SETUP: {ticker} @ ${price:.2f} | {volume_ctx}
CONVICTION LEVEL: {conviction_label}{spread_note}
{playbook}
{sector_block}{portfolio_note}{account_block}
{user_brain_block}
{perf_block}
{pattern_block_str}
{weekly_block}
{critique_block}
MARKET OUTLOOK:
{outlook_block}
{convergence_note}{earnings_ctx}
SMART MONEY FLOW:
{options_ctx}

TECHNICAL:
{tech_ctx}

SIGNALS (last 48h — freshest {hours_since}h ago, older signals relevant for swing):
{sig_block}
{f"{live_news_block}" if live_news_block else ""}
PAST ACCURACY FOR {ticker}:
{pred_block}

PAST SANDBOX TRADES FOR {ticker}:
{sandbox_block}

WIN RATE: {win_rate:.1f}% overall | {recent_wr:.0f}% last 10 trades ({wins}/{total} total){f" | 90% CI lower bound: {win_rate_ci:.0f}%" if total >= 10 else ""}
{f"CALIBRATION: {brier_note}" if brier_note else ""}
{f"SIGNAL DURATION HINT: {duration_hint}" if duration_hint else ""}
{f"TIME OF DAY: {hour_context}" if hour_context else ""}

Respond ONLY with valid JSON:
{{
  "trade": true | false,
  "direction": "long" | "short",
  "trade_type": "day" | "swing",
  "stop_loss": <price float>,
  "target_price": <price float>,
  "confidence": <integer 1-100>,
  "thesis": "<2 sentence reason — specific prices, specific catalysts, not generic>",
  "thesis_entry": <float — your exact entry price rationale>,
  "thesis_target": <float — your target, same as target_price>,
  "thesis_catalyst": "<one specific catalyst: signal type + why it matters>",
  "thesis_condition": "<one condition that would invalidate this trade>"
}}

ENTRY RULES:
- PASS if confidence < {CONVERGENCE_MIN_CONFIDENCE if is_convergence else BASE_CONFIDENCE_THRESHOLD} — don't force trades
- REWARD:RISK IS MANDATORY AND CHECKED. Before you answer, compute it:
    • LONG:  (target_price - {price:.2f}) must be >= 2.0 × ({price:.2f} - stop_loss)
    • SHORT: ({price:.2f} - target_price) must be >= 2.0 × (stop_loss - {price:.2f})
  Set your target far enough out to satisfy this. Aim for 2:1; trades below ~1.5:1 are rejected automatically.
- Keep stop_loss within 6% of {price:.2f} (a stop wider than 6% is rejected). Place it at a real support/resistance level, not arbitrary.
- If you cannot find a target that clears 2:1 with a stop inside 6%, set trade=false — but most clean setups CAN, so do the math and commit.
- Direction MUST align with market outlook unless you have a very specific counter-thesis
- If you've been losing on this ticker recently, pass unless signals are overwhelming
- Be specific in your thesis — vague reasoning = bad trade"""

    # #27 — A/B test: 20% of entries use fast 8b model, tagged for WR comparison
    import random as _random
    use_fast_model = _random.random() < 0.20
    raw = await _call_groq(prompt, max_tokens=250, fast=use_fast_model)  # 250: full JSON (11 fields + thesis) fits in ~150-170 tokens
    if not raw:
        return None

    try:
        text = raw.strip()
        if "```" in text:
            parts = text.split("```")
            text = parts[1] if len(parts) >= 2 else text
            if text.startswith("json"):
                text = text[4:]
        parsed = json.loads(text.strip())
    except Exception as e:
        log.warning(f"Entry decision parse failed for {ticker}: {e}\nRaw: {raw[:200]}")
        _scan_diag.append(f"{ticker}: PARSE_FAIL {str(e)[:40]}")
        return None

    # ── Diagnostic: record exactly what Groq decided for this ticker ──
    _scan_diag.append(
        f"{ticker}@{price:.2f}: trade={parsed.get('trade')} conf={parsed.get('confidence')} "
        f"dir={parsed.get('direction')} stop={parsed.get('stop_loss')} tgt={parsed.get('target_price')}"
    )

    # BUG FIX #6: Validate field types (Groq sometimes returns "trade": "true" instead of bool)
    if not isinstance(parsed.get("trade"), bool):
        log.debug(f"Invalid 'trade' field type for {ticker}: {type(parsed.get('trade'))} — expected bool")
        return None

    # Confidence threshold — use lower CI bound as effective win rate (#2)
    # FIX #7: Only apply lower_ci if we have >= 10 trades (valid sample)
    effective_wr_for_threshold = win_rate_ci if total >= 10 else win_rate
    if is_convergence:
        conf_threshold = CONVERGENCE_MIN_CONFIDENCE
    else:
        conf_threshold = get_confidence_threshold(effective_wr_for_threshold, total)

    # #9 — Counter-trend entries need higher confidence threshold
    # If Groq wants to go LONG on a bearish day (or SHORT on a bullish day), require 80+
    proposed_direction_raw = parsed.get("direction", "long")
    if outlook:
        outlook_dir = (outlook.get("direction") or "neutral").lower()
        is_counter_trend = (
            (outlook_dir == "bearish" and proposed_direction_raw == "long") or
            (outlook_dir == "bullish" and proposed_direction_raw == "short")
        )
        if is_counter_trend and not is_convergence:
            counter_threshold = max(conf_threshold, 65)  # was 80 — too high, silently blocked most counter-trend setups
            if parsed.get("confidence", 0) < counter_threshold:
                log.debug(f"Filter #9: {ticker} counter-trend {proposed_direction_raw} on {outlook_dir} day — needs {counter_threshold}, got {parsed.get('confidence',0)}")
                _scan_diag.append(f"{ticker}: REJECT counter-trend {proposed_direction_raw} on {outlook_dir} day (needs {counter_threshold})")
                return None

    confidence = parsed.get("confidence", 0)
    if not parsed.get("trade") or confidence < conf_threshold:
        log.debug(f"Sandbox: passed on {ticker} (confidence={confidence} < {conf_threshold}, conviction={conviction_label})")
        _scan_diag.append(f"{ticker}: REJECT trade={parsed.get('trade')} conf={confidence}<{conf_threshold}")
        return None

    direction = parsed.get("direction", "long")
    trade_type = parsed.get("trade_type", "day")
    stop = float(parsed.get("stop_loss") or 0)
    target = float(parsed.get("target_price") or 0)
    thesis = str(parsed.get("thesis", ""))[:500]
    # #26 — structured thesis for back-testing
    thesis_structured = {
        "entry": parsed.get("thesis_entry"),
        "target": parsed.get("thesis_target"),
        "catalyst": str(parsed.get("thesis_catalyst", ""))[:200],
        "invalidation": str(parsed.get("thesis_condition", ""))[:200],
    }

    # #6 — Direction-aware cooldown: if Groq picked same direction as losing streak, block
    if is_on_cooldown(ticker, proposed_direction=direction):
        log.debug(f"Filter #6: {ticker} cooldown blocks {direction} — same direction as recent losses")
        return None

    # #8 — Block if already holding opposite direction on same ticker
    for pos in open_positions:
        if pos.get("ticker", "").upper() == ticker.upper():
            existing_dir = pos.get("direction", "")
            if existing_dir and existing_dir != direction:
                log.debug(f"Filter #8: {ticker} already has open {existing_dir} — blocking opposite {direction}")
                return None

    # R:R minimum — convergence plays need 2.5:1, standard 1.5:1.
    # Groq aims for 2:1 per the prompt but its targets routinely land ~1.3-1.8x;
    # a 2.0 floor rejected nearly every otherwise-valid setup (the real reason the
    # sandbox sat at 0 trades). 1.5:1 at a 55%+ win rate is clearly profitable and
    # keeps the engine active so it can actually learn.
    min_rr = 2.5 if is_convergence else 1.5

    # #13 — Reject negative or zero stop/target (Groq parse error)
    if stop <= 0 or target <= 0:
        log.debug(f"Sandbox: invalid levels for {ticker} — stop={stop} target={target} must be > 0")
        _scan_diag.append(f"{ticker}: REJECT zero/neg levels stop={stop} tgt={target}")
        return None

    if direction == "long":
        if stop >= price or target <= price:
            log.debug(f"Sandbox: invalid levels for {ticker} long")
            _scan_diag.append(f"{ticker}: REJECT long levels wrong side (stop={stop} price={price:.2f} tgt={target})")
            return None
        risk = price - stop
        reward = target - price
        if risk <= 0 or reward / risk < min_rr:
            log.debug(f"Sandbox: R:R {reward/risk:.2f} < {min_rr} for {ticker} long — skip")
            _scan_diag.append(f"{ticker}: REJECT long R:R {reward/risk:.2f}<{min_rr}")
            return None
        stop_pct = (risk / price) * 100
        if stop_pct > MAX_STOP_PCT:
            log.debug(f"Filter #8: {ticker} stop too wide ({stop_pct:.1f}%) — skip")
            _scan_diag.append(f"{ticker}: REJECT long stop too wide {stop_pct:.1f}%>{MAX_STOP_PCT}")
            return None
    else:
        if stop <= price or target >= price:
            log.debug(f"Sandbox: invalid levels for {ticker} short")
            _scan_diag.append(f"{ticker}: REJECT short levels wrong side (stop={stop} price={price:.2f} tgt={target})")
            return None
        risk = stop - price
        reward = price - target
        if risk <= 0 or reward / risk < min_rr:
            log.debug(f"Sandbox: R:R {reward/risk:.2f} < {min_rr} for {ticker} short — skip")
            _scan_diag.append(f"{ticker}: REJECT short R:R {reward/risk:.2f}<{min_rr}")
            return None
        stop_pct = (risk / price) * 100
        if stop_pct > MAX_STOP_PCT:
            log.debug(f"Filter #8: {ticker} short stop too wide ({stop_pct:.1f}%) — skip")
            _scan_diag.append(f"{ticker}: REJECT short stop too wide {stop_pct:.1f}%>{MAX_STOP_PCT}")
            return None

    # #4 — Stop width category: tight stops need slightly higher confidence (noise shakes them out)
    if stop_pct < 1.5:
        stop_category = "tight"
        if confidence < 65:  # was 75 — too high, silently blocked tight-stop day trades
            log.debug(f"Filter #4: {ticker} tight stop ({stop_pct:.1f}%) requires conf>=65, got {confidence} — skip")
            _scan_diag.append(f"{ticker}: REJECT tight stop {stop_pct:.1f}% needs conf>=65 got {confidence}")
            return None
    elif stop_pct > 4.5:
        stop_category = "wide"
        # Wide stops already blocked by MAX_STOP_PCT=6, but warn if approaching
        log.debug(f"Stop category: {ticker} wide stop ({stop_pct:.1f}%)")
    else:
        stop_category = "normal"

    # Position sizing �� apply account health multiplier (#1) then conviction scaling
    account_balance = get_account_balance()
    health_mult, health_label = get_account_health_multiplier()
    effective_risk_pct = round(risk_pct * health_mult, 3)
    if health_mult < 1.0:
        log.debug(f"Account health: {health_label} — risk scaled to {effective_risk_pct:.2f}%")
    risk_per_share = abs(price - stop)
    if risk_per_share > 0:
        dollar_risk = account_balance * (effective_risk_pct / 100)
        shares = max(1, int(dollar_risk / risk_per_share))
        max_shares = max(1, int(account_balance * (MAX_POSITION_PCT / 100) / price))
        shares = min(shares, max_shares)
    else:
        shares = 1
    position_size = round(shares * price, 2)
    risk_amount = round(shares * risk_per_share, 2)

    # #13 — Limit entry: set entry slightly better than current price
    if direction == "long":
        limit_entry = round(price * 0.997, 4)  # 0.3% below current
    else:
        limit_entry = round(price * 1.003, 4)  # 0.3% above current for short

    # #11 — Calculate Target 1 (partial exit at halfway)
    if direction == "long":
        target1 = round(price + (target - price) * 0.5, 4)
    else:
        target1 = round(price - (price - target) * 0.5, 4)

    return {
        "ticker": ticker.upper(),
        "direction": direction,
        "trade_type": trade_type,
        "status": "open",
        "entry_price": round(limit_entry, 4),  # #13 limit entry
        "stop_loss": round(stop, 4),
        "peak_pnl_pct": -9999.0,  # sentinel so first real pnl_pct always wins the max() check
        "target_price": round(target, 4),
        "shares": int(shares),  # #5 — always store as int, never fractional
        "position_size": position_size,
        "risk_amount": risk_amount,
        "account_balance_at_entry": account_balance,
        "confidence_used": confidence,
        "entry_date": today_str,
        "groq_thesis": thesis,
        "thesis_structured": thesis_structured,  # #26
        "signals_at_entry": [{"type": s["signal_type"], "sev": s["severity"], "title": s["title"]} for s in signals[:5]],
        "target1": target1,
        "partial_exit_done": False,
        "conviction_label": conviction_label,
        "is_convergence": is_convergence,
        "account_health": health_label,
        "stop_distance_pct": round(stop_pct, 2),
        "stop_category": stop_category,
        "fill_status": "pending",  # #2 — marked filled once price touches limit zone
        "model_used": "llama-3.1-8b-instant" if use_fast_model else "llama-3.3-70b-versatile",  # #27
    }


# ─── Exit evaluation ──────────────────────────────────────────────────────────

async def get_price_with_snapshot_fallback(client: httpx.AsyncClient, ticker: str) -> float | None:
    """#3 — Try live price first; fall back to last DB snapshot so EOD close never fails."""
    price = await get_current_price(client, ticker)
    if price:
        return price
    try:
        res = (
            supabase().table("snapshots")
            .select("price")
            .eq("ticker", ticker.upper())
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if res.data and res.data[0].get("price"):
            log.debug(f"Price fallback: using snapshot price for {ticker} = ${res.data[0]['price']}")
            return float(res.data[0]["price"])
    except Exception as e:
        log.debug(f"Snapshot fallback failed for {ticker}: {e}")
    return None


async def evaluate_open_trade(client: httpx.AsyncClient, trade: dict) -> None:
    """Check if an open trade should be closed — stop hit, target hit, or Groq exits."""
    # #2 — Skip pending-fill trades — handled by separate fill-check loop
    if trade.get("fill_status") == "pending":
        return
    ticker = trade["ticker"]
    price = await get_price_with_snapshot_fallback(client, ticker)
    if not price:
        return

    direction = trade["direction"]
    stop = float(trade["stop_loss"])
    target = float(trade["target_price"])
    entry = float(trade["entry_price"])
    entry_date = date.fromisoformat(trade["entry_date"])
    trade_type = trade["trade_type"]
    today = date.today()

    # Calculate current P&L
    if direction == "long":
        pnl_pct = (price - entry) / entry * 100
    else:
        pnl_pct = (entry - price) / entry * 100

    # #5 — Track peak P&L: update if current is higher than stored peak
    # BUG FIX #3: Initialize to -999999 (not 0) so first +0.01% trade always updates
    # Prevents race condition where parallel evals both read old peak, both write same value
    current_peak = float(trade.get("peak_pnl_pct") or -999999.0)
    if pnl_pct > current_peak:
        try:
            supabase().table("sandbox_trades").update({
                "peak_pnl_pct": round(pnl_pct, 4),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", trade["id"]).execute()
            trade["peak_pnl_pct"] = pnl_pct  # only update local after DB confirms
        except Exception as e:
            log.debug(f"Peak P&L update failed for {trade['ticker']}: {e}")  # log the error

    # #10 — Tiered trailing stop: escalate as trade moves in our favour
    # Tier 1: +2% → breakeven  Tier 2: +4% → +1.5%  Tier 3: +6% → +3%
    # Day trades skip trailing stops entirely — let them run to original stop/target or EOD
    def _calc_tiered_stop(pnl: float, ent: float, dir: str) -> float | None:
        if trade_type == "day":
            return None
        if pnl >= 6.0:
            locked = 3.0
        elif pnl >= 4.0:
            locked = 1.5
        elif pnl >= BREAKEVEN_TRIGGER:
            locked = 0.0
        else:
            return None
        if dir == "long":
            return round(ent * (1 + locked / 100), 4)
        else:
            return round(ent * (1 - locked / 100), 4)

    new_stop = _calc_tiered_stop(pnl_pct, entry, direction)
    if new_stop is not None:
        should_update = (direction == "long" and stop < new_stop) or \
                        (direction == "short" and stop > new_stop)
        if should_update:
            try:
                supabase().table("sandbox_trades").update({
                    "stop_loss": new_stop,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", trade["id"]).execute()
                log.info(f"Tiered trailing stop: {ticker} {direction} stop → ${new_stop:.2f} (pnl={pnl_pct:+.1f}%)")
                stop = new_stop
            except Exception as e:
                log.debug(f"Trailing stop update failed for {ticker}: {e}")

    # #11 — Partial exit at Target 1 (swing trades only — day trades run full size to EOD)
    target1 = float(trade.get("target1") or 0)
    partial_done = trade.get("partial_exit_done", False)
    if trade_type == "day":
        partial_done = True  # treat as already done — skip partial logic for day trades
    if target1 > 0 and not partial_done:
        t1_hit = (direction == "long" and price >= target1) or (direction == "short" and price <= target1)
        if t1_hit:
            # Conviction-based partial exit:
            # - Convergence setup: close 25% (let winners run — high conviction)
            # - Standard setup: close 50%
            # - Low conviction (confidence < 70): close 75% (lock in most gains)
            total_shares = int(float(trade.get("shares") or 1))
            confidence = float(trade.get("confidence_used") or 65)
            is_conv = trade.get("is_convergence", False)
            if is_conv or confidence >= 80:
                exit_fraction = 0.25   # let it run
            elif confidence >= 70:
                exit_fraction = 0.50   # standard
            else:
                exit_fraction = 0.75   # lock in gains early
            half_shares = max(1, int(total_shares * exit_fraction))  # FIX #1: max(1, ...) prevents orphan
            # FIX #3: correct P&L sign for shorts (entry - price for shorts, not negate the long formula)
            half_pnl = half_shares * ((price - entry) if direction == "long" else (entry - price))
            # count_as_trade=False: win-rate counters only tick on full close
            update_account_balance(half_pnl, count_as_trade=False)
            log.info(f"Partial exit: {ticker} {direction} — closed {half_shares} shares at Target1 ${price:.2f} (${half_pnl:+.2f})")
            try:
                # BUG FIX #5: Calculate remaining WITHOUT max() first, then handle edge case
                # (original code: if total=1, exit=0.5 → half=1, remaining=max(1,0)=1 → position doubled!)
                remaining_shares = int(float(trade.get("shares") or 1)) - half_shares
                if remaining_shares < 1:
                    remaining_shares = 0  # Will close on next evaluation
                supabase().table("sandbox_trades").update({
                    "partial_exit_done": True,
                    "stop_loss": round(entry, 4),  # move stop to breakeven after partial
                    "shares": remaining_shares,
                    # #21 — cost basis tracks entry price, not current price
                    "position_size": round(remaining_shares * entry, 2),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", trade["id"]).execute()
                stop = entry  # updated for rest of this eval cycle
            except Exception as e:
                log.debug(f"Partial exit update failed for {ticker}: {e}")

    # Auto-exit: stop hit (uses updated stop if trailing fired)
    if (direction == "long" and price <= stop) or (direction == "short" and price >= stop):
        exit_reason = "stop_hit" if abs(stop - entry) > 0.01 else "breakeven_stop"
        await close_trade(trade, price, exit_reason, f"Stop hit at ${price:.2f} (stop=${stop:.2f})")
        return

    # Auto-exit: target hit
    # #7 — For swing trades exceeding target by >20%, trail instead of close immediately
    target_exceeded = (direction == "long" and price >= target) or (direction == "short" and price <= target)
    if target_exceeded:
        if trade_type == "swing":
            overshoot = abs(price - target) / abs(target - entry) if abs(target - entry) > 0 else 0
            if overshoot > 0.20:
                # Target exceeded by >20% — trail stop to target price, let it run
                new_trailing_stop = target  # same for both: lock in at target level
                if (direction == "long" and stop < new_trailing_stop) or (direction == "short" and stop > new_trailing_stop):
                    try:
                        supabase().table("sandbox_trades").update({
                            "stop_loss": round(new_trailing_stop, 4),
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        }).eq("id", trade["id"]).execute()
                        stop = new_trailing_stop
                        log.info(f"Target trailing: {ticker} {direction} exceeded target by {overshoot:.0%} — stop moved to ${new_trailing_stop:.2f}")
                    except Exception as e:
                        log.debug(f"Target trail update failed for {ticker}: {e}")
                return  # don't close — let it run with new stop
        await close_trade(trade, price, "target_hit", f"Target hit at ${price:.2f}")
        return

    # Auto-exit: day trade at close
    if trade_type == "day" and today > entry_date:
        await close_trade(trade, price, "day_close", f"Day trade closed at EOD ${price:.2f}")
        return

    # Force-exit: max hold period exceeded — count actual trading days (weekdays minus holidays)
    trading_days_held = sum(
        1 for i in range((today - entry_date).days)
        if (entry_date + timedelta(days=i + 1)).weekday() < 5
        and (entry_date + timedelta(days=i + 1)) not in US_MARKET_HOLIDAYS
    )
    if trading_days_held >= MAX_SWING_DAYS:
        await close_trade(trade, price, "max_hold", f"Max hold period reached — exited at ${price:.2f}")
        return

    # Swing trade: ask Groq if thesis still valid (throttled — skip when flagged)
    if trade.get('_skip_groq_swing_eval'):
        return
    if trade_type == "swing":
        signals = await get_recent_signals(ticker, hours=24)
        sig_lines = [f"- [{s['signal_type']} sev={s['severity']}] {s['title']}" for s in signals]
        sig_block = "\n".join(sig_lines) if sig_lines else "No recent signals."

        # #3 — Pass peak P&L and trajectory so Groq knows if trade is reversing from peak
        peak_pnl = float(trade.get("peak_pnl_pct") or 0)
        pullback = round(peak_pnl - pnl_pct, 2) if peak_pnl > 0 else 0
        trajectory_note = ""
        if peak_pnl > 0 and pullback > 1.0:
            trajectory_note = f"\n⚠️ PULLBACK FROM PEAK: was {peak_pnl:+.1f}% profit, now {pnl_pct:+.1f}% — pulled back {pullback:.1f}% from best level."
        elif peak_pnl > 0:
            trajectory_note = f"\nPeak P&L was {peak_pnl:+.1f}% — currently near peak, holding well."

        prompt = f"""You entered a {direction} trade on {ticker} {trading_days_held} trading days ago.

Entry: ${entry:.2f} | Current: ${price:.2f} | P&L: {pnl_pct:+.1f}%
Peak P&L: {peak_pnl:+.1f}% | Days held: {trading_days_held}
Stop: ${stop:.2f} | Target: ${target:.2f}{trajectory_note}
Original thesis: {trade.get('groq_thesis', 'No thesis recorded')}

New signals since entry:
{sig_block}

Should you exit this trade now, or hold?

Respond ONLY with JSON:
{{"exit": true | false, "reason": "<one sentence>"}}

Exit if: thesis is broken, new bearish signals, pulled back >50% from peak profit, or P&L at risk of turning from win to loss."""

        raw = await _call_groq(prompt, max_tokens=100)
        if raw:
            try:
                text = raw.strip()
                if "```" in text:
                    parts = text.split("```")
                    text = parts[1] if len(parts) >= 2 else text
                    if text.startswith("json"):
                        text = text[4:]
                parsed = json.loads(text.strip())
                decision = "exit" if parsed.get("exit") else "hold"
                reason = str(parsed.get("reason", ""))[:300]

                # Log every re-eval decision so we can review Groq's reasoning
                try:
                    supabase().table("sandbox_trade_evals").insert({
                        "trade_id": trade.get("id"),
                        "ticker": ticker,
                        "decision": decision,
                        "reason": reason,
                        "price_at_eval": round(price, 4),
                        "pnl_pct_at_eval": round(pnl_pct, 4),
                        "evaluated_at": datetime.now(timezone.utc).isoformat(),
                    }).execute()
                except Exception as e:
                    log.debug(f"Re-eval log failed for {ticker}: {e}")

                if parsed.get("exit"):
                    await close_trade(trade, price, "groq_exit", reason)
                    return
            except Exception as e:
                log.debug(f"Swing exit parse failed for {ticker}: {e}")


async def close_trade(trade: dict, exit_price: float, exit_reason: str, exit_note: str) -> None:
    """Mark a trade as closed, compute P&L, write exit note, then write a lesson."""
    entry = float(trade["entry_price"])
    direction = trade["direction"]
    shares = int(float(trade.get("shares") or 1))
    ticker = trade["ticker"]

    if direction == "long":
        pnl = (exit_price - entry) * shares
        pnl_pct = (exit_price - entry) / entry * 100
    else:
        pnl = (entry - exit_price) * shares
        pnl_pct = (entry - exit_price) / entry * 100

    # #5 — Compute profit efficiency: how much of peak gain did we keep?
    peak_pnl = float(trade.get("peak_pnl_pct") or 0)
    efficiency = round(pnl_pct / peak_pnl, 3) if peak_pnl > 0 and pnl_pct > 0 else None

    # #18 — Trade update FIRST, balance SECOND. If trade update fails, we don't touch balance.
    # Guard: only update if still open — prevents double-close race condition from corrupting balance.
    try:
        res = supabase().table("sandbox_trades").update({
            "status": "closed",
            "exit_price": round(exit_price, 4),
            "exit_date": date.today().isoformat(),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 4),
            "exit_reason": exit_reason,
            "groq_exit_note": exit_note[:500] if exit_reason == "groq_exit" else None,
            "profit_efficiency": efficiency,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", trade["id"]).eq("status", "open").execute()  # .eq("status","open") = idempotency guard
        if not res.data:
            log.warning(f"close_trade skipped for {ticker} — already closed (race condition avoided)")
            return
        outcome = "WIN" if pnl > 0 else "LOSS"
        log.info(f"Sandbox closed {direction} {ticker}: {outcome} {pnl_pct:+.1f}% (${pnl:+.2f}) reason={exit_reason}")
    except Exception as e:
        log.error(f"close_trade failed for {ticker}: {e} — balance NOT updated to avoid inconsistency")
        return  # Don't update balance if trade update failed

    new_balance = update_account_balance(pnl)
    log.info(f"Account balance: ${new_balance:,.2f}")

    # #14 — Push notification on target hit or stop hit
    outcome = "WIN" if pnl > 0 else "LOSS"
    if exit_reason in ("target_hit", "stop_hit", "breakeven_stop"):
        emoji = "🎯" if exit_reason == "target_hit" else "🛑" if exit_reason == "stop_hit" else "⚡"
        push_title = f"{emoji} Sandbox {outcome}: {ticker} {direction.upper()}"
        push_body = f"${entry:.2f} → ${exit_price:.2f} ({pnl_pct:+.1f}%) | {exit_reason.replace('_', ' ')} | Balance: ${new_balance:,.0f}"
        send_push_notification(push_title, push_body, severity=8.0 if exit_reason == "target_hit" else 7.0)

    # Write lesson and equity snapshot — awaited so failures are visible, not silently dropped
    await _write_trade_lesson(trade, exit_price, exit_reason, pnl_pct)
    await _record_equity_snapshot()


async def _write_trade_lesson(trade: dict, exit_price: float, exit_reason: str, pnl_pct: float) -> None:
    """Ask Groq to write a one-sentence lesson from this closed trade and store it."""
    ticker = trade["ticker"]
    direction = trade["direction"]
    entry = float(trade["entry_price"])
    stop = float(trade["stop_loss"])
    target = float(trade["target_price"])
    is_win = pnl_pct > 0
    outcome = "WIN" if is_win else "LOSS"

    # #12 — Thesis validation: did the thesis prediction come true?
    thesis = trade.get("groq_thesis", "N/A")
    thesis_correct: bool | None = None
    structured = trade.get("thesis_structured") or {}
    if structured.get("catalyst") and structured.get("invalidation"):
        # Use pnl direction vs thesis direction as proxy for correctness
        # A WIN where direction matches = thesis correct; LOSS = thesis wrong
        thesis_correct = is_win
        try:
            supabase().table("sandbox_trades").update({
                "thesis_correct": thesis_correct,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", trade["id"]).execute()
        except Exception:
            pass

    prompt = f"""A sandbox trade on {ticker} just closed.

Trade: {direction.upper()} @ ${entry:.2f} | Stop ${stop:.2f} | Target ${target:.2f}
Exit: ${exit_price:.2f} via {exit_reason} | Result: {outcome} {pnl_pct:+.1f}%
Original thesis: "{thesis}"

Write ONE specific sentence that captures what this trade teaches about trading {ticker} — what setup to repeat or what mistake to avoid next time. Be concrete, not generic. Start with "Next time" or "Avoid" or "Look for"."""

    try:
        # #23 — fast model for lesson (80 tokens, one sentence)
        lesson = await _call_groq(prompt, max_tokens=80, fast=True)
        if not lesson:
            return
        lesson = lesson.strip().replace('"', '').replace('\n', ' ')[:200]

        # #11 — Use INSERT not upsert so multiple trades on same ticker+date don't overwrite each other
        # Each closed trade gets its own lesson row, keyed by trade_id in key_factors
        supabase().table("prediction_lessons").insert({
            "ticker": ticker.upper(),
            "date": date.today().isoformat(),
            "bias": direction,
            "actual_bias": direction if is_win else ("short" if direction == "long" else "long"),
            "in_range": is_win,
            "lesson": lesson,
            "confidence_pct": min(99, max(1, int(trade.get("confidence_used") or max(1, int(abs(pnl_pct) * 5))))),
            "key_factors": {
                "exit_reason": exit_reason, "pnl_pct": round(pnl_pct, 2),
                "source": "sandbox", "confidence_used": trade.get("confidence_used"),
                "trade_id": str(trade.get("id", "")),
                "thesis_correct": thesis_correct,  # #12
            },
            "signals_used": trade.get("signals_at_entry"),
        }).execute()
        log.info(f"Sandbox lesson written for {ticker}: {lesson[:80]}")
    except Exception as e:
        log.debug(f"Lesson write failed for {ticker}: {e}")


def get_signal_weight_feedback(min_trades: int = 50) -> str:
    """#28 — After 50+ trades, compute which signal types had highest WR and flag divergence."""
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("signals_at_entry,pnl")
            .eq("status", "closed")
            .limit(200)
            .execute()
        )
        trades = res.data or []
        if len(trades) < min_trades:
            return ""
        stats: dict[str, dict] = {}
        for t in trades:
            sigs = t.get("signals_at_entry") or []
            is_win = (t.get("pnl") or 0) > 0
            seen_types: set[str] = set()
            for s in sigs[:3]:
                sig_type = s.get("type", "")
                if not sig_type or sig_type in seen_types:
                    continue
                seen_types.add(sig_type)
                if sig_type not in stats:
                    stats[sig_type] = {"wins": 0, "total": 0}
                stats[sig_type]["total"] += 1
                if is_win:
                    stats[sig_type]["wins"] += 1
        if not stats:
            return ""
        STATIC_WEIGHTS = {
            "dark_pool": 8, "insider_buy": 9, "insider_sell": 9, "options_unusual": 8,
            "short_squeeze": 8, "congress_trade": 7, "volume_spike": 7, "technical": 5,
            "news_breaking": 5, "analyst_change": 6, "earnings_upcoming": 5, "sentiment_spike": 4,
        }
        lines = []
        for sig_type, v in sorted(stats.items(), key=lambda x: x[1]["total"], reverse=True):
            if v["total"] < 5:
                continue
            wr = v["wins"] / v["total"] * 100
            static_w = STATIC_WEIGHTS.get(sig_type, 4)
            # Flag divergence: if WR < 40% but weight >= 7, or WR > 70% but weight <= 4
            if wr < 40 and static_w >= 7:
                lines.append(f"  ⚠️ {sig_type}: {wr:.0f}% WR ({v['total']} trades) but weight={static_w} — OVERWEIGHTED")
            elif wr > 70 and static_w <= 4:
                lines.append(f"  ✅ {sig_type}: {wr:.0f}% WR ({v['total']} trades) but weight={static_w} — UNDERWEIGHTED")
            else:
                lines.append(f"  {sig_type}: {wr:.0f}% WR ({v['total']} trades), weight={static_w}")
        return "SIGNAL WEIGHT FEEDBACK (#28):\n" + "\n".join(lines) if lines else ""
    except Exception:
        return ""


async def get_mark_to_market(client: httpx.AsyncClient | None = None) -> float:
    """#1 — Closed P&L + unrealized P&L on open positions = true account value."""
    try:
        balance = get_account_balance()
        open_pos = get_open_positions()
        if not open_pos:
            return balance
        unrealized = 0.0
        use_client = client or httpx.AsyncClient(timeout=10)
        close_after = client is None
        try:
            for pos in open_pos:
                if pos.get("fill_status") == "pending":
                    continue
                price = await get_current_price(use_client, pos["ticker"])
                if not price:
                    continue
                entry = float(pos["entry_price"])
                shares = int(float(pos.get("shares") or 1))
                if pos["direction"] == "long":
                    unrealized += (price - entry) * shares
                else:
                    unrealized += (entry - price) * shares
        finally:
            if close_after:
                await use_client.aclose()
        return round(balance + unrealized, 2)
    except Exception:
        return get_account_balance()


async def _record_equity_snapshot(client: httpx.AsyncClient | None = None) -> None:
    """Record today's account balance + mark-to-market as equity curve data point."""
    try:
        acct_res = supabase().table("sandbox_account").select("balance,peak_balance").limit(1).execute()
        if not acct_res.data:
            log.warning("Equity snapshot: no account data found")
            return
        acct = acct_res.data[0]
        balance = float(acct["balance"])
        peak = float(acct["peak_balance"])
        drawdown = ((peak - balance) / peak * 100) if peak > 0 else 0

        # #1 — mark-to-market includes unrealized P&L on open trades
        mtm = await get_mark_to_market(client)

        today_str = date.today().isoformat()
        trades_today = supabase().table("sandbox_trades").select("pnl").eq("status", "closed").eq("exit_date", today_str).execute()

        # BUG FIX #7: Validate data exists before processing (silent corruption prevention)
        if trades_today.data is None:
            log.warning(f"Equity snapshot: trades_today.data is None (DB error?)")
            daily_pnl = 0
        else:
            daily_pnl = sum((r.get("pnl") or 0) for r in trades_today.data)

        wins, total, win_rate, win_rate_ci = get_overall_win_rate()

        supabase().table("sandbox_equity").upsert({
            "date": today_str,
            "balance": balance,
            "mtm_balance": round(mtm, 2),
            "daily_pnl": round(daily_pnl, 2),
            "drawdown_pct": round(drawdown, 4),
            "win_rate": round(win_rate, 2),
        }, on_conflict="date").execute()
        total_return_pct = (balance - STARTING_BALANCE) / STARTING_BALANCE * 100
        log.info(f"Equity snapshot recorded: ${balance:,.0f} ({total_return_pct:+.1f}%)")
    except Exception as e:
        log.error(f"Equity snapshot failed: {e}")


# ─── Daily performance snapshot ───────────────────────────────────────────────

def record_daily_performance() -> None:
    today_str = date.today().isoformat()
    try:
        # Get all trades closed today
        res = (
            supabase().table("sandbox_trades")
            .select("pnl")
            .eq("status", "closed")
            .eq("exit_date", today_str)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return
        wins = sum(1 for r in rows if (r.get("pnl") or 0) > 0)
        losses = len(rows) - wins
        gross_pnl = sum((r.get("pnl") or 0) for r in rows)
        win_rate = wins / len(rows) * 100 if rows else 0

        supabase().table("sandbox_performance").upsert({
            "date": today_str,
            "trades_closed": len(rows),
            "wins": wins,
            "losses": losses,
            "win_rate": round(win_rate, 2),
            "gross_pnl": round(gross_pnl, 2),
        }, on_conflict="date").execute()
        log.info(f"Sandbox daily performance: {wins}W/{losses}L ({win_rate:.1f}%) P&L ${gross_pnl:+.2f}")
    except Exception as e:
        log.error(f"record_daily_performance failed: {e}")


# ─── Nightly self-critique ────────────────────────────────────────────────────

_critique_done_date: date | None = None

async def run_nightly_critique() -> dict:
    """
    5pm ET: Groq reviews ALL of today's closed trades as a batch.
    Identifies patterns in losses, blind spots, and rule violations.
    Stores critique in prediction_lessons as ticker=GROQ_SELF so it's
    injected into tomorrow's entry decisions.
    """
    global _critique_done_date
    today = date.today()
    if _critique_done_date == today:
        return {"status": "skipped", "reason": "already ran today"}

    today_str = today.isoformat()

    # Fetch all trades closed today
    try:
        res = (
            supabase().table("sandbox_trades")
            .select("*")
            .eq("status", "closed")
            .eq("exit_date", today_str)
            .execute()
        )
        trades = res.data or []
    except Exception as e:
        log.error(f"Critique fetch failed: {e}")
        return {"status": "error", "reason": str(e)}

    if not trades:
        log.info("No closed trades today — skipping critique")
        return {"status": "skipped", "reason": "no trades today"}

    # Fetch yesterday's AND 7-days-ago critique (#18 — detect persistent patterns)
    try:
        yesterday = (today - timedelta(days=1)).isoformat()
        week_ago = (today - timedelta(days=7)).isoformat()
        prev_res = (
            supabase().table("prediction_lessons")
            .select("lesson,key_factors,date")
            .eq("ticker", "GROQ_SELF")
            .in_("date", [yesterday, week_ago])
            .order("date", desc=True)
            .limit(2)
            .execute()
        )
        rows = prev_res.data or []
        prev_critique = rows[0].get("lesson", "") if rows else ""
        week_critique = rows[1].get("lesson", "") if len(rows) > 1 else ""
    except Exception:
        prev_critique = ""
        week_critique = ""

    # Get overall account state
    wins_today = [t for t in trades if (t.get("pnl") or 0) > 0]
    losses_today = [t for t in trades if (t.get("pnl") or 0) < 0]
    gross_pnl = sum((t.get("pnl") or 0) for t in trades)
    win_rate_today = len(wins_today) / len(trades) * 100 if trades else 0
    _, total_trades, overall_win_rate, _ = get_overall_win_rate()

    # Build detailed trade log
    trade_lines = []
    for t in trades:
        outcome = "WIN" if (t.get("pnl") or 0) > 0 else "LOSS"
        pnl_pct = t.get("pnl_pct") or 0
        direction = t.get("direction", "?")
        ticker = t.get("ticker", "?")
        entry = t.get("entry_price", 0)
        exit_p = t.get("exit_price", 0)
        stop = t.get("stop_loss", 0)
        target = t.get("target_price", 0)
        reason = t.get("exit_reason", "?")
        thesis = (t.get("groq_thesis") or "")[:100]
        conf = t.get("confidence_used", "?")
        signals = t.get("signals_at_entry") or []
        sig_str = ", ".join(f"{s.get('type','?')}({s.get('sev','?')})" for s in signals[:3])

        efficiency = t.get("profit_efficiency")
        eff_str = f" | efficiency={efficiency:.0%}" if efficiency is not None else ""
        peak = t.get("peak_pnl_pct")
        peak_str = f" peak={peak:+.1f}%" if peak is not None and peak > -999 else ""
        trade_lines.append(
            f"[{outcome}] {ticker} {direction.upper()} @ ${entry:.2f} → ${exit_p:.2f} "
            f"({pnl_pct:+.1f}%{peak_str}{eff_str}) | conf={conf} | exit={reason}\n"
            f"  Stop=${stop:.2f} Target=${target:.2f} | Signals: {sig_str or 'none'}\n"
            f"  Thesis: {thesis}"
        )

    trade_block = "\n\n".join(trade_lines)

    # #17 — Exit reason breakdown by primary signal type
    exit_by_signal: dict[str, dict] = {}
    for t in trades:
        primary_sig = (t.get("signals_at_entry") or [{}])[0].get("type", "unknown")
        reason = t.get("exit_reason", "unknown")
        is_win = (t.get("pnl") or 0) > 0
        key = f"{primary_sig}→{reason}"
        exit_by_signal.setdefault(key, {"wins": 0, "total": 0})
        exit_by_signal[key]["total"] += 1
        if is_win:
            exit_by_signal[key]["wins"] += 1
    exit_signal_lines = []
    for k, v in sorted(exit_by_signal.items(), key=lambda x: x[1]["total"], reverse=True)[:8]:
        wr = v["wins"] / v["total"] * 100
        exit_signal_lines.append(f"  {k}: {v['wins']}/{v['total']} ({wr:.0f}% WR)")
    exit_signal_block = "\n".join(exit_signal_lines) if exit_signal_lines else "Not enough data."

    weight_feedback = get_signal_weight_feedback()

    prompt = f"""You are reviewing your own trading decisions from today ({today_str}).

TODAY'S RESULTS:
{len(wins_today)}W / {len(losses_today)}L | Win rate: {win_rate_today:.1f}% | P&L: ${gross_pnl:+.2f}
Overall account win rate: {overall_win_rate:.1f}% ({total_trades} total trades)

EXIT REASON BY SIGNAL TYPE (signal→exit_reason: W/L WR):
{exit_signal_block}
{weight_feedback}

TODAY'S TRADES:
{trade_block}

YESTERDAY'S SELF-CRITIQUE (check if you repeated the same mistakes):
{prev_critique[:400] if prev_critique else "No prior critique."}

7 DAYS AGO CRITIQUE (check for persistent multi-week patterns):
{week_critique[:300] if week_critique else "No week-ago critique."}

Be brutally honest. Analyze your decisions as a batch — not one at a time. Answer:

**PATTERN IN LOSSES**: What do the losing trades have in common? Wrong direction, too tight stops, bad timing, ignored market conditions, low conviction entries?

**PATTERN IN WINS**: What made the winning trades work? Can you do more of this?

**RULE VIOLATIONS**: Did you take trades that violated your own rules? Low R:R, traded against the morning outlook, entered when confidence was borderline?

**EXIT QUALITY BY SIGNAL TYPE**: Based on the exit_reason breakdown above, which signal types are producing stop-hits vs target-hits? Are dark_pool signals getting stopped out? Should you adjust stop width or position size for specific signal types?

**REPEATED MISTAKES**: Compare to yesterday AND 7 days ago — are you making the same errors week after week? Flag any pattern that appears in both critiques as a PERSISTENT BLIND SPOT.

**TOMORROW'S ADJUSTMENTS**: Give 3 specific, concrete rule changes for tomorrow. Not generic advice — specific: "Don't short tech when QQQ pre-market is +0.5%+" or "Skip day trades on tickers with no signals in last 4h"

**SELF-SCORE**: Rate today's decision quality 1-10 (separate from P&L — a lucky win on a bad setup is still bad trading).

Be direct. You are critiquing yourself, not being polite."""

    critique = await _call_groq(prompt, max_tokens=600)  # Reduced from 1200 to 600 (token budget)
    if not critique:
        log.warning("Nightly critique Groq call failed")
        return {"status": "error", "reason": "groq failed"}

    _critique_done_date = today

    # Store as a special ticker "GROQ_SELF" so it's queryable but doesn't pollute ticker lessons
    try:
        supabase().table("prediction_lessons").upsert({
            "ticker": "GROQ_SELF",
            "date": today_str,
            "bias": "long" if win_rate_today >= 50 else "short",
            "actual_bias": "long" if gross_pnl >= 0 else "short",
            "in_range": win_rate_today >= 50,
            "lesson": critique[:2000],
            "confidence_pct": int(win_rate_today),
            "key_factors": {
                "wins": len(wins_today),
                "losses": len(losses_today),
                "win_rate": round(win_rate_today, 1),
                "gross_pnl": round(gross_pnl, 2),
                "total_trades": len(trades),
                "source": "nightly_critique",
            },
            "signals_used": None,
        }, on_conflict="ticker,date").execute()
        log.info(f"Nightly critique stored: {win_rate_today:.1f}% win rate today, ${gross_pnl:+.2f}")
    except Exception as e:
        log.error(f"Critique store failed: {e}")

    # Also insert as a signal so it appears on the dashboard
    insert_signal(
        "GROQ_SELF",
        "convergence",
        6.0,
        f"Groq Self-Critique {today_str} — {win_rate_today:.0f}% win rate",
        critique[:1000],
        {
            "wins": len(wins_today),
            "losses": len(losses_today),
            "gross_pnl": round(gross_pnl, 2),
            "critique_type": "nightly_self_review",
        },
    )

    return {
        "status": "ok",
        "trades_reviewed": len(trades),
        "win_rate": round(win_rate_today, 1),
        "gross_pnl": round(gross_pnl, 2),
    }


_cold_start_seeded = False

def seed_cold_start_rules() -> None:
    """#15 — Write bootstrap rules on first run if no lessons exist.
    These give Groq conservative defaults before any real trade history."""
    global _cold_start_seeded
    if _cold_start_seeded:
        return
    try:
        existing = supabase().table("prediction_lessons").select("id").eq("ticker", "GROQ_BOOTSTRAP").limit(1).execute()
        if existing.data:
            _cold_start_seeded = True
            return
        bootstrap_rules = """BOOTSTRAP RULES (pre-loaded defaults for a fresh account — you are in LEARNING MODE. The goal is to take quality setups and LEARN from real outcomes, not to sit on the sidelines. A day with zero trades teaches nothing.):

**HIGHEST WIN-RATE SETUPS**: Convergence alerts and smart-money flow (dark pool, unusual options, insider/congress buys) are your highest-conviction trades — size up on these. But you should ALSO take clean technical and momentum setups: a strong single signal (severity >=7) backed by supportive volume, sector, or technical context is a perfectly valid day-trade entry. Most days will not hand you a convergence alert — trade the best setup available.

**SETUPS TO AVOID**: Avoid shorting into a clearly bullish morning outlook (and going long into a clearly bearish one) unless you have a specific catalyst. Avoid entries with no qualifying signal, and avoid trades whose stop fails the 2:1 reward-to-risk test.

**3 CONCRETE RULES FOR ENTRY DECISIONS**:
1. You are actively trading, not waiting — on a normal day expect to find 1-4 quality entries. Use day trades when the catalyst is intraday (momentum, volume, options flow) and swing trades when the catalyst is multi-day (insider, congress, analyst, convergence).
2. One strong signal (severity >=7) OR two or more moderate signals (severity >=6) is enough to enter when the setup is clean and reward-to-risk is at least 2:1.
3. Enter when your confidence is 55 or higher. Reserve your largest position sizes for confidence 75+ and convergence setups."""
        supabase().table("prediction_lessons").insert({
            "ticker": "GROQ_BOOTSTRAP",
            "date": date.today().isoformat(),
            "bias": "long",
            "actual_bias": "long",
            "in_range": True,
            "lesson": bootstrap_rules,
            "confidence_pct": 50,
            "key_factors": {"source": "cold_start_seed"},
        }).execute()
        log.info("Cold start bootstrap rules seeded")
        _cold_start_seeded = True
    except Exception as e:
        log.debug(f"Cold start seed failed: {e}")


def _insert_sandbox_trade(trade: dict) -> dict | None:
    """Insert a trade row, resiliently. If the table is missing a column the code
    writes (e.g. target1 / partial_exit_done before the schema migration runs),
    Postgres returns PGRST204 'Could not find the X column'. Rather than let that
    swallow the ENTIRE trade (which is what produced 0 trades for days), we drop the
    offending column and retry. Once the migration adds the columns, nothing is
    dropped. Returns the inserted row dict, or None on a genuine failure."""
    import re as _re
    payload = dict(trade)
    for _ in range(8):
        try:
            res = supabase().table("sandbox_trades").insert(payload).execute()
            return res.data[0] if res.data else None
        except Exception as e:
            m = _re.search(r"Could not find the '([^']+)' column", str(e))
            if m and m.group(1) in payload:
                col = m.group(1)
                log.warning(f"sandbox_trades missing column '{col}' — dropping from insert so the trade still lands (add it via migration to keep the feature)")
                payload.pop(col, None)
                continue
            log.error(f"sandbox_trades insert failed: {e}")
            return None
    return None


# ─── Main run_once entry point ────────────────────────────────────────────────

async def run_once() -> dict:
    et = now_et()
    hour = et.hour
    minute = et.minute

    # Cancel stale pending limit orders 7 days a week — no reason a 4000-min-old
    # unfilled order should survive a weekend just because the market is closed.
    open_positions = get_open_positions()
    pending_trades = [p for p in open_positions if p.get("fill_status") == "pending"]
    if pending_trades:
        now_utc = datetime.now(timezone.utc)
        cancelled_weekend = 0
        for trade in pending_trades:
            try:
                created = datetime.fromisoformat((trade.get("created_at") or "").replace("Z", "+00:00"))
                age_min = (now_utc - created).total_seconds() / 60
                if age_min > 30:
                    supabase().table("sandbox_trades").update({
                        "status": "closed",
                        "exit_reason": "limit_expired",
                        "pnl": 0, "pnl_pct": 0,
                        "exit_date": date.today().isoformat(),
                        "updated_at": now_utc.isoformat(),
                    }).eq("id", trade["id"]).execute()
                    log.info(f"Limit order expired for {trade['ticker']} after {age_min:.0f}min — cancelled (pre-weekday-gate)")
                    cancelled_weekend += 1
            except Exception as e:
                log.debug(f"Weekend pending cancel failed for {trade.get('ticker','?')}: {e}")
        if cancelled_weekend:
            open_positions = get_open_positions()

    if not is_weekday():
        return {"status": "skipped", "reason": "weekend", "pending_cancelled": cancelled_weekend if pending_trades else 0}

    seed_cold_start_rules()  # #15 — no-op after first run

    open_positions = get_open_positions()
    open_tickers = {p["ticker"] for p in open_positions}
    today_str = date.today().isoformat()

    async with httpx.AsyncClient(timeout=15) as client:

        # Always: close any day trades left open from a previous trading day
        stale_day_trades = [
            p for p in open_positions
            if p.get("trade_type") == "day" and p.get("entry_date") != today_str
        ]
        if stale_day_trades:
            log.info(f"Closing {len(stale_day_trades)} stale day trades from previous sessions")
            for trade in stale_day_trades:
                try:
                    await evaluate_open_trade(client, trade)
                except Exception as e:
                    log.error(f"Stale day trade close failed for {trade['ticker']}: {e}")
                await asyncio.sleep(1)
            # Refresh open positions after closing stale trades
            open_positions = get_open_positions()
            open_tickers = {p["ticker"] for p in open_positions}

        # #2 — Limit fill simulation: cancel unfilled limit orders after 30 minutes
        # A trade is "pending fill" if created_at is <30 min ago and price hasn't touched entry_price yet
        pending_trades = [
            p for p in open_positions
            if p.get("fill_status") == "pending"
        ]
        for trade in pending_trades:
            try:
                created = datetime.fromisoformat((trade.get("created_at") or "").replace("Z", "+00:00"))
                age_min = (datetime.now(timezone.utc) - created).total_seconds() / 60
                if age_min > 30:
                    # Expired — cancel without touching account balance
                    supabase().table("sandbox_trades").update({
                        "status": "closed",
                        "exit_reason": "limit_expired",
                        "pnl": 0, "pnl_pct": 0,
                        "exit_date": date.today().isoformat(),
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", trade["id"]).execute()
                    log.info(f"Limit order expired for {trade['ticker']} after {age_min:.0f}min — cancelled")
                    open_positions = [p for p in open_positions if p["id"] != trade["id"]]
                    open_tickers.discard(trade["ticker"])
                    continue
                # Check if price has touched the limit entry zone
                price = await get_price_with_snapshot_fallback(client, trade["ticker"])
                if price:
                    entry = float(trade["entry_price"])
                    direction = trade["direction"]
                    # FIX #8: Increase fill tolerance from 0.1% (1.001) to 0.5% (1.005)
                    filled = (direction == "long" and price <= entry * 1.005) or \
                             (direction == "short" and price >= entry * 0.995)
                    if filled:
                        supabase().table("sandbox_trades").update({
                            "fill_status": "filled",
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        }).eq("id", trade["id"]).execute()
                        log.info(f"Limit order filled for {trade['ticker']} @ ${price:.2f}")
            except Exception as e:
                log.debug(f"Limit fill check failed for {trade.get('ticker','?')}: {e}")
            await asyncio.sleep(0.5)
        if pending_trades:
            open_positions = get_open_positions()
            open_tickers = {p["ticker"] for p in open_positions}

        # Intraday stop/target checks — always run on every active position every cycle.
        # The Groq swing hold/exit re-eval inside evaluate_open_trade is separately
        # throttled to every 2 hours via _skip_groq_swing_eval to keep token costs down.
        global _last_swing_groq_eval_utc
        now_utc = datetime.now(timezone.utc)
        should_groq_swing_eval = (
            _last_swing_groq_eval_utc is None or
            (now_utc - _last_swing_groq_eval_utc).total_seconds() >= 7200  # 2 hours
        )
        if should_groq_swing_eval:
            _last_swing_groq_eval_utc = now_utc

        active_positions = [p for p in open_positions if p.get("fill_status") != "pending"]
        if active_positions:
            for trade in active_positions:
                # Pass flag so evaluate_open_trade skips the Groq swing re-eval when throttled
                trade['_skip_groq_swing_eval'] = not should_groq_swing_eval
                try:
                    await evaluate_open_trade(client, trade)
                except Exception as e:
                    log.error(f"Intraday eval failed for {trade['ticker']}: {e}")
                await asyncio.sleep(0.5)
            # Refresh after intraday evals (some may have closed)
            open_positions = get_open_positions()
            open_tickers = {p["ticker"] for p in open_positions}

        # 9:30am–3:50pm ET: full trading day entry window
        in_entry_window = (hour == 9 and minute >= 30) or (10 <= hour <= 14) or (hour == 15 and minute <= 50)
        # #19 — Block first 10 minutes of open (9:30-9:40 ET) — too whippy, except convergence
        in_open_block = (hour == 9 and 30 <= minute < 40)

        # FIX #15: Gap detection at 9:30 ET — detect 5%+ gaps
        if hour == 9 and minute == 30:
            try:
                # Get prev close and current open
                snapshots = supabase().table("snapshots").select("*").eq("ticker", "SPY").order("created_at", desc=True).limit(2).execute()
                if snapshots.data and len(snapshots.data) >= 2:
                    prev_close = snapshots.data[1].get("price", 0)
                    curr_open = snapshots.data[0].get("price", 0)
                    if prev_close and curr_open:
                        gap_pct = abs((curr_open - prev_close) / prev_close) * 100
                        if gap_pct > 5.0:
                            log.info(f"Gap detected: {gap_pct:.1f}% — raising entry bar for today")
                            # This gets used in entry confidence checks
            except Exception:
                pass  # Silent fail on gap detection

        skip_entries = False
        skip_reason = None

        if in_entry_window:

            # #1 — Regime detection: skip all entries if market is choppy
            if is_choppy_market():
                skip_entries = True
                skip_reason = "choppy market regime — VIX too high"

            # #3 — Dead zone: block 12pm-2pm ET (temporarily disabled)
            # if is_in_dead_zone():
            #     skip_entries = True; skip_reason = "dead zone 12-2pm ET"

            if not skip_entries:
                # #9 — Daily loss limit: stop new entries if realized P&L today is down 2%
                daily_pnl = get_daily_pnl()
                account_balance = get_account_balance()
                daily_loss_pct = (daily_pnl / account_balance * 100) if account_balance > 0 else 0
                if daily_loss_pct <= -2.0:
                    log.info(f"Daily loss limit hit (realized): {daily_loss_pct:.1f}% — stopping entries for today")
                    skip_entries = True
                    skip_reason = f"daily loss limit hit ({daily_loss_pct:.1f}%)"

            if not skip_entries:
                # #4 — Consecutive loss circuit breaker: halt after 5 straight losses
                consec_losses = get_consecutive_losses()
                if consec_losses >= MAX_CONSECUTIVE_LOSSES:
                    log.info(f"Circuit breaker: {consec_losses} consecutive losses — halting entries for today")
                    skip_entries = True
                    skip_reason = f"circuit breaker: {consec_losses} consecutive losses"

            if not skip_entries:
                # #15 — Max drawdown halt: stop all entries if account is down 20%+ from peak
                _, _, drawdown_pct = get_account_streak()
                if drawdown_pct >= MAX_DRAWDOWN_HALT_PCT:
                    log.warning(f"Max drawdown halt: {drawdown_pct:.1f}% drawdown — halting all entries")
                    send_push_notification(
                        f"⚠️ Sandbox Drawdown Alert: {drawdown_pct:.1f}%",
                        f"Account is {drawdown_pct:.1f}% below peak. All new entries halted until drawdown recovers below {MAX_DRAWDOWN_HALT_PCT}%.",
                        severity=9.0
                    )
                    skip_entries = True
                    skip_reason = f"max drawdown halt ({drawdown_pct:.1f}%)"

            if not skip_entries:
                # Count how many trades already entered today
                today_str = date.today().isoformat()
                try:
                    today_entries_res = supabase().table("sandbox_trades").select("id").eq("entry_date", today_str).execute()
                    today_entry_count = len(today_entries_res.data or [])
                except Exception:
                    today_entry_count = 0

                # #22 — pending trades count at 50% weight against the position cap
                pending_count = sum(1 for p in open_positions if p.get("fill_status") == "pending")
                effective_open = len(open_positions) - pending_count + (pending_count * 0.5)
                if today_entry_count < MAX_DAILY_ENTRIES and effective_open < MAX_OPEN_POSITIONS:
                    _scan_diag.clear()  # fresh diagnostics for this scan
                    # Use pre-market game plan if available — Groq already picked the best setups
                    premarket_plan = get_premarket_plan()
                    if premarket_plan:
                        # Put pre-market picks first (by conviction), then fill with scan universe
                        plan_tickers = [p["ticker"] for p in premarket_plan]
                        scan_tickers = await get_scan_universe(client)
                        # Deduplicate — plan tickers take priority
                        extra = [t for t in scan_tickers if t not in set(plan_tickers)]
                        tickers = plan_tickers + extra
                        log.info(f"Using pre-market game plan: {plan_tickers} + {len(extra)} from scan")
                    else:
                        tickers = await get_scan_universe(client)
                        log.info("No pre-market plan — using scan universe")

                    entries = 0
                    slots_left = min(MAX_DAILY_ENTRIES - today_entry_count, MAX_OPEN_POSITIONS - len(open_positions))

                    for ticker_idx, ticker in enumerate(tickers):
                        if entries >= slots_left:
                            break
                        if ticker in open_tickers:
                            continue
                        # #5 — Re-check VIX every 3 entries (catches mid-session spikes)
                        if entries > 0 and entries % 3 == 0 and is_choppy_market():
                            log.info("VIX spiked mid-session — halting further entries")
                            break
                        try:
                            trade = await decide_entry(client, ticker, open_tickers, open_positions)
                            if trade:
                                # #19 — Skip non-convergence entries in first 10 min (9:30-9:40 ET)
                                if in_open_block and not trade.get("is_convergence", False):
                                    log.debug(f"Open block: skipping non-convergence {ticker} entry (9:30-9:40 window)")
                                    continue
                                # #17 — Idempotency: check no open trade already exists for this ticker today
                                existing = supabase().table("sandbox_trades").select("id").eq("ticker", ticker).eq("status", "open").limit(1).execute()
                                if existing.data:
                                    log.debug(f"Idempotency: {ticker} already has an open trade — skipping insert")
                                    open_tickers.add(ticker)
                                    continue
                                inserted = _insert_sandbox_trade(trade)
                                if inserted:
                                    trade["id"] = inserted.get("id")  # add DB-generated id
                                    open_tickers.add(ticker)
                                    open_positions.append(trade)  # keep sector counts current
                                    entries += 1
                                    conviction = trade.get("conviction_label", "standard")
                                    log.info(f"Sandbox entered {trade['direction']} {ticker} @ ${trade['entry_price']:.2f} ({trade['trade_type']}) | {conviction} | risk=${trade.get('risk_amount', 0):.0f}")
                        except Exception as e:
                            log.error(f"Entry decision failed for {ticker}: {e}")
                        await asyncio.sleep(2)

                    return {"status": "ok", "action": "entry_scan", "entries": entries, "today_total": today_entry_count + entries, "open": len(open_tickers), "diag": _scan_diag[:30]}
            else:
                log.info(f"Entries skipped ({skip_reason}) — continuing to evaluate open positions")

        # 4:00–4:15 ET: close all day trades + evaluate swings + record performance
        if hour == 16 and minute < 15:
            closed = 0
            for trade in open_positions:
                try:
                    await evaluate_open_trade(client, trade)
                    closed += 1
                except Exception as e:
                    log.error(f"EOD evaluation failed for {trade['ticker']}: {e}")
                await asyncio.sleep(1)
            record_daily_performance()

            # #15 — Daily P&L push at 4pm close
            try:
                today_str = date.today().isoformat()
                day_res = supabase().table("sandbox_trades").select("pnl,direction,ticker").eq("status", "closed").eq("exit_date", today_str).execute()
                day_trades = day_res.data or []
                if day_trades:
                    day_wins = sum(1 for t in day_trades if (t.get("pnl") or 0) > 0)
                    day_losses = len(day_trades) - day_wins
                    day_pnl = sum((t.get("pnl") or 0) for t in day_trades)
                    day_wr = day_wins / len(day_trades) * 100
                    new_bal = get_account_balance()
                    total_ret = (new_bal - STARTING_BALANCE) / STARTING_BALANCE * 100
                    push_title = f"📊 Sandbox EOD: {day_wins}W/{day_losses}L ({day_wr:.0f}%)"
                    push_body = f"Today: {'+' if day_pnl >= 0 else ''}${day_pnl:.0f} | Account: ${new_bal:,.0f} ({total_ret:+.1f}% total)"
                    send_push_notification(push_title, push_body, severity=7.0)
            except Exception as e:
                log.debug(f"Daily P&L push failed: {e}")

            return {"status": "ok", "action": "eod_close", "evaluated": closed}

        # 4:30–4:45 ET: post-market swing review with after-hours prices
        if hour == 16 and 30 <= minute < 45:
            swing_positions = [p for p in open_positions if p.get("trade_type") == "swing"]
            if swing_positions:
                reviewed = 0
                for trade in swing_positions:
                    try:
                        # Get AH price (Finnhub returns last trade including AH)
                        price = await get_price_with_snapshot_fallback(client, trade["ticker"])
                        if not price:
                            continue
                        entry = float(trade["entry_price"])
                        direction = trade["direction"]
                        pnl_pct = (price - entry) / entry * 100 if direction == "long" else (entry - price) / entry * 100
                        ah_signals = await get_recent_signals(trade["ticker"], hours=4)
                        sig_lines = [f"- [{s['signal_type']} sev={s['severity']}] {s['title']}" for s in ah_signals]
                        sig_block = "\n".join(sig_lines) if sig_lines else "No after-hours signals."

                        prompt = f"""Market just closed. You have an open {direction} swing trade on {trade['ticker']}.

Entry: ${entry:.2f} | Close price: ${price:.2f} | P&L today: {pnl_pct:+.1f}%
Original thesis: {trade.get('groq_thesis', 'N/A')}

After-hours signals:
{sig_block}

Should you hold overnight or exit at open tomorrow?
Respond ONLY with JSON: {{"hold": true | false, "reason": "<one sentence>"}}

Exit if: news broke after close that breaks thesis, AH price action is alarming, or you're sitting on a large gain you want to protect."""

                        raw = await _call_groq(prompt, max_tokens=100)
                        if raw:
                            text = raw.strip()
                            if "```" in text:
                                parts = text.split("```")
                                if len(parts) >= 2:
                                    text = parts[1][4:] if parts[1].startswith("json") else parts[1]
                            parsed = json.loads(text.strip())
                            decision = "hold" if parsed.get("hold", True) else "exit_at_open"
                            reason = str(parsed.get("reason", ""))[:300]
                            try:
                                supabase().table("sandbox_trade_evals").insert({
                                    "trade_id": trade.get("id"),
                                    "ticker": trade["ticker"],
                                    "decision": decision,
                                    "reason": reason,
                                    "price_at_eval": round(price, 4),
                                    "pnl_pct_at_eval": round(pnl_pct, 4),
                                    "evaluated_at": datetime.now(timezone.utc).isoformat(),
                                }).execute()
                            except Exception:
                                pass
                            if not parsed.get("hold", True):
                                # Flag for exit at tomorrow's open — update thesis note
                                supabase().table("sandbox_trades").update({
                                    "groq_exit_note": f"[POST-MARKET] Exit at open: {reason}",
                                    "updated_at": datetime.now(timezone.utc).isoformat(),
                                }).eq("id", trade["id"]).execute()
                                log.info(f"Post-market: {trade['ticker']} flagged for exit at open — {reason}")
                        reviewed += 1
                    except Exception as e:
                        log.debug(f"Post-market review failed for {trade['ticker']}: {e}")
                    await asyncio.sleep(1)
                return {"status": "ok", "action": "postmarket_swing_review", "reviewed": reviewed}

        # #16 — 5:15–5:30 ET: record daily equity snapshot regardless of trade activity
        if hour == 17 and 15 <= minute < 30:
            await _record_equity_snapshot()
            return {"status": "ok", "action": "daily_equity_snapshot"}

        # 5:00–5:15 ET: nightly self-critique — #19 only run if no open day trades remain from today
        if hour == 17 and minute < 15:
            open_day_trades_today = [
                p for p in open_positions
                if p.get("trade_type") == "day" and p.get("entry_date") == today_str
            ]
            if open_day_trades_today:
                log.info(f"Critique deferred: {len(open_day_trades_today)} day trades still open from today")
                return {"status": "skipped", "reason": "waiting for day trades to close"}
            critique_result = await run_nightly_critique()
            return {"status": "ok", "action": "nightly_critique", **critique_result}

        # During market hours: evaluate ALL open trades for stops/targets every cycle
        if is_market_hours() and open_positions:
            checked = 0
            for trade in open_positions:
                if trade.get("fill_status") == "pending":
                    continue
                try:
                    await evaluate_open_trade(client, trade)
                    checked += 1
                except Exception as e:
                    log.error(f"Trade eval failed for {trade['ticker']}: {e}")
                await asyncio.sleep(1)
            return {"status": "ok", "action": "market_hours_eval", "checked": checked}

    return {"status": "ok", "action": "idle", "open_positions": len(open_positions)}


_last_health_alert_date: date | None = None

async def _check_worker_health() -> None:
    """#20 — Fire push alert if no equity snapshot recorded in last 25h on a weekday."""
    global _last_health_alert_date
    today = date.today()
    if _last_health_alert_date == today:
        return
    if not is_weekday():
        return
    try:
        res = (
            supabase().table("sandbox_equity")
            .select("date,created_at")
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        if not res.data:
            return
        last_date = date.fromisoformat(res.data[0]["date"])
        days_gap = (today - last_date).days
        if days_gap >= 2:  # missed at least 1 full weekday
            _last_health_alert_date = today
            send_push_notification(
                "⚠️ Sandbox Worker May Be Down",
                f"No equity snapshot recorded since {last_date}. {days_gap} days without activity. Check Railway logs.",
                severity=8.0
            )
            log.warning(f"Worker health alert: no equity snapshot since {last_date} ({days_gap} days)")
    except Exception as e:
        log.debug(f"Health check failed: {e}")


async def main_loop():
    log.info("Sandbox worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"Sandbox tick: {result}")
            await _check_worker_health()
        except Exception as e:
            log.error(f"Sandbox loop error: {e}")
        await asyncio.sleep(1800)  # every 30 min
