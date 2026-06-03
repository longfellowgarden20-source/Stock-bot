'use client'

import { useState, useEffect } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import SignalCard, { Signal } from '@/app/components/SignalCard'
import { TrendingUp, TrendingDown, Zap, Filter, CheckCheck, RefreshCw, Loader2 } from 'lucide-react'

type Snapshot = {
  ticker: string
  price: number
  change_pct: number
  volume: number
  created_at: string
}

const SIGNAL_TYPES = ['all', 'options_unusual', 'dark_pool', 'insider_buy', 'short_squeeze', 'news_breaking', 'sec_filing', 'volume_spike', 'sentiment_spike', 'congress_trade', 'analyst_change', 'earnings_upcoming']

export default function DashboardClient({ signals: initial, snapshots }: { signals: Signal[]; snapshots: Snapshot[] }) {
  const [signals, setSignals] = useState<Signal[]>(initial)
  const [typeFilter, setTypeFilter] = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')

  // Realtime subscription
  useEffect(() => {
    const supabase = getSupabaseBrowser()
    const channel = supabase
      .channel('signals')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals' }, payload => {
        setSignals(prev => [payload.new as Signal, ...prev])
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const filtered = signals
    .filter(s => typeFilter === 'all' ? true : s.signal_type === typeFilter)
    .filter(s => severityFilter === 'all' ? true : severityFilter === 'critical' ? s.severity >= 9 : severityFilter === 'high' ? s.severity >= 7 : s.severity >= 5)

  const unread = signals.filter(s => !s.read).length
  const critical = signals.filter(s => s.severity >= 9).length
  const todaySignals = signals.filter(s => new Date(s.created_at).toDateString() === new Date().toDateString()).length

  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try { await fetch('/api/refresh', { method: 'POST' }) } catch {}
    // Re-fetch latest signals
    try {
      const r = await fetch('/api/signals?limit=50')
      if (r.ok) setSignals(await r.json())
    } catch {}
    setRefreshing(false)
  }

  const markAllRead = async () => {
    const unreadIds = signals.filter(s => !s.read).map(s => s.id)
    if (!unreadIds.length) return
    setSignals(prev => prev.map(s => ({ ...s, read: true })))
    await fetch('/api/signals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: unreadIds, read: true }),
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Signal Feed</h1>
          <p className="text-sm text-slate-500 mt-0.5">{todaySignals} signals today · {unread} unread</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {critical > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl">
              <Zap className="w-4 h-4 text-red-400" />
              <span className="text-sm font-bold text-red-400">{critical} critical</span>
            </div>
          )}
          {unread > 0 && (
            <button onClick={markAllRead} className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-400 hover:text-white border border-white/10 rounded-xl hover:bg-white/5" style={{ transition: 'color 0.15s, background 0.15s' }}>
              <CheckCheck className="w-3.5 h-3.5" />
              Mark all read
            </button>
          )}
          <button onClick={refresh} disabled={refreshing} className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-400 hover:text-white border border-white/10 rounded-xl hover:bg-white/5 disabled:opacity-50" style={{ transition: 'color 0.15s, background 0.15s' }}>
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {refreshing ? 'Scanning...' : 'Force scan'}
          </button>
        </div>
      </div>

      {/* Ticker tape */}
      {snapshots.length > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-none">
          {snapshots.slice(0, 10).map(snap => (
            <div key={snap.ticker} className="flex items-center gap-2 px-3 py-2 bg-white/4 border border-white/8 rounded-xl shrink-0">
              <span className="text-xs font-bold text-white font-mono">{snap.ticker}</span>
              <span className="text-xs text-slate-300 tabular">${snap.price?.toFixed(2)}</span>
              <span className={`text-xs font-semibold tabular flex items-center gap-0.5 ${snap.change_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {snap.change_pct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {snap.change_pct >= 0 ? '+' : ''}{snap.change_pct?.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <Filter className="w-4 h-4 text-slate-500 shrink-0" />
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-[#0ea5e9]/60 cursor-pointer"
        >
          {SIGNAL_TYPES.map(t => (
            <option key={t} value={t} className="bg-[#0a0f1a]">
              {t === 'all' ? 'All types' : t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </option>
          ))}
        </select>
        <select
          value={severityFilter}
          onChange={e => setSeverityFilter(e.target.value)}
          className="px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-[#0ea5e9]/60 cursor-pointer"
        >
          <option value="all" className="bg-[#0a0f1a]">All severity</option>
          <option value="critical" className="bg-[#0a0f1a]">Critical (9-10)</option>
          <option value="high" className="bg-[#0a0f1a]">High (7-10)</option>
          <option value="medium" className="bg-[#0a0f1a]">Medium (5+)</option>
        </select>
        <span className="text-xs text-slate-500 ml-auto">{filtered.length} signals</span>
      </div>

      {/* Signal feed */}
      <div className="flex flex-col gap-3">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-slate-600 gap-3">
            <Zap className="w-8 h-8" />
            <p className="text-sm">No signals yet — add tickers to your watchlist to start tracking</p>
          </div>
        ) : (
          filtered.map(signal => <SignalCard key={signal.id} signal={signal} />)
        )}
      </div>
    </div>
  )
}
