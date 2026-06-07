'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import SignalCard, { Signal, getTypeMeta } from '@/app/components/SignalCard'
import PushToggle from '@/app/components/PushToggle'
import KeyboardShortcutsHelp from '@/app/components/KeyboardShortcutsHelp'
import QuickAddTicker from '@/app/components/QuickAddTicker'
import TickerSentiment from '@/app/components/TickerSentiment'
import FearGreedWidget from '@/app/components/FearGreedWidget'
import { useToast } from '@/app/components/Toaster'
import { useLocalStorage } from '@/app/hooks/useLocalStorage'
import { useKeyboardShortcuts } from '@/app/hooks/useKeyboardShortcuts'
import { useDocumentTitle } from '@/app/hooks/useDocumentTitle'
import {
  TrendingUp, TrendingDown, Zap, Filter, CheckCheck, RefreshCw, Loader2,
  Search, X, Volume2, VolumeX, Rows3, Rows4, Layers, ChevronDown,
  ArrowUpDown, Pause, Play, Pin, Keyboard, Sparkles, Download, Newspaper,
  History, CalendarDays,
} from 'lucide-react'

type Snapshot = {
  ticker: string
  price: number
  change_pct: number
  volume: number
  created_at: string
}

const SIGNAL_TYPES = ['all', 'convergence', 'options_unusual', 'dark_pool', 'insider_buy', 'short_squeeze', 'news_breaking', 'sec_filing', 'volume_spike', 'price_move', 'sentiment_spike', 'congress_trade', 'analyst_change', 'earnings_upcoming', 'technical', 'macro']
const TIME_RANGES = [
  { id: '1h', label: '1h', minutes: 60 },
  { id: '24h', label: '24h', minutes: 60 * 24 },
  { id: '7d', label: '7d', minutes: 60 * 24 * 7 },
  { id: 'all', label: 'All', minutes: Number.POSITIVE_INFINITY },
] as const

type TimeRangeId = typeof TIME_RANGES[number]['id']
type SortKey = 'newest' | 'oldest' | 'severity_desc' | 'severity_asc' | 'ticker'
type Density = 'compact' | 'comfortable'

const AUTO_REFRESH_SECONDS = 60

type MorningBriefSignal = {
  id: string
  title: string
  body: string
  created_at: string
  raw_data: {
    tickers?: string[]
    mention_counts?: Record<string, number>
    sample_posts?: Record<string, string[]>
    subreddits_scanned?: string[]
  } | null
}

export default function DashboardClient({
  signals: initial,
  snapshots,
  morningBrief,
}: {
  signals: Signal[]
  snapshots: Snapshot[]
  morningBrief?: MorningBriefSignal | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [signals, setSignals] = useState<Signal[]>(initial)
  const [typeFilter, setTypeFilter] = useState(() => searchParams.get('type') ?? 'all')
  const [severityFilter, setSeverityFilter] = useState(() => searchParams.get('sev') ?? 'all')
  const [timeRange, setTimeRange] = useState<TimeRangeId>(() => (searchParams.get('range') as TimeRangeId) ?? '24h')
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '')
  const [sort, setSort] = useLocalStorage<SortKey>('dash.sort', 'newest')
  const [density, setDensity] = useLocalStorage<Density>('dash.density', 'comfortable')
  const [groupByTicker, setGroupByTicker] = useLocalStorage<boolean>('dash.groupByTicker', false)
  // Feature 9: deduplicate signals — collapse same type+ticker within 1h
  const [dedupeMode, setDedupeMode] = useLocalStorage<boolean>('dash.dedupe', false)
  const [autoRefresh, setAutoRefresh] = useLocalStorage<boolean>('dash.autoRefresh', false)
  const [soundEnabled, setSoundEnabled] = useLocalStorage<boolean>('dash.sound', false)
  const [pinned, setPinned] = useLocalStorage<string[]>('dash.pinned', [])
  const [muted, setMuted] = useLocalStorage<string[]>('dash.muted', [])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusIdx, setFocusIdx] = useState<number>(-1)
  const [helpOpen, setHelpOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { toast } = useToast()
  const [refreshing, setRefreshing] = useState(false)
  const [countdown, setCountdown] = useState<number>(AUTO_REFRESH_SECONDS)

  const [briefDismissed, setBriefDismissed] = useState(false)

  // --- History mode ---
  const [historyMode, setHistoryMode] = useState(false)
  const [historyFrom, setHistoryFrom] = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [historyTo, setHistoryTo] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [historySignals, setHistorySignals] = useState<Signal[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)
  const filteredRef = useRef<HTMLDivElement>(null)
  const lastCriticalIdRef = useRef<string | null>(null)

  // --- Sync filters to URL (sharable / restorable). Debounced to avoid replace per keystroke. ---
  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams()
      if (typeFilter !== 'all') params.set('type', typeFilter)
      if (severityFilter !== 'all') params.set('sev', severityFilter)
      if (timeRange !== '24h') params.set('range', timeRange)
      if (search) params.set('q', search)
      const qs = params.toString()
      const url = qs ? `${pathname}?${qs}` : pathname
      router.replace(url, { scroll: false })
    }, 250)
    return () => clearTimeout(t)
  }, [typeFilter, severityFilter, timeRange, search, pathname, router])

  // --- Realtime subscription ---
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

  // --- Sound on new critical signals (only when toggle on) ---
  useEffect(() => {
    if (!soundEnabled) return
    const newest = signals[0]
    if (!newest || newest.severity < 9) return
    if (lastCriticalIdRef.current === newest.id) return
    if (lastCriticalIdRef.current === null) {
      // Skip playing on initial mount
      lastCriticalIdRef.current = newest.id
      return
    }
    lastCriticalIdRef.current = newest.id
    try {
      // Synth a brief alert tone via WebAudio — no asset bundling needed.
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.connect(g); g.connect(ctx.destination)
      o.frequency.setValueAtTime(880, ctx.currentTime)
      o.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18)
      g.gain.setValueAtTime(0.0001, ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45)
      o.start()
      o.stop(ctx.currentTime + 0.5)
    } catch {
      /* audio blocked (autoplay policy or unsupported) */
    }
  }, [signals, soundEnabled])

  // --- Filtering pipeline ---
  const rangeMinutes = TIME_RANGES.find(r => r.id === timeRange)?.minutes ?? Number.POSITIVE_INFINITY
  const rangeCutoff = Date.now() - rangeMinutes * 60 * 1000

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const mutedSet = new Set(muted)
    const pinnedSet = new Set(pinned)

    // In history mode, skip the time-range filter (already filtered by API date range)
    const sourceSignals = historyMode ? historySignals : signals

    const list = sourceSignals
      .filter(s => !mutedSet.has(s.ticker))
      .filter(s => historyMode ? true : Number.isFinite(rangeMinutes) ? new Date(s.created_at).getTime() >= rangeCutoff : true)
      .filter(s => typeFilter === 'all' ? true : s.signal_type === typeFilter)
      .filter(s => {
        if (severityFilter === 'all') return true
        if (severityFilter === 'critical') return s.severity >= 9
        if (severityFilter === 'high') return s.severity >= 7
        return s.severity >= 5
      })
      .filter(s => {
        if (!q) return true
        return s.ticker.toLowerCase().includes(q)
          || s.title.toLowerCase().includes(q)
          || s.body.toLowerCase().includes(q)
          || s.signal_type.replace(/_/g, ' ').toLowerCase().includes(q)
      })

    list.sort((a, b) => {
      // Pinned tickers always float to the top
      const aP = pinnedSet.has(a.ticker) ? 1 : 0
      const bP = pinnedSet.has(b.ticker) ? 1 : 0
      if (aP !== bP) return bP - aP

      switch (sort) {
        case 'oldest': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        case 'severity_desc': return b.severity - a.severity || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        case 'severity_asc': return a.severity - b.severity || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        case 'ticker': return a.ticker.localeCompare(b.ticker) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        case 'newest':
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      }
    })
    // Feature 9: dedupe — collapse same type+ticker within 1h window, keep highest severity
    if (dedupeMode) {
      const seen = new Map<string, Signal>()
      const deduped: Signal[] = []
      for (const s of list) {
        const key = `${s.ticker}::${s.signal_type}`
        const existing = seen.get(key)
        if (!existing) {
          seen.set(key, s)
          deduped.push(s)
        } else {
          const ageGap = Math.abs(new Date(s.created_at).getTime() - new Date(existing.created_at).getTime())
          if (ageGap > 3600000) { // >1h apart = different event
            seen.set(key, s)
            deduped.push(s)
          }
          // else skip — it's a duplicate within 1h
        }
      }
      return deduped
    }

    return list
  }, [signals, historySignals, historyMode, search, muted, pinned, rangeMinutes, rangeCutoff, typeFilter, severityFilter, sort, dedupeMode])

  // --- Group by ticker (memoized) ---
  const grouped = useMemo(() => {
    if (!groupByTicker) return null
    const groups = new Map<string, Signal[]>()
    for (const s of filtered) {
      const arr = groups.get(s.ticker) ?? []
      arr.push(s)
      groups.set(s.ticker, arr)
    }
    return Array.from(groups.entries()).sort((a, b) => {
      // Higher max severity first
      const aMax = Math.max(...a[1].map(x => x.severity))
      const bMax = Math.max(...b[1].map(x => x.severity))
      if (bMax !== aMax) return bMax - aMax
      return b[1].length - a[1].length
    })
  }, [filtered, groupByTicker])

  // --- Convergence-only quick subset for featured strip ---
  const convergenceSignals = useMemo(
    () => signals.filter(s => s.signal_type === 'convergence').slice(0, 3),
    [signals]
  )

  // --- Stats ---
  const unread = signals.filter(s => !s.read).length
  const critical = signals.filter(s => s.severity >= 9).length
  const todaySignals = signals.filter(s => {
    const d = new Date(s.created_at)
    const t = new Date()
    return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear()
  }).length

  const typeBreakdown = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of filtered) {
      counts[s.signal_type] = (counts[s.signal_type] ?? 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [filtered])

  // --- Document title with unread count ---
  useDocumentTitle(unread > 0 ? `(${unread}) StockBot — ${critical > 0 ? '🔴 ' : ''}Signals` : 'StockBot — Signals')

  // --- Force scan / refresh signals ---
  const refresh = useCallback(async () => {
    setRefreshing(true)
    setCountdown(AUTO_REFRESH_SECONDS)
    try { await fetch('/api/refresh', { method: 'POST' }) } catch { /* network */ }
    try {
      const r = await fetch('/api/signals?limit=100')
      if (r.ok) setSignals(await r.json())
    } catch { /* network */ }
    setRefreshing(false)
  }, [])

  // --- History fetch ---
  const fetchHistory = useCallback(async (from: string, to: string) => {
    // Swap if inverted
    const [resolvedFrom, resolvedTo] = from > to ? [to, from] : [from, to]
    setHistoryLoading(true)
    try {
      const params = new URLSearchParams({ from: resolvedFrom, to: resolvedTo, limit: '200' })
      if (typeFilter !== 'all') params.set('type', typeFilter)
      if (severityFilter !== 'all' && severityFilter !== 'medium') {
        const minSev = severityFilter === 'critical' ? '9' : severityFilter === 'high' ? '7' : '5'
        params.set('minSeverity', minSev)
      } else if (severityFilter === 'medium') {
        params.set('minSeverity', '5')
      }
      const r = await fetch(`/api/signals?${params.toString()}`)
      if (r.ok) setHistorySignals(await r.json())
    } catch { /* network */ }
    setHistoryLoading(false)
  }, [typeFilter, severityFilter])

  useEffect(() => {
    if (historyMode) {
      fetchHistory(historyFrom, historyTo)
    }
  }, [historyMode, historyFrom, historyTo, fetchHistory])

  // --- CSV Export ---
  const exportCSV = useCallback(() => {
    const escape = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = ['ticker', 'signal_type', 'severity', 'title', 'body', 'created_at']
    const rows = filtered.map(s => [
      escape(s.ticker),
      escape(s.signal_type),
      String(s.severity),
      escape(s.title),
      escape(s.body),
      escape(new Date(s.created_at).toISOString()),
    ])
    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `signals-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast(`Exported ${filtered.length} signals`, 'info')
  }, [filtered, toast])

  // --- Auto-refresh countdown ---
  useEffect(() => {
    if (!autoRefresh) {
      setCountdown(AUTO_REFRESH_SECONDS)
      return
    }
    const id = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          refresh()
          return AUTO_REFRESH_SECONDS
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [autoRefresh, refresh])

  // --- Mark read APIs ---
  const markRead = useCallback(async (ids: string[]) => {
    if (!ids.length) return
    setSignals(prev => prev.map(s => ids.includes(s.id) ? { ...s, read: true } : s))
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, read: true }),
      })
    } catch { /* offline */ }
  }, [])

  const markAllRead = useCallback(() => {
    markRead(signals.filter(s => !s.read).map(s => s.id))
  }, [signals, markRead])

  const markSelectedRead = useCallback(() => {
    markRead(Array.from(selected))
    setSelected(new Set())
  }, [markRead, selected])

  const togglePin = useCallback((ticker: string) => {
    setPinned(prev => {
      const isPinned = prev.includes(ticker)
      toast(isPinned ? `Unpinned ${ticker}` : `Pinned ${ticker}`, 'info')
      return isPinned ? prev.filter(t => t !== ticker) : [...prev, ticker]
    })
  }, [setPinned, toast])

  const muteTicker = useCallback((ticker: string) => {
    setMuted(prev => {
      if (prev.includes(ticker)) return prev
      toast(`Muted ${ticker} — signals will be hidden`, 'info')
      return [...prev, ticker]
    })
  }, [setMuted, toast])

  const unmuteTicker = useCallback((ticker: string) => {
    setMuted(prev => prev.filter(t => t !== ticker))
    toast(`Unmuted ${ticker}`, 'info')
  }, [setMuted, toast])

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleExpand = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // --- Keyboard navigation: focusIdx into filtered list ---
  useEffect(() => {
    if (focusIdx >= filtered.length) setFocusIdx(filtered.length - 1)
  }, [filtered.length, focusIdx])

  useEffect(() => {
    if (focusIdx < 0 || !filteredRef.current) return
    const el = filteredRef.current.querySelector(`[data-signal-id="${filtered[focusIdx]?.id}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusIdx, filtered])

  useKeyboardShortcuts({
    '/': () => { searchRef.current?.focus() },
    'j': () => setFocusIdx(i => Math.min(i + 1, filtered.length - 1)),
    'k': () => setFocusIdx(i => Math.max(i - 1, 0)),
    'o': () => {
      const s = filtered[focusIdx]
      if (s) router.push(`/signals/${s.id}`)
    },
    'r': () => {
      const s = filtered[focusIdx]
      if (s) markRead([s.id])
    },
    'p': () => {
      const s = filtered[focusIdx]
      if (s) togglePin(s.ticker)
    },
    'm': () => {
      const s = filtered[focusIdx]
      if (s) muteTicker(s.ticker)
    },
    'x': () => {
      const s = filtered[focusIdx]
      if (s) toggleSelect(s.id)
    },
    'a': () => markAllRead(),
    'f': () => refresh(),
    '+': () => setAddOpen(true),
    '?': () => setHelpOpen(true),
    // Feature 10: 'e' to expand/collapse focused signal
    'e': () => {
      const s = filtered[focusIdx]
      if (s) toggleExpand(s.id)
    },
    'Escape': () => {
      if (addOpen) setAddOpen(false)
      else if (helpOpen) setHelpOpen(false)
      else if (search) setSearch('')
      else if (selected.size) setSelected(new Set())
      else searchRef.current?.blur()
    },
    'g d': () => router.push('/dashboard'),
    'g s': () => router.push('/scanner'),
    'g p': () => router.push('/portfolio'),
    'g w': () => router.push('/watchlist'),
  })

  return (
    <div className="flex flex-col xl:flex-row gap-4 md:gap-6 items-start">
      {/* Main signal feed column */}
      <div className="flex flex-col gap-4 md:gap-6 flex-1 min-w-0">
      {helpOpen && <KeyboardShortcutsHelp onClose={() => setHelpOpen(false)} />}
      <QuickAddTicker open={addOpen} onClose={() => setAddOpen(false)} onAdded={refresh} />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-white tracking-tight">Signal Feed</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {todaySignals} today · {unread} unread{muted.length > 0 ? ` · ${muted.length} muted` : ''}
            {pinned.length > 0 ? ` · ${pinned.length} pinned` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {critical > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 border border-red-500/25 rounded">
              <Zap className="w-3.5 h-3.5 text-red-400" />
              <span className="text-xs font-bold text-red-400">{critical} critical</span>
            </div>
          )}

          <button
            onClick={() => setSoundEnabled(s => !s)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-500 hover:text-white border border-white/[0.08] rounded hover:bg-white/[0.04]"
            style={{ transition: 'color 0.1s, background 0.1s' }}
            title={soundEnabled ? 'Mute alerts' : 'Sound alerts'}
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs border rounded ${autoRefresh ? 'text-sky-400 border-sky-500/25 bg-sky-500/8' : 'text-slate-500 hover:text-white border-white/[0.08] hover:bg-white/[0.04]'}`}
            style={{ transition: 'color 0.1s, background 0.1s' }}
            title={autoRefresh ? `Auto-refresh ${countdown}s` : 'Auto-refresh off'}
          >
            {autoRefresh ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{autoRefresh ? `${countdown}s` : 'Auto'}</span>
          </button>

          {unread > 0 && (
            <button onClick={markAllRead} className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-500 hover:text-white border border-white/[0.08] rounded hover:bg-white/[0.04]" style={{ transition: 'color 0.1s, background 0.1s' }}>
              <CheckCheck className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">All read</span>
            </button>
          )}

          <PushToggle />

          <button
            onClick={exportCSV}
            disabled={filtered.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-500 hover:text-white border border-white/[0.08] rounded hover:bg-white/[0.04] disabled:opacity-30"
            style={{ transition: 'color 0.1s, background 0.1s' }}
            title="Export CSV"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">CSV</span>
          </button>

          <button
            onClick={() => setHistoryMode(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs border rounded ${historyMode ? 'text-yellow-400 border-yellow-500/25 bg-yellow-500/8' : 'text-slate-500 hover:text-white border-white/[0.08] hover:bg-white/[0.04]'}`}
            style={{ transition: 'color 0.1s, background 0.1s' }}
            title="History mode"
          >
            <History className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">History</span>
          </button>

          <button onClick={refresh} disabled={refreshing || historyMode} className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-500 hover:text-white border border-white/[0.08] rounded hover:bg-white/[0.04] disabled:opacity-40" style={{ transition: 'color 0.1s, background 0.1s' }}>
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{refreshing ? 'Scanning…' : 'Refresh'}</span>
          </button>

          <button
            onClick={() => setHelpOpen(true)}
            className="hidden sm:flex items-center px-2.5 py-1 text-xs text-slate-600 hover:text-white border border-white/[0.08] rounded hover:bg-white/[0.04]"
            style={{ transition: 'color 0.1s, background 0.1s' }}
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* History mode date range bar */}
      {historyMode && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-[#f59e0b]/8 border border-[#f59e0b]/25 rounded-2xl">
          <CalendarDays className="w-4 h-4 text-[#f59e0b] shrink-0" />
          <span className="text-xs font-bold text-[#f59e0b]">History Mode</span>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-slate-500 shrink-0">From</label>
              <input
                type="date"
                value={historyFrom}
                onChange={e => setHistoryFrom(e.target.value)}
                max={historyTo}
                className="px-2 py-1 bg-white/8 border border-white/15 rounded-lg text-xs text-white focus:outline-none focus:border-[#f59e0b]/60"
                style={{ fontSize: 16 }}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-slate-500 shrink-0">To</label>
              <input
                type="date"
                value={historyTo}
                onChange={e => setHistoryTo(e.target.value)}
                min={historyFrom}
                max={new Date().toISOString().slice(0, 10)}
                className="px-2 py-1 bg-white/8 border border-white/15 rounded-lg text-xs text-white focus:outline-none focus:border-[#f59e0b]/60"
                style={{ fontSize: 16 }}
              />
            </div>
          </div>
          {historyLoading
            ? <Loader2 className="w-3.5 h-3.5 text-[#f59e0b] animate-spin" />
            : <span className="text-xs text-slate-400 ml-auto">
                Showing {filtered.length} signal{filtered.length !== 1 ? 's' : ''} from {historyFrom} to {historyTo}
              </span>
          }
        </div>
      )}

      {/* Feature 7: Pinned ticker mini-watchdog strip */}
      {pinned.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1">
          {pinned.map(ticker => {
            const tickerSignals = signals.filter(s => s.ticker === ticker)
            const latest = tickerSignals.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
            const unread = tickerSignals.filter(s => !s.read).length
            const maxSev = tickerSignals.length > 0 ? Math.max(...tickerSignals.map(s => s.severity)) : 0
            const ageMs = latest ? Date.now() - new Date(latest.created_at).getTime() : Infinity
            const ageLabel = ageMs < 3600000 ? `${Math.round(ageMs / 60000)}m`
              : ageMs < 86400000 ? `${Math.round(ageMs / 3600000)}h` : '24h+'
            return (
              <button
                key={ticker}
                onClick={() => setSearch(ticker)}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl shrink-0 border ${maxSev >= 8 ? 'bg-orange-500/10 border-orange-500/25' : maxSev >= 6 ? 'bg-yellow-500/8 border-yellow-500/20' : 'bg-white/[0.04] border-white/[0.08]'}`}
                style={{ transition: 'all 0.1s' }}
              >
                <span className="text-xs font-bold font-mono text-white">📌 {ticker}</span>
                {tickerSignals.length > 0 && (
                  <>
                    <span className={`text-[10px] font-bold ${maxSev >= 8 ? 'text-orange-400' : maxSev >= 6 ? 'text-yellow-400' : 'text-slate-400'}`}>
                      {maxSev}/10
                    </span>
                    {unread > 0 && (
                      <span className="text-[9px] font-bold text-sky-400 bg-sky-500/15 px-1 rounded">{unread}</span>
                    )}
                    <span className="text-[9px] text-slate-600">{ageLabel}</span>
                  </>
                )}
                {tickerSignals.length === 0 && <span className="text-[10px] text-slate-600">no signals</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* Morning Brief banner */}
      {morningBrief && !briefDismissed && (
        <MorningBriefBanner brief={morningBrief} onDismiss={() => setBriefDismissed(true)} />
      )}

      {/* Featured convergence signals */}
      {convergenceSignals.length > 0 && (
        <div className="border border-red-500/20 rounded-2xl p-3 bg-red-500/5">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-red-400" />
            <p className="text-xs font-bold text-red-400 uppercase tracking-wider">Convergence alerts</p>
          </div>
          <div className="flex flex-col gap-2">
            {convergenceSignals.map(s => (
              <SignalCard key={s.id} signal={s} density="compact" />
            ))}
          </div>
        </div>
      )}

      {/* Ticker tape */}
      {snapshots.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1">
          {snapshots.slice(0, 12).map(snap => (
            <button
              key={snap.ticker}
              onClick={() => setSearch(snap.ticker)}
              className="flex items-center gap-2 px-3 py-2 bg-white/4 border border-white/8 rounded-xl shrink-0 hover:bg-white/8 hover:border-white/15"
              style={{ transition: 'background 0.15s, border-color 0.15s' }}
            >
              <span className="text-xs font-bold text-white font-mono">{snap.ticker}</span>
              <span className="text-xs text-slate-300 tabular">${snap.price?.toFixed(2)}</span>
              <span className={`text-xs font-semibold tabular flex items-center gap-0.5 ${snap.change_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {snap.change_pct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {snap.change_pct >= 0 ? '+' : ''}{snap.change_pct?.toFixed(2)}%
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Search + filters (sticky) */}
      <div className="sticky top-0 z-20 -mx-3 px-3 sm:mx-0 sm:px-0 bg-[#070b13]/90 backdrop-blur-md py-2 -my-2">
        {/* Search */}
        <div className="relative mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ticker or type… (press /)"
            className="w-full pl-9 pr-9 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50"
            style={{ transition: 'border-color 0.1s', fontSize: '16px', lineHeight: '1.4' }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-white"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filter row — all controls locked to small size regardless of body font */}
        <div className="flex gap-1.5 flex-wrap items-center" style={{ fontSize: '12px' }}>
          <Filter className="w-3.5 h-3.5 text-slate-600 shrink-0" />

          {/* Time range chips */}
          <div className="flex bg-white/[0.03] border border-white/[0.08] rounded overflow-hidden">
            {TIME_RANGES.map(r => (
              <button
                key={r.id}
                onClick={() => setTimeRange(r.id)}
                className={`px-2.5 py-1 font-semibold ${timeRange === r.id ? 'bg-sky-500/15 text-sky-400' : 'text-slate-500 hover:text-slate-200'}`}
                style={{ fontSize: '11px', transition: 'color 0.1s, background 0.1s' }}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Type filter */}
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-slate-300 focus:outline-none focus:border-sky-500/50 cursor-pointer"
            style={{ fontSize: '12px', lineHeight: '1.4' }}
          >
            {SIGNAL_TYPES.map(t => (
              <option key={t} value={t} className="bg-[#0d1220] text-slate-200">
                {t === 'all' ? 'All types' : getTypeMeta(t).label}
              </option>
            ))}
          </select>

          {/* Severity filter */}
          <select
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value)}
            className="px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-slate-300 focus:outline-none focus:border-sky-500/50 cursor-pointer"
            style={{ fontSize: '12px', lineHeight: '1.4' }}
          >
            <option value="all" className="bg-[#0d1220]">All severity</option>
            <option value="critical" className="bg-[#0d1220]">Critical 9+</option>
            <option value="high" className="bg-[#0d1220]">High 7+</option>
            <option value="medium" className="bg-[#0d1220]">Medium 5+</option>
          </select>

          {/* Sort */}
          <div className="relative">
            <ArrowUpDown className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-600 pointer-events-none" />
            <select
              value={sort}
              onChange={e => setSort(e.target.value as SortKey)}
              className="pl-6 pr-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-slate-300 focus:outline-none focus:border-sky-500/50 cursor-pointer"
              style={{ fontSize: '12px', lineHeight: '1.4' }}
            >
              <option value="newest" className="bg-[#0d1220]">Newest</option>
              <option value="oldest" className="bg-[#0d1220]">Oldest</option>
              <option value="severity_desc" className="bg-[#0d1220]">Severity ↓</option>
              <option value="severity_asc" className="bg-[#0d1220]">Severity ↑</option>
              <option value="ticker" className="bg-[#0d1220]">Ticker A–Z</option>
            </select>
          </div>

          {/* Density */}
          <button
            onClick={() => setDensity(d => d === 'compact' ? 'comfortable' : 'compact')}
            className="flex items-center gap-1 px-2 py-1 text-slate-500 hover:text-slate-200 border border-white/[0.08] rounded hover:bg-white/[0.04]"
            style={{ transition: 'color 0.1s, background 0.1s' }}
            title={density === 'compact' ? 'Comfortable' : 'Compact'}
          >
            {density === 'compact' ? <Rows4 className="w-3.5 h-3.5" /> : <Rows3 className="w-3.5 h-3.5" />}
          </button>

          {/* Group by ticker */}
          <button
            onClick={() => setGroupByTicker(v => !v)}
            className={`flex items-center gap-1 px-2 py-1 border rounded ${groupByTicker ? 'text-sky-400 border-sky-500/30 bg-sky-500/10' : 'text-slate-500 hover:text-slate-200 border-white/[0.08] hover:bg-white/[0.04]'}`}
            style={{ transition: 'color 0.1s, background 0.1s' }}
            title={groupByTicker ? 'Ungroup' : 'Group by ticker'}
          >
            <Layers className="w-3.5 h-3.5" />
          </button>

          {/* Feature 9: dedupe toggle */}
          <button
            onClick={() => setDedupeMode(v => !v)}
            className={`flex items-center gap-1 px-2 py-1 border rounded text-[11px] font-semibold ${dedupeMode ? 'text-purple-400 border-purple-500/30 bg-purple-500/10' : 'text-slate-500 hover:text-slate-200 border-white/[0.08] hover:bg-white/[0.04]'}`}
            style={{ transition: 'color 0.1s, background 0.1s' }}
            title="Collapse duplicate signals (same type+ticker within 1h)"
          >
            Dedup
          </button>

          <span className="text-slate-600 ml-auto tabular-nums" style={{ fontSize: '11px' }}>{filtered.length}</span>
        </div>

        {/* Selection actions row */}
        {selected.size > 0 && (
          <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-[#0ea5e9]/10 border border-[#0ea5e9]/30 rounded-xl">
            <span className="text-xs font-semibold text-[#0ea5e9]">{selected.size} selected</span>
            <button
              onClick={markSelectedRead}
              className="ml-auto px-2.5 py-1 text-xs font-semibold text-[#0ea5e9] hover:text-white border border-[#0ea5e9]/30 rounded-lg hover:bg-[#0ea5e9]/10"
              style={{ transition: 'color 0.15s, background 0.15s' }}
            >
              Mark read
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="px-2.5 py-1 text-xs font-semibold text-slate-400 hover:text-white border border-white/10 rounded-lg hover:bg-white/5"
              style={{ transition: 'color 0.15s, background 0.15s' }}
            >
              Clear
            </button>
          </div>
        )}

        {/* Active filter pills */}
        {(typeFilter !== 'all' || severityFilter !== 'all' || search || muted.length > 0 || pinned.length > 0) && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            {search && (
              <FilterPill label={`"${search}"`} onClear={() => setSearch('')} />
            )}
            {typeFilter !== 'all' && (
              <FilterPill label={getTypeMeta(typeFilter).label} onClear={() => setTypeFilter('all')} />
            )}
            {severityFilter !== 'all' && (
              <FilterPill label={severityFilter} onClear={() => setSeverityFilter('all')} />
            )}
            {pinned.map(t => (
              <FilterPill key={`p-${t}`} label={`📌 ${t}`} onClear={() => togglePin(t)} />
            ))}
            {muted.map(t => (
              <FilterPill key={`m-${t}`} label={`🔇 ${t}`} onClear={() => unmuteTicker(t)} />
            ))}
          </div>
        )}

        {/* Type breakdown */}
        {typeBreakdown.length > 1 && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap text-xs text-slate-500">
            <span>Breakdown:</span>
            {typeBreakdown.map(([type, count]) => {
              const meta = getTypeMeta(type)
              return (
                <button
                  key={type}
                  onClick={() => setTypeFilter(typeFilter === type ? 'all' : type)}
                  className={`px-2 py-0.5 rounded-full font-medium border ${typeFilter === type ? 'bg-white/10 text-white border-white/15' : 'bg-white/3 text-slate-400 border-white/8 hover:text-white'}`}
                  style={{ transition: 'color 0.15s, background 0.15s, border-color 0.15s' }}
                >
                  <span className={meta.color}>●</span> {meta.label} {count}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Signal feed */}
      <div ref={filteredRef} className={`flex flex-col pb-24 md:pb-12 ${groupByTicker && grouped ? 'gap-2' : filtered.length === 0 ? '' : 'panel overflow-hidden'}`}>
        {filtered.length === 0 ? (
          <EmptyState
            hasFilters={search.length > 0 || typeFilter !== 'all' || severityFilter !== 'all' || timeRange !== 'all'}
            onClear={() => { setSearch(''); setTypeFilter('all'); setSeverityFilter('all'); setTimeRange('all') }}
          />
        ) : groupByTicker && grouped ? (
          grouped.map(([ticker, sigs]) => (
            <TickerGroup
              key={ticker}
              ticker={ticker}
              signals={sigs}
              density={density}
              expanded={expanded}
              pinned={pinned}
              selected={selected}
              onToggleExpand={toggleExpand}
              onTogglePin={togglePin}
              onMuteTicker={muteTicker}
              onSelect={toggleSelect}
            />
          ))
        ) : (
          filtered.map((signal, i) => (
            <SignalCard
              key={signal.id}
              signal={signal}
              density={density}
              expanded={expanded.has(signal.id)}
              selected={selected.has(signal.id)}
              focused={focusIdx === i}
              pinned={pinned.includes(signal.ticker)}
              selectable
              onSelect={() => toggleSelect(signal.id)}
              onToggleExpand={toggleExpand}
              onTogglePin={togglePin}
              onMuteTicker={muteTicker}
            />
          ))
        )}
      </div>
      </div>{/* end main column */}

      {/* Right sidebar — Fear & Greed + Reddit Sentiment + signal analytics */}
      <div className="w-full xl:w-80 xl:shrink-0 pb-8 xl:pb-0 xl:sticky xl:top-4 flex flex-col gap-4">
        <FearGreedWidget />
        <TickerSentiment />

        {/* Signal velocity — how fast signals are arriving vs last hour */}
        {(() => {
          const now = Date.now()
          const lastHour = signals.filter(s => now - new Date(s.created_at).getTime() < 3600000).length
          const prevHour = signals.filter(s => {
            const age = now - new Date(s.created_at).getTime()
            return age >= 3600000 && age < 7200000
          }).length
          const velocity = lastHour - prevHour
          const pct = prevHour > 0 ? ((velocity / prevHour) * 100).toFixed(0) : null
          return (
            <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-2">Signal Velocity</p>
              <div className="flex items-end gap-2">
                <span className="text-2xl font-bold text-white tabular-nums">{lastHour}</span>
                <span className="text-xs text-slate-500 mb-0.5">last hour</span>
                {pct != null && (
                  <span className={`text-xs font-bold ml-auto mb-0.5 ${velocity > 0 ? 'text-orange-400' : velocity < 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {velocity > 0 ? '↑' : velocity < 0 ? '↓' : '='}{Math.abs(Number(pct))}% vs prev hour
                  </span>
                )}
              </div>
              <div className="flex gap-1 mt-2">
                {Array.from({ length: 12 }).map((_, i) => {
                  const from = now - (12 - i) * 300000
                  const to = now - (11 - i) * 300000
                  const count = signals.filter(s => {
                    const t = new Date(s.created_at).getTime()
                    return t >= from && t < to
                  }).length
                  const maxCount = 5
                  return (
                    <div key={i} className="flex-1 flex items-end" style={{ height: 24 }}>
                      <div
                        className={`w-full rounded-sm ${count > 0 ? 'bg-sky-400/60' : 'bg-white/[0.05]'}`}
                        style={{ height: count > 0 ? `${Math.min(100, (count / maxCount) * 100)}%` : '20%' }}
                      />
                    </div>
                  )
                })}
              </div>
              <p className="text-[10px] text-slate-600 mt-1">5-min bars · last 60 min</p>
            </div>
          )
        })()}

        {/* Ticker leaderboard — most active tickers in current view */}
        {(() => {
          const tickerCounts: Record<string, { count: number; maxSev: number; unread: number }> = {}
          for (const s of filtered) {
            if (!tickerCounts[s.ticker]) tickerCounts[s.ticker] = { count: 0, maxSev: 0, unread: 0 }
            tickerCounts[s.ticker].count++
            if (s.severity > tickerCounts[s.ticker].maxSev) tickerCounts[s.ticker].maxSev = s.severity
            if (!s.read) tickerCounts[s.ticker].unread++
          }
          const ranked = Object.entries(tickerCounts).sort((a, b) => b[1].maxSev - a[1].maxSev || b[1].count - a[1].count).slice(0, 7)
          if (ranked.length === 0) return null
          return (
            <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Hottest Tickers</p>
              <div className="flex flex-col gap-2">
                {ranked.map(([ticker, { count, maxSev, unread }]) => (
                  <div key={ticker} className="flex items-center gap-2">
                    <button
                      onClick={() => setSearch(ticker)}
                      className="font-bold font-mono text-xs text-white hover:text-sky-400 w-14 text-left shrink-0"
                      style={{ transition: 'color 0.1s' }}
                    >
                      {ticker}
                    </button>
                    <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${maxSev >= 9 ? 'bg-red-400' : maxSev >= 7 ? 'bg-orange-400' : maxSev >= 5 ? 'bg-yellow-400' : 'bg-sky-400'}`}
                        style={{ width: `${Math.min(100, (count / Math.max(...ranked.map(r => r[1].count))) * 100)}%`, opacity: 0.7 }}
                      />
                    </div>
                    <span className="text-[10px] text-slate-500 tabular-nums w-8 text-right">{count}</span>
                    {unread > 0 && <span className="text-[9px] text-sky-400 font-bold w-6 text-right">{unread}n</span>}
                    <span className={`text-[10px] font-bold w-6 text-right ${maxSev >= 9 ? 'text-red-400' : maxSev >= 7 ? 'text-orange-400' : maxSev >= 5 ? 'text-yellow-400' : 'text-slate-400'}`}>
                      {maxSev}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-slate-600 mt-2">click ticker to filter · sorted by severity</p>
            </div>
          )
        })()}

        {/* Severity trend — sparkline of avg severity over last 24h in 2h buckets */}
        {(() => {
          const now = Date.now()
          const buckets = Array.from({ length: 12 }).map((_, i) => {
            const from = now - (12 - i) * 7200000
            const to = now - (11 - i) * 7200000
            const bucket = signals.filter(s => {
              const t = new Date(s.created_at).getTime()
              return t >= from && t < to
            })
            const avg = bucket.length > 0 ? bucket.reduce((s, x) => s + x.severity, 0) / bucket.length : 0
            return { avg, count: bucket.length, hour: new Date(from).getHours() }
          })
          const maxAvg = Math.max(...buckets.map(b => b.avg), 1)
          return (
            <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Severity Trend (24h)</p>
              <div className="flex gap-1 items-end" style={{ height: 40 }}>
                {buckets.map((b, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={`${b.hour}:00 — avg ${b.avg.toFixed(1)}, ${b.count} signals`}>
                    <div
                      className={`w-full rounded-t ${b.avg >= 8 ? 'bg-red-400/70' : b.avg >= 6 ? 'bg-orange-400/70' : b.avg >= 4 ? 'bg-yellow-400/70' : b.count > 0 ? 'bg-sky-400/50' : 'bg-white/[0.05]'}`}
                      style={{ height: b.count > 0 ? `${Math.max(15, (b.avg / maxAvg) * 100)}%` : '15%' }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between mt-1 text-[10px] text-slate-600 tabular-nums">
                <span>24h ago</span>
                <span>now</span>
              </div>
            </div>
          )
        })()}

        {/* Signal type breakdown mini bar chart */}
        {typeBreakdown.length > 0 && (
          <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Signal Mix</p>
            <div className="flex flex-col gap-1.5">
              {typeBreakdown.map(([type, count]) => {
                const { label } = getTypeMeta(type)
                const maxCount = typeBreakdown[0][1]
                return (
                  <div key={type} className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400 w-24 truncate shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
                      <div className="h-full bg-sky-400/50 rounded-full" style={{ width: `${(count / maxCount) * 100}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-500 tabular-nums w-4 text-right">{count}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

function MorningBriefBanner({
  brief,
  onDismiss,
}: {
  brief: MorningBriefSignal
  onDismiss: () => void
}) {
  const tickers = brief.raw_data?.tickers ?? []
  const mentionCounts = brief.raw_data?.mention_counts ?? {}
  const ts = new Date(brief.created_at)
  const timeStr = ts.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/New_York',
    hour12: true,
  })

  // Parse body as numbered list items if possible
  const bodyLines = brief.body
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  return (
    <div className="rounded-2xl border border-[#0ea5e9]/20 bg-[#0ea5e9]/8 p-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-[#0ea5e9] shrink-0" />
          <div>
            <p className="text-sm font-bold text-[#0ea5e9] leading-tight">{brief.title}</p>
            <p className="text-xs text-slate-500 mt-0.5">Reddit scan · {timeStr} ET</p>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className="p-1 rounded-md text-slate-500 hover:text-white hover:bg-white/8 shrink-0"
          style={{ transition: 'color 0.15s, background 0.15s' }}
          aria-label="Dismiss morning brief"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Ticker chips */}
      {tickers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {tickers.map(ticker => (
            <span
              key={ticker}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#0ea5e9]/15 border border-[#0ea5e9]/25 text-xs font-bold text-[#0ea5e9] font-mono"
            >
              ${ticker}
              {mentionCounts[ticker] != null && (
                <span className="font-normal text-slate-400">×{mentionCounts[ticker]}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Synthesis body */}
      <div className="space-y-1.5">
        {bodyLines.map((line, i) => (
          <p key={i} className="text-xs text-slate-300 leading-relaxed">
            {line}
          </p>
        ))}
      </div>
    </div>
  )
}

function FilterPill({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-xs text-slate-300">
      {label}
      <button onClick={onClear} className="text-slate-500 hover:text-white" aria-label="Remove filter" style={{ transition: 'color 0.15s' }}>
        <X className="w-3 h-3" />
      </button>
    </span>
  )
}

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-slate-600 gap-3">
      <Zap className="w-8 h-8" />
      {hasFilters ? (
        <>
          <p className="text-sm text-center">No signals match your filters</p>
          <button
            onClick={onClear}
            className="px-3 py-1.5 text-xs font-semibold text-[#0ea5e9] border border-[#0ea5e9]/30 rounded-lg hover:bg-[#0ea5e9]/10"
            style={{ transition: 'background 0.15s' }}
          >
            Clear filters
          </button>
        </>
      ) : (
        <p className="text-sm text-center max-w-xs">
          No signals yet — add tickers to your watchlist or portfolio to start tracking
        </p>
      )}
    </div>
  )
}

function TickerGroup({
  ticker, signals, density, expanded, pinned, selected,
  onToggleExpand, onTogglePin, onMuteTicker, onSelect,
}: {
  ticker: string
  signals: Signal[]
  density: Density
  expanded: Set<string>
  pinned: string[]
  selected: Set<string>
  onToggleExpand: (id: string) => void
  onTogglePin: (ticker: string) => void
  onMuteTicker: (ticker: string) => void
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  const maxSev = Math.max(...signals.map(s => s.severity))
  const unreadCount = signals.filter(s => !s.read).length
  const isPinned = pinned.includes(ticker)

  return (
    <div className="border border-white/8 rounded-2xl bg-white/2 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5"
        style={{ transition: 'background 0.15s' }}
      >
        <ChevronDown className={`w-3.5 h-3.5 text-slate-500 ${open ? '' : '-rotate-90'}`} style={{ transition: 'transform 0.15s' }} />
        <span className="text-sm font-bold font-mono text-white">{ticker}</span>
        {isPinned && <Pin className="w-3 h-3 text-yellow-400 fill-yellow-400" />}
        <span className="text-xs text-slate-500">{signals.length} signal{signals.length === 1 ? '' : 's'}</span>
        {unreadCount > 0 && <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[#0ea5e9]/20 text-[#0ea5e9]">{unreadCount} new</span>}
        <span className={`ml-auto text-xs font-bold ${maxSev >= 9 ? 'text-red-400' : maxSev >= 7 ? 'text-orange-400' : maxSev >= 5 ? 'text-yellow-400' : 'text-slate-400'}`}>max {Number(maxSev).toFixed(1)}/10</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2">
          {signals.map(s => (
            <SignalCard
              key={s.id}
              signal={s}
              density={density}
              expanded={expanded.has(s.id)}
              selected={selected.has(s.id)}
              pinned={isPinned}
              selectable
              onSelect={() => onSelect(s.id)}
              onToggleExpand={onToggleExpand}
              onTogglePin={onTogglePin}
              onMuteTicker={onMuteTicker}
            />
          ))}
        </div>
      )}
    </div>
  )
}
