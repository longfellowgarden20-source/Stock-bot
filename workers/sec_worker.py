"""
SEC EDGAR worker — pulls Form 4 (insider trades) and 8-K (material events) for watched tickers.

Form 4 = insider buys/sells — strongest legal signal there is.
8-K = material events (earnings, acquisitions, departures) — often market moving.
"""
import os
import logging
import httpx
import asyncio
from datetime import datetime, timezone
from db import get_watchlist_tickers, insert_signal, supabase

log = logging.getLogger("sec_worker")

# SEC requires a User-Agent with contact info per their fair access policy
SEC_USER_AGENT = os.environ.get("SEC_USER_AGENT", "StockBot research@example.com")
EDGAR_BASE = "https://www.sec.gov"

# CIK lookup cache — fetched once, used many times
_cik_cache: dict[str, str] = {}
_cik_fetched: bool = False


async def _load_cik_map(client: httpx.AsyncClient) -> None:
    """Load the entire SEC ticker→CIK map once."""
    global _cik_fetched
    if _cik_fetched:
        return
    try:
        r = await client.get(
            "https://www.sec.gov/files/company_tickers.json",
            headers={"User-Agent": SEC_USER_AGENT},
            timeout=15,
        )
        if r.status_code != 200:
            log.warning(f"SEC ticker map fetch status {r.status_code}")
            return
        data = r.json()
        for entry in data.values():
            t = entry.get("ticker", "").upper()
            if t:
                _cik_cache[t] = str(entry["cik_str"]).zfill(10)
        _cik_fetched = True
        log.info(f"Loaded {len(_cik_cache)} SEC ticker mappings")
    except Exception as e:
        log.error(f"CIK map load failed: {e}")


async def get_cik(client: httpx.AsyncClient, ticker: str) -> str | None:
    await _load_cik_map(client)
    return _cik_cache.get(ticker.upper())


async def fetch_recent_filings(client: httpx.AsyncClient, cik: str, ticker: str) -> list[dict]:
    """Get recent filings via SEC's JSON submission endpoint."""
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    try:
        r = await client.get(url, headers={"User-Agent": SEC_USER_AGENT}, timeout=15)
        if r.status_code != 200:
            return []
        data = r.json()
        recent = data.get("filings", {}).get("recent", {})
        forms = recent.get("form", [])
        dates = recent.get("filingDate", [])
        accs = recent.get("accessionNumber", [])
        primary_docs = recent.get("primaryDocument", [])
        # Combine into list of dicts
        out = []
        for i in range(min(len(forms), 20)):
            out.append({
                "form": forms[i],
                "filingDate": dates[i],
                "accessionNumber": accs[i],
                "primaryDocument": primary_docs[i] if i < len(primary_docs) else "",
            })
        return out
    except Exception as e:
        log.error(f"filings fetch failed for {ticker}: {e}")
        return []


def _filing_seen(ticker: str, accession: str) -> bool:
    """One query covers all signal types since accession is unique per filing."""
    res = supabase().table("signals").select("id").eq("ticker", ticker.upper()).contains("raw_data", {"accession": accession}).limit(1).execute()
    return bool(res.data)


async def process_ticker(client: httpx.AsyncClient, ticker: str) -> int:
    cik = await get_cik(client, ticker)
    if not cik:
        return 0
    filings = await fetch_recent_filings(client, cik, ticker)
    new_count = 0
    today = datetime.now(timezone.utc).date()

    for f in filings:
        form = f.get("form", "")
        date_str = f.get("filingDate", "")
        accession = f.get("accessionNumber", "")
        if not accession:
            continue
        # Only consider recent filings (within 5 days)
        try:
            fd = datetime.strptime(date_str, "%Y-%m-%d").date()
            if (today - fd).days > 5:
                continue
        except Exception:
            continue

        if _filing_seen(ticker, accession):
            continue

        url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{f.get('primaryDocument', '')}"

        if form == "4":
            # We don't know buy vs sell without parsing the XML — use generic sec_filing type
            insert_signal(
                ticker,
                "sec_filing",
                7,
                f"{ticker} insider transaction (Form 4)",
                f"Filed {date_str}. Form 4 reports insider buys or sells. Open the filing to see the direction and dollar amount.",
                {"accession": accession, "url": url, "form": form, "date": date_str},
            )
            new_count += 1
        elif form == "8-K":
            insert_signal(
                ticker,
                "sec_filing",
                6,
                f"{ticker} 8-K material event filed",
                f"Filed {date_str}. 8-Ks disclose material events — earnings, acquisitions, departures, etc.",
                {"accession": accession, "url": url, "form": form, "date": date_str},
            )
            new_count += 1
        elif form in ("13D", "13G"):
            insert_signal(
                ticker,
                "sec_filing",
                7,
                f"{ticker} institutional ownership change ({form})",
                f"Filed {date_str}. A {form} indicates 5%+ ownership stake reported.",
                {"accession": accession, "url": url, "form": form, "date": date_str},
            )
            new_count += 1
    return new_count


async def run_once() -> dict:
    tickers = get_watchlist_tickers()
    if not tickers:
        return {"status": "skipped", "reason": "no tickers"}
    total = 0
    async with httpx.AsyncClient() as client:
        # SEC rate limit: 10 req/sec — go slow to be safe
        for ticker in tickers:
            try:
                count = await process_ticker(client, ticker)
                total += count
            except Exception as e:
                log.error(f"sec process error for {ticker}: {e}")
            await asyncio.sleep(0.5)
    return {"status": "ok", "tickers": len(tickers), "new_filings": total}


async def main_loop():
    log.info("SEC worker started")
    while True:
        try:
            result = await run_once()
            log.info(f"SEC tick: {result}")
        except Exception as e:
            log.error(f"SEC loop error: {e}")
        await asyncio.sleep(900)  # 15 min
