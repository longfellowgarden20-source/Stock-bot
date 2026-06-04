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
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import db as db_module

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
import prediction_worker
import intelligence_worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")

_tasks: list[asyncio.Task] = []

# Worker health tracking
_last_success: dict[str, float] = {}
_alerted: set[str] = set()

WORKER_INTERVALS = {
    'price': 300, 'news': 120, 'sec': 600,
    'options': 300, 'darkpool': 300, 'congress': 21600,
    'squeeze': 3600, 'technical': 900, 'earnings': 3600,
    'analyst': 3600, 'macro': 1800, 'sector': 3600,
    'reddit': 1800, 'engine': 300, 'prediction': 1800,
    'intelligence': 1800,
}

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
    "prediction": prediction_worker,
    "intelligence": intelligence_worker,
}


async def _wrapped_loop(name: str, mod) -> None:
    """Wraps a worker's main_loop to track last successful run time."""
    while True:
        try:
            await mod.run_once()
            _last_success[name] = time.time()
            # Worker recovered — clear any existing alert
            _alerted.discard(name)
        except Exception as e:
            log.error(f"Worker {name} run_once failed: {e}")
        interval = WORKER_INTERVALS.get(name, 300)
        await asyncio.sleep(interval)


async def check_worker_health() -> None:
    """Emit a convergence signal if a worker has been silent too long."""
    now = time.time()
    for name, interval in WORKER_INTERVALS.items():
        last = _last_success.get(name)
        if last is None:
            continue  # Never ran yet — might still be starting up
        elapsed = now - last
        if elapsed > interval * 2 and name not in _alerted:
            _alerted.add(name)
            log.warning(f"Worker {name} overdue — last success {elapsed/60:.0f}m ago")
            try:
                db_module.insert_signal(
                    "SYSTEM", "convergence", 9,
                    f"Worker {name} is dead",
                    f"{name} worker hasn't run successfully in {elapsed/60:.0f} minutes. Check Railway logs.",
                    {"worker": name, "last_success": last, "alert_type": "worker_failure"},
                )
            except Exception as e:
                log.error(f"Failed to insert worker failure signal for {name}: {e}")


async def _health_monitor_loop() -> None:
    """Checks worker health every 10 minutes."""
    while True:
        await asyncio.sleep(600)
        try:
            await check_worker_health()
        except Exception as e:
            log.error(f"Health monitor error: {e}")


async def _retry_dlq_loop() -> None:
    """Retries failed signals from the dead-letter queue every 15 minutes."""
    while True:
        await asyncio.sleep(900)
        try:
            resolved = db_module.retry_failed_signals()
            if resolved:
                log.info(f"DLQ retry resolved {resolved} failed signals")
        except Exception as e:
            log.error(f"DLQ retry loop error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(f"Starting {len(WORKERS)} background workers")
    for name, mod in WORKERS.items():
        _tasks.append(asyncio.create_task(_wrapped_loop(name, mod), name=name))
    _tasks.append(asyncio.create_task(_health_monitor_loop(), name="health_monitor"))
    _tasks.append(asyncio.create_task(_retry_dlq_loop(), name="dlq_retry"))
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
    now = time.time()
    worker_tasks = [t for t in _tasks if t.get_name() in WORKERS]
    alive = sum(1 for t in worker_tasks if not t.done())
    dead = [t.get_name() for t in worker_tasks if t.done()]
    worker_status = {}
    for name, interval in WORKER_INTERVALS.items():
        last = _last_success.get(name)
        if last is None:
            worker_status[name] = {"last_success": None, "seconds_since": None, "overdue": False}
        else:
            elapsed = now - last
            worker_status[name] = {
                "last_success": last,
                "seconds_since": round(elapsed),
                "overdue": elapsed > interval * 2,
            }
    return {
        "status": "ok" if not dead else "degraded",
        "workers_alive": alive,
        "workers_total": len(worker_tasks),
        "dead": dead,
        "worker_status": worker_status,
    }


@app.post("/trigger/{worker}")
async def trigger(worker: str):
    mod = WORKERS.get(worker)
    if not mod:
        return {"error": f"unknown worker '{worker}'", "valid": list(WORKERS.keys())}
    try:
        result = await mod.run_once()
        _last_success[worker] = time.time()
        _alerted.discard(worker)
        return result
    except Exception as e:
        log.error(f"Trigger {worker} failed: {e}")
        return {"error": str(e), "worker": worker}
