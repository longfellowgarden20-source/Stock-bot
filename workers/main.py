"""
StockBot worker service — runs all background workers in one process.

Endpoints:
  GET  /health           — liveness check
  POST /trigger/price    — manual run of price worker
  POST /trigger/news     — manual run of news worker
  POST /trigger/sec      — manual run of sec worker
  POST /trigger/reddit   — manual run of reddit worker
  POST /trigger/engine   — manual run of signal engine

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")

_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start all workers as background tasks
    log.info("Starting background workers")
    _tasks.append(asyncio.create_task(price_worker.main_loop()))
    _tasks.append(asyncio.create_task(news_worker.main_loop()))
    _tasks.append(asyncio.create_task(sec_worker.main_loop()))
    _tasks.append(asyncio.create_task(reddit_worker.main_loop()))
    _tasks.append(asyncio.create_task(signal_engine.main_loop()))
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
    return {"service": "stockbot-workers", "status": "running", "workers": 5}


@app.get("/health")
async def health():
    alive = sum(1 for t in _tasks if not t.done())
    return {"status": "ok", "workers_alive": alive, "workers_total": len(_tasks)}


@app.post("/trigger/price")
async def trigger_price():
    return await price_worker.run_once()


@app.post("/trigger/news")
async def trigger_news():
    return await news_worker.run_once()


@app.post("/trigger/sec")
async def trigger_sec():
    return await sec_worker.run_once()


@app.post("/trigger/reddit")
async def trigger_reddit():
    return await reddit_worker.run_once()


@app.post("/trigger/engine")
async def trigger_engine():
    return await signal_engine.run_once()
