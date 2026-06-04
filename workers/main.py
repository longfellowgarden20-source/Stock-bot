"""
StockBot worker service — runs all background workers in one process.

Endpoints:
  GET  /health              — liveness check
  POST /trigger/price       — manual run of price worker
  POST /trigger/news        — manual run of news worker
  POST /trigger/sec         — manual run of sec worker
  POST /trigger/reddit      — manual run of reddit worker
  POST /trigger/engine      — manual run of signal engine
  POST /trigger/options     — manual run of options flow worker
  POST /trigger/congress    — manual run of congressional trades worker
  POST /trigger/squeeze     — manual run of short squeeze worker
  POST /trigger/technical   — manual run of technical signals worker
  POST /trigger/earnings    — manual run of earnings worker
  POST /trigger/analyst     — manual run of analyst worker
  POST /trigger/macro       — manual run of macro worker
  POST /trigger/darkpool    — manual run of dark pool worker

Background loops run automatically on startup.
"""
import logging
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import price_worker
import news_worker
import sec_worker
import reddit_worker
import signal_engine
import options_worker
import congress_worker
import squeeze_worker
import technical_worker
import earnings_worker
import analyst_worker
import macro_worker
import darkpool_worker
import sector_worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")

_tasks: list[asyncio.Task] = []


WORKERS = {
    "price": price_worker,
    "news": news_worker,
    "sec": sec_worker,
    "reddit": reddit_worker,
    "engine": signal_engine,
    "options": options_worker,
    "congress": congress_worker,
    "squeeze": squeeze_worker,
    "technical": technical_worker,
    "earnings": earnings_worker,
    "analyst": analyst_worker,
    "macro": macro_worker,
    "darkpool": darkpool_worker,
    "sector": sector_worker,
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(f"Starting {len(WORKERS)} background workers")
    for name, mod in WORKERS.items():
        _tasks.append(asyncio.create_task(mod.main_loop(), name=name))
    yield
    log.info("Shutting down workers")
    for t in _tasks:
        t.cancel()


app = FastAPI(title="StockBot Workers", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"service": "stockbot-workers", "status": "running", "workers": list(WORKERS.keys())}


@app.get("/health")
async def health():
    alive = sum(1 for t in _tasks if not t.done())
    dead = [t.get_name() for t in _tasks if t.done()]
    return {
        "status": "ok" if not dead else "degraded",
        "workers_alive": alive,
        "workers_total": len(_tasks),
        "dead": dead,
    }


@app.post("/trigger/{worker}")
async def trigger(worker: str):
    mod = WORKERS.get(worker)
    if not mod:
        return {"error": f"unknown worker '{worker}'", "valid": list(WORKERS.keys())}
    try:
        return await mod.run_once()
    except Exception as e:
        log.error(f"Trigger {worker} failed: {e}")
        return {"error": str(e), "worker": worker}
