'use client'

import { Zap, TrendingUp, TrendingDown, BarChart2, FileText, Newspaper, MessageSquare, Users, AlertTriangle, DollarSign, Calendar, ArrowUpRight, Activity, Globe, Layers, Pin, PinOff, VolumeX, ChevronDown, ChevronUp } from 'lucide-react'
import Link from 'next/link'
import { MouseEvent, KeyboardEvent } from 'react'

export type Signal = {
  id: string
  ticker: string
  signal_type: string
  severity: number
  title: string
  body: string
  created_at: string
  read: boolean
}

const TYPE_META: Record<string, { label: string; icon: React.ElementType; color: string; accent: string }> = {
  price_move:        { label: 'PRICE',     icon: TrendingUp,    color: 'text-sky-400',    accent: '#0ea5e9' },
  volume_spike:      { label: 'VOLUME',    icon: BarChart2,     color: 'text-violet-400', accent: '#8b5cf6' },
  options_unusual:   { label: 'OPTIONS',   icon: Zap,           color: 'text-yellow-400', accent: '#eab308' },
  dark_pool:         { label: 'DARKPOOL',  icon: DollarSign,    color: 'text-orange-400', accent: '#f97316' },
  insider_buy:       { label: 'INSIDER ▲', icon: TrendingUp,    color: 'text-emerald-400',accent: '#10b981' },
  insider_sell:      { label: 'INSIDER ▼', icon: TrendingDown,  color: 'text-red-400',    accent: '#ef4444' },
  news_breaking:     { label: 'NEWS',      icon: Newspaper,     color: 'text-sky-400',    accent: '#0ea5e9' },
  sec_filing:        { label: 'SEC',       icon: FileText,      color: 'text-slate-400',  accent: '#64748b' },
  sentiment_spike:   { label: 'SENTIMENT', icon: MessageSquare, color: 'text-pink-400',   accent: '#ec4899' },
  short_squeeze:     { label: 'SQUEEZE',   icon: AlertTriangle, color: 'text-orange-400', accent: '#f97316' },
  earnings_upcoming: { label: 'EARNINGS',  icon: Calendar,      color: 'text-yellow-400', accent: '#eab308' },
  analyst_change:    { label: 'ANALYST',   icon: Users,         color: 'text-sky-400',    accent: '#0ea5e9' },
  congress_trade:    { label: 'CONGRESS',  icon: DollarSign,    color: 'text-emerald-400',accent: '#10b981' },
  technical:         { label: 'TECHNICAL', icon: Activity,      color: 'text-cyan-400',   accent: '#06b6d4' },
  macro:             { label: 'MACRO',     icon: Globe,         color: 'text-indigo-400', accent: '#6366f1' },
  convergence:       { label: 'CONVERGE',  icon: Layers,        color: 'text-red-400',    accent: '#ef4444' },
}

export function getTypeMeta(t: string) {
  return TYPE_META[t] ?? { label: t.toUpperCase().replace(/_/g, ' '), icon: Zap, color: 'text-slate-400', accent: '#475569' }
}

function severityAccent(s: number): string {
  if (s >= 9) return '#ef4444'
  if (s >= 7) return '#f97316'
  if (s >= 5) return '#eab308'
  return '#334155'
}

function severityLabel(s: number): string {
  if (s >= 9) return 'text-red-400'
  if (s >= 7) return 'text-orange-400'
  if (s >= 5) return 'text-yellow-400'
  return 'text-slate-500'
}

export function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

type Props = {
  signal: Signal
  density?: 'compact' | 'comfortable'
  selected?: boolean
  focused?: boolean
  expanded?: boolean
  pinned?: boolean
  selectable?: boolean
  onSelect?: (id: string, e: MouseEvent | KeyboardEvent) => void
  onToggleExpand?: (id: string) => void
  onTogglePin?: (ticker: string) => void
  onMuteTicker?: (ticker: string) => void
}

export default function SignalCard({
  signal,
  density = 'comfortable',
  selected = false,
  focused = false,
  expanded = false,
  pinned = false,
  selectable = false,
  onSelect,
  onToggleExpand,
  onTogglePin,
  onMuteTicker,
}: Props) {
  const meta = getTypeMeta(signal.signal_type)
  const Icon = meta.icon
  const isPulse = signal.severity >= 9 && !signal.read
  const isCompact = density === 'compact'
  const accent = severityAccent(signal.severity)

  const stop = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      className={[
        'group relative border-b border-white/[0.05] last:border-b-0',
        isCompact ? 'py-2 px-3' : 'py-3 px-4',
        selected ? 'bg-sky-500/8' : 'hover:bg-white/[0.025]',
        focused ? 'bg-white/[0.03]' : '',
        isPulse ? 'pulse-red' : '',
        'signal-row',
      ].filter(Boolean).join(' ')}
      style={{
        borderLeftColor: accent,
        borderLeftWidth: '2px',
        borderLeftStyle: 'solid',
        transition: 'background 0.1s',
      }}
      data-signal-id={signal.id}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        {selectable && (
          <button
            onClick={(e) => { stop(e); onSelect?.(signal.id, e) }}
            className="mt-0.5 w-3.5 h-3.5 rounded-[2px] border border-white/20 hover:border-sky-400 flex items-center justify-center shrink-0"
            style={{ background: selected ? '#0ea5e9' : 'transparent', transition: 'border-color 0.1s, background 0.1s' }}
            aria-label="Select signal"
          >
            {selected && <span className="text-[8px] font-bold text-white leading-none">✓</span>}
          </button>
        )}

        {/* Type icon — small, no background box */}
        <div className="shrink-0 mt-0.5">
          <Icon className={`${isCompact ? 'w-3 h-3' : 'w-3.5 h-3.5'} ${meta.color}`} />
        </div>

        {/* Main content */}
        <Link href={`/signals/${signal.id}`} className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            {/* Ticker */}
            <span className="ticker-chip">{signal.ticker}</span>

            {pinned && <Pin className="w-2.5 h-2.5 text-yellow-400 fill-yellow-400" />}

            {/* Signal type — uppercase label, no badge */}
            <span className={`text-[10px] font-semibold tracking-wider ${meta.color} opacity-80`}>
              {meta.label}
            </span>

            {/* Severity — plain number, colored */}
            <span className={`text-[10px] font-bold tabular-nums ml-auto ${severityLabel(signal.severity)}`}>
              {Number(signal.severity).toFixed(1)}
            </span>

            {/* Time */}
            <span className="text-[10px] text-slate-600 tabular-nums">{timeAgo(signal.created_at)}</span>

            {/* Unread dot */}
            {!signal.read && (
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
            )}
          </div>

          {/* Title */}
          <p className={`${isCompact ? 'text-[11px]' : 'text-xs'} font-medium text-slate-200 leading-snug ${isCompact ? '' : 'mb-0.5'}`}>
            {signal.title}
          </p>

          {/* Body */}
          {!isCompact && (
            <p className={`text-[11px] text-slate-500 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
              {signal.body}
            </p>
          )}
        </Link>

        {/* Actions — only visible on hover */}
        <div className="flex items-center gap-0 shrink-0 opacity-0 group-hover:opacity-100" style={{ transition: 'opacity 0.1s' }}>
          {onToggleExpand && !isCompact && (
            <button
              onClick={(e) => { stop(e); onToggleExpand(signal.id) }}
              className="min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-600 hover:text-white"
              style={{ transition: 'color 0.1s' }}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
          {onTogglePin && (
            <button
              onClick={(e) => { stop(e); onTogglePin(signal.ticker) }}
              className="min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-600 hover:text-yellow-400"
              style={{ transition: 'color 0.1s' }}
              aria-label={pinned ? 'Unpin' : 'Pin'}
            >
              {pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
            </button>
          )}
          {onMuteTicker && (
            <button
              onClick={(e) => { stop(e); onMuteTicker(signal.ticker) }}
              className="min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-600 hover:text-red-400"
              style={{ transition: 'color 0.1s' }}
              aria-label="Mute ticker"
            >
              <VolumeX className="w-3.5 h-3.5" />
            </button>
          )}
          <Link
            href={`/signals/${signal.id}`}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-600 hover:text-white"
            style={{ transition: 'color 0.1s' }}
            aria-label="Open"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </div>
  )
}
