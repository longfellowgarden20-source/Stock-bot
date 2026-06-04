'use client'

import { useState, useCallback } from 'react'
import { Activity, RefreshCw, Loader2, CheckCircle, XCircle, AlertCircle, Zap } from 'lucide-react'

type WorkerName = string

type WorkerStatus = 'unknown' | 'alive' | 'dead' | 'triggering'

export default function AdminClient({
  workers,
  initialHealth,
  configured,
}: {
  workers: WorkerName[]
  initialHealth: Record<string, unknown>
  configured: boolean
}) {
  const [health, setHealth] = useState<Record<string, unknown>>(initialHealth)
  const [statuses, setStatuses] = useState<Record<string, WorkerStatus>>({})
  const [triggerResults, setTriggerResults] = useState<Record<string, string>>({})
  const [triggeringAll, setTriggeringAll] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const getWorkerStatus = useCallback((name: WorkerName): WorkerStatus => {
    if (statuses[name] === 'triggering') return 'triggering'
    // Check health data from Railway /health endpoint
    const h = health as Record<string, { ok?: boolean; last_run?: string; error?: string } | undefined>
    const w = h?.[name]
    if (!w) return 'unknown'
    if (w.ok === true) return 'alive'
    if (w.ok === false) return 'dead'
    if (w.error) return 'dead'
    return 'alive'
  }, [health, statuses])

  const triggerWorker = useCallback(async (name: WorkerName) => {
    setStatuses(prev => ({ ...prev, [name]: 'triggering' }))
    setTriggerResults(prev => ({ ...prev, [name]: '' }))
    try {
      const r = await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker: name }),
      })
      const data = await r.json()
      const result = data?.[name]
      const msg = result?.error
        ? `Error: ${result.error}`
        : result?.status ?? 'triggered'
      setTriggerResults(prev => ({ ...prev, [name]: msg }))
    } catch (e) {
      setTriggerResults(prev => ({ ...prev, [name]: 'network error' }))
    }
    setStatuses(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/refresh')
      if (r.ok) {
        const data = await r.json()
        if (data.health) setHealth(data.health)
      }
    } catch { /* offline */ }
  }, [setHealth])

  const triggerAll = useCallback(async () => {
    setTriggeringAll(true)
    try {
      await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      setLastRefresh(new Date())
      await refreshHealth()
    } catch { /* offline */ }
    setTriggeringAll(false)
  }, [refreshHealth])

  const WORKER_LABELS: Record<string, { label: string; interval: string }> = {
    price:     { label: 'Price Worker',     interval: '5 min' },
    news:      { label: 'News Worker',      interval: '2 min' },
    sec:       { label: 'SEC Filings',      interval: '10 min' },
    reddit:    { label: 'Reddit Sentiment', interval: '15 min' },
    engine:    { label: 'Signal Engine',    interval: '5 min' },
    options:   { label: 'Options Flow',     interval: '5 min' },
    congress:  { label: 'Congress Trades',  interval: '6 hr' },
    squeeze:   { label: 'Short Squeeze',    interval: '1 hr' },
    technical: { label: 'Technicals',       interval: '15 min' },
    earnings:  { label: 'Earnings Watch',   interval: '1 hr' },
    analyst:   { label: 'Analyst Changes',  interval: '1 hr' },
    macro:     { label: 'Macro / VIX',      interval: '30 min' },
    darkpool:  { label: 'Dark Pool',        interval: '5 min' },
    sector:    { label: 'Sector Rotation',  interval: '1 hr' },
  }

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-[#0ea5e9]" />
            Worker Admin
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Monitor and manually trigger background workers
            {lastRefresh && ` · Last triggered ${lastRefresh.toLocaleTimeString()}`}
          </p>
        </div>
        <button
          onClick={triggerAll}
          disabled={triggeringAll}
          className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-black bg-[#0ea5e9] rounded-xl disabled:opacity-50 hover:bg-[#38bdf8] active:scale-[0.98]"
          style={{ transition: 'background 0.15s, transform 0.1s' }}
        >
          {triggeringAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {triggeringAll ? 'Triggering all...' : 'Trigger All Workers'}
        </button>
      </div>

      {/* Service status banner */}
      {!configured && (
        <div className="flex items-center gap-3 px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-sm text-yellow-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          WORKER_SERVICE_URL not configured — workers cannot be triggered. Set it in your environment.
        </div>
      )}

      {/* Worker grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {workers.map(name => {
          const status = getWorkerStatus(name)
          const meta = WORKER_LABELS[name] ?? { label: name, interval: '—' }
          const result = triggerResults[name]

          return (
            <div
              key={name}
              className="flex items-center gap-4 px-4 py-3 bg-white/4 border border-white/10 rounded-2xl hover:border-white/20"
              style={{ transition: 'border-color 0.15s' }}
            >
              {/* Status icon */}
              <div className="shrink-0">
                {status === 'triggering' ? (
                  <Loader2 className="w-5 h-5 text-[#0ea5e9] animate-spin" />
                ) : status === 'alive' ? (
                  <CheckCircle className="w-5 h-5 text-green-400" />
                ) : status === 'dead' ? (
                  <XCircle className="w-5 h-5 text-red-400" />
                ) : (
                  <div className="w-5 h-5 rounded-full border-2 border-slate-600" />
                )}
              </div>

              {/* Name + interval */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">{meta.label}</p>
                <p className="text-xs text-slate-500">
                  {status === 'triggering' ? 'Running...' :
                   status === 'alive' ? 'Healthy' :
                   status === 'dead' ? 'Stale / error' : 'Status unknown'
                  } · every {meta.interval}
                </p>
                {result && (
                  <p className={`text-xs mt-0.5 ${result.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                    {result}
                  </p>
                )}
              </div>

              {/* Trigger button */}
              <button
                onClick={() => triggerWorker(name)}
                disabled={status === 'triggering' || !configured}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-white border border-white/10 rounded-lg hover:bg-white/5 disabled:opacity-40"
                style={{ transition: 'color 0.15s, background 0.15s' }}
              >
                {status === 'triggering'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5" />
                }
                Run
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
