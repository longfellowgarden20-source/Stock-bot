'use client'

import { useState, useCallback, useMemo } from 'react'
import { Activity, RefreshCw, Loader2, CheckCircle, XCircle, AlertCircle, Zap, AlertTriangle, BarChart3, Clock } from 'lucide-react'
import type { WorkerStats } from './page'

type WorkerName = string
type WorkerStatus = 'unknown' | 'alive' | 'dead' | 'triggering'

// Which signal_type(s) each worker emits — used to show 24h output volume per worker.
const WORKER_OUTPUT: Record<string, string[]> = {
  price: ['price_move', 'volume_spike'],
  news: ['news_breaking'],
  sec: ['sec_filing'],
  reddit: ['sentiment_spike'],
  engine: ['convergence'],
  options: ['options_unusual'],
  congress: ['congress_trade'],
  squeeze: ['short_squeeze'],
  technical: ['technical'],
  earnings: ['earnings_upcoming'],
  analyst: ['analyst_change'],
  macro: ['macro'],
  darkpool: ['dark_pool'],
  sector: ['sector_rotation'],
}

const WORKER_LABELS: Record<string, { label: string; interval: string }> = {
  price:        { label: 'Price Worker',      interval: '5 min' },
  news:         { label: 'News Worker',       interval: '2 min' },
  sec:          { label: 'SEC Filings',       interval: '10 min' },
  reddit:       { label: 'Reddit Sentiment',  interval: '30 min' },
  engine:       { label: 'Signal Engine',     interval: '5 min' },
  options:      { label: 'Options Flow',      interval: '5 min' },
  congress:     { label: 'Congress Trades',   interval: '6 hr' },
  squeeze:      { label: 'Short Squeeze',     interval: '1 hr' },
  technical:    { label: 'Technicals',        interval: '15 min' },
  earnings:     { label: 'Earnings Watch',    interval: '1 hr' },
  analyst:      { label: 'Analyst Changes',   interval: '1 hr' },
  macro:        { label: 'Macro / VIX',       interval: '30 min' },
  darkpool:     { label: 'Dark Pool',         interval: '5 min' },
  sector:       { label: 'Sector Rotation',   interval: '1 hr' },
  intelligence: { label: 'Intelligence',      interval: '30 min' },
  prediction:   { label: 'EOD Predictions',   interval: '30 min' },
  sandbox:        { label: 'Sandbox Trader',    interval: '30 min' },
  morning_outlook: { label: 'Morning Outlook',  interval: '30 min' },
}

function fmtAgo(sec: number | null | undefined): string {
  if (sec == null) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

export default function AdminClient({
  workers,
  initialHealth,
  configured,
  stats,
}: {
  workers: WorkerName[]
  initialHealth: Record<string, unknown>
  configured: boolean
  stats: WorkerStats
}) {
  const [health, setHealth] = useState<Record<string, unknown>>(initialHealth)
  const [statuses, setStatuses] = useState<Record<string, WorkerStatus>>({})
  const [triggerResults, setTriggerResults] = useState<Record<string, string>>({})
  const [triggeringAll, setTriggeringAll] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const workerStatusMap = useMemo(() => {
    const h = health as Record<string, unknown>
    return (h?.worker_status ?? h) as Record<string, { overdue?: boolean; seconds_since?: number | null } | undefined>
  }, [health])

  const dlq = useMemo(() => {
    const h = health as { dlq?: { count_24h?: number; retry_success_rate?: number; by_type?: Record<string, number> } }
    return h?.dlq ?? null
  }, [health])

  const getWorkerStatus = useCallback((name: WorkerName): WorkerStatus => {
    if (statuses[name] === 'triggering') return 'triggering'
    const w = workerStatusMap?.[name]
    if (!w || w.seconds_since == null) return 'unknown'
    if (w.overdue === true) return 'dead'
    return 'alive'
  }, [workerStatusMap, statuses])

  // ── Summary numbers ──
  const summary = useMemo(() => {
    let alive = 0, overdue = 0, unknown = 0
    for (const name of workers) {
      const w = workerStatusMap?.[name]
      if (!w || w.seconds_since == null) { unknown++; continue }
      if (w.overdue) overdue++
      else alive++
    }
    return { alive, overdue, unknown, total: workers.length }
  }, [workers, workerStatusMap])

  const overdueWorkers = useMemo(
    () => workers.filter(n => workerStatusMap?.[n]?.overdue === true)
      .map(n => ({ name: n, sec: workerStatusMap?.[n]?.seconds_since ?? null })),
    [workers, workerStatusMap]
  )

  const triggerWorker = useCallback(async (name: WorkerName) => {
    setStatuses(prev => ({ ...prev, [name]: 'triggering' }))
    setTriggerResults(prev => ({ ...prev, [name]: '' }))
    try {
      const r = await fetch('/api/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker: name }),
      })
      const data = await r.json()
      const result = data?.[name]
      const msg = result?.error ? `Error: ${result.error}` : result?.status ?? 'triggered'
      setTriggerResults(prev => ({ ...prev, [name]: msg }))
    } catch {
      setTriggerResults(prev => ({ ...prev, [name]: 'network error' }))
    }
    setStatuses(prev => { const next = { ...prev }; delete next[name]; return next })
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/refresh')
      if (r.ok) { const data = await r.json(); if (data.health) setHealth(data.health) }
    } catch { /* offline */ }
  }, [])

  const triggerAll = useCallback(async () => {
    setTriggeringAll(true)
    try {
      await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      setLastRefresh(new Date())
      await refreshHealth()
    } catch { /* offline */ }
    setTriggeringAll(false)
  }, [refreshHealth])

  const getOutput24h = (name: WorkerName): number | null => {
    const types = WORKER_OUTPUT[name]
    if (!types) return null
    return types.reduce((sum, t) => sum + (stats.signalsByType[t] ?? 0), 0)
  }

  const maxSignalCount = Math.max(1, ...Object.values(stats.signalsByType))

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold page-title flex items-center gap-2">
            <Activity className="w-5 h-5 text-[#14b8a6]" />
            Worker Admin
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Health, output &amp; failures for all background workers
            {lastRefresh && ` · Last triggered ${lastRefresh.toLocaleTimeString()}`}
          </p>
        </div>
        <button
          onClick={triggerAll}
          disabled={triggeringAll}
          className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-black bg-[#14b8a6] rounded-xl disabled:opacity-50 hover:bg-[#2dd4bf] active:scale-[0.98]"
          style={{ transition: 'background 0.15s, transform 0.1s' }}
        >
          {triggeringAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {triggeringAll ? 'Triggering all...' : 'Trigger All Workers'}
        </button>
      </div>

      {!configured && (
        <div className="flex items-center gap-3 px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-sm text-yellow-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          WORKER_SERVICE_URL not configured — workers cannot be triggered. Set it in your environment.
        </div>
      )}

      {/* ── Summary stat cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Healthy" value={`${summary.alive}/${summary.total}`}
          color={summary.alive === summary.total ? 'text-emerald-400' : summary.alive >= summary.total * 0.7 ? 'text-yellow-400' : 'text-red-400'}
          sub={summary.unknown ? `${summary.unknown} unknown` : 'all reporting'} />
        <StatCard label="Overdue" value={`${summary.overdue}`}
          color={summary.overdue === 0 ? 'text-emerald-400' : 'text-red-400'}
          sub={summary.overdue === 0 ? 'none stale' : 'need attention'} />
        <StatCard label="Signals 24h" value={stats.totalSignals24h.toLocaleString()}
          color="text-sky-400" sub={`${Object.keys(stats.signalsByType).length} types`} />
        <StatCard label="Failed 24h" value={`${stats.failures.length}`}
          color={stats.failuresUnresolved === 0 ? 'text-emerald-400' : 'text-red-400'}
          sub={dlq ? `${Math.round((dlq.retry_success_rate ?? 0) * 100)}% retry ok` : `${stats.failuresUnresolved} unresolved`} />
      </div>

      {/* ── Attention: down workers + failures ── */}
      {(overdueWorkers.length > 0 || stats.failures.length > 0) && (
        <div className="panel p-4 flex flex-col gap-3">
          <p className="section-header flex items-center gap-1.5 !mb-0 !border-0 !pb-0">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Needs Attention
          </p>

          {overdueWorkers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {overdueWorkers.map(({ name, sec }) => (
                <div key={name} className="flex items-center gap-2 text-xs">
                  <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  <span className="font-semibold text-red-300">{WORKER_LABELS[name]?.label ?? name}</span>
                  <span className="text-slate-500">stopped reporting — last success {fmtAgo(sec)} ago (expected every {WORKER_LABELS[name]?.interval}). Likely a crash or API error; hit Run to retry and watch the result.</span>
                </div>
              ))}
            </div>
          )}

          {stats.failures.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] text-slate-500 uppercase tracking-wider">Failed signal inserts (dead-letter queue)</p>
              {stats.failures.slice(0, 8).map((f, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${f.resolved ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  <div className="min-w-0">
                    <span className="font-mono font-bold text-slate-300">{f.ticker}</span>
                    <span className="text-slate-500"> · {f.signal_type} · retry {f.retry_count} · {new Date(f.created_at).toLocaleTimeString()}</span>
                    <p className="text-red-300/80 break-words">{f.error_message || 'no error message'}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Worker grid ── */}
      <div>
        <p className="section-header">Workers ({workers.length})</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {workers.map(name => {
            const status = getWorkerStatus(name)
            const meta = WORKER_LABELS[name] ?? { label: name, interval: '—' }
            const result = triggerResults[name]
            const sec = workerStatusMap?.[name]?.seconds_since
            const out = getOutput24h(name)

            return (
              <div key={name} className="panel panel-hover flex items-center gap-3 px-4 py-3">
                <div className="shrink-0">
                  {status === 'triggering' ? <Loader2 className="w-5 h-5 text-[#14b8a6] animate-spin" />
                    : status === 'alive' ? <CheckCircle className="w-5 h-5 text-emerald-400" />
                    : status === 'dead' ? <XCircle className="w-5 h-5 text-red-400" />
                    : <div className="w-5 h-5 rounded-full border-2 border-slate-600" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-white truncate">{meta.label}</p>
                    {out != null && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 tabular-nums shrink-0">
                        {out} / 24h
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                    <Clock className="w-3 h-3 shrink-0" />
                    {status === 'triggering' ? 'Running…'
                      : status === 'alive' ? `Healthy · ${fmtAgo(sec)} ago`
                      : status === 'dead' ? <span className="text-red-400">Stale · {fmtAgo(sec)} ago</span>
                      : 'No data yet'}
                    <span className="text-slate-600">· every {meta.interval}</span>
                  </p>
                  {result && (
                    <p className={`text-xs mt-0.5 break-words ${result.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>{result}</p>
                  )}
                </div>

                <button
                  onClick={() => triggerWorker(name)}
                  disabled={status === 'triggering' || !configured}
                  className="btn-terminal shrink-0"
                >
                  {status === 'triggering' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Run
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Signal output breakdown ── */}
      {Object.keys(stats.signalsByType).length > 0 && (
        <div>
          <p className="section-header flex items-center gap-1.5">
            <BarChart3 className="w-3.5 h-3.5" /> Signal Output (last 24h)
          </p>
          <div className="panel p-4 flex flex-col gap-2">
            {Object.entries(stats.signalsByType).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
              <div key={type} className="flex items-center gap-3 text-xs">
                <span className="w-32 shrink-0 text-slate-400 truncate">{type}</span>
                <div className="flex-1 h-2 rounded-full bg-white/[0.04] overflow-hidden">
                  <div className="h-full rounded-full bg-sky-500/60" style={{ width: `${(count / maxSignalCount) * 100}%` }} />
                </div>
                <span className="w-12 text-right tabular-nums font-mono text-slate-300">{count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="panel p-3.5">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold tabular-nums mt-0.5 ${color}`}>{value}</p>
      <p className="text-[11px] text-slate-600 mt-0.5">{sub}</p>
    </div>
  )
}
