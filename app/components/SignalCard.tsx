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

const TYPE_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  price_move:       { label: 'Price Move',         icon: TrendingUp,     color: 'text-[#0ea5e9]' },
  volume_spike:     { label: 'Volume Spike',       icon: BarChart2,      color: 'text-purple-400' },
  options_unusual:  { label: 'Unusual Options',    icon: Zap,            color: 'text-yellow-400' },
  dark_pool:        { label: 'Dark Pool',          icon: DollarSign,     color: 'text-orange-400' },
  insider_buy:      { label: 'Insider Buy',        icon: TrendingUp,     color: 'text-green-400' },
  insider_sell:     { label: 'Insider Sell',       icon: TrendingDown,   color: 'text-red-400' },
  news_breaking:    { label: 'Breaking News',      icon: Newspaper,      color: 'text-[#0ea5e9]' },
  sec_filing:       { label: 'SEC Filing',         icon: FileText,       color: 'text-slate-300' },
  sentiment_spike:  { label: 'Sentiment Spike',    icon: MessageSquare,  color: 'text-pink-400' },
  short_squeeze:    { label: 'Short Squeeze',      icon: AlertTriangle,  color: 'text-orange-400' },
  earnings_upcoming:{ label: 'Earnings',           icon: Calendar,       color: 'text-yellow-400' },
  analyst_change:   { label: 'Analyst Change',     icon: Users,          color: 'text-[#0ea5e9]' },
  congress_trade:   { label: 'Congress Trade',     icon: DollarSign,     color: 'text-green-400' },
  technical:        { label: 'Technical',          icon: Activity,       color: 'text-cyan-400' },
  macro:            { label: 'Macro',              icon: Globe,          color: 'text-indigo-400' },
  convergence:      { label: 'Convergence',        icon: Layers,         color: 'text-red-400' },
}

export function getTypeMeta(t: string) {
  return TYPE_META[t] ?? { label: t.replace(/_/g, ' '), icon: Zap, color: 'text-slate-400' }
}

function severityBorder(s: number) {
  if (s >= 9) return 'border-red-500/40 bg-red-500/5'
  if (s >= 7) return 'border-orange-500/40 bg-orange-500/5'
  if (s >= 5) return 'border-yellow-500/30 bg-yellow-500/5'
  return 'border-white/10 bg-white/3'
}

function severityBadge(s: number) {
  if (s >= 9) return 'bg-red-500/20 text-red-400'
  if (s >= 7) return 'bg-orange-500/20 text-orange-400'
  if (s >= 5) return 'bg-yellow-500/20 text-yellow-400'
  return 'bg-slate-500/20 text-slate-400'
}

export function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
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

  const wrapperCls = [
    'group relative block border rounded-2xl',
    isCompact ? 'p-2.5' : 'p-4',
    severityBorder(signal.severity),
    isPulse ? 'pulse-red' : '',
    selected ? 'ring-2 ring-[#0ea5e9]/60' : '',
    focused ? 'ring-2 ring-white/40' : '',
    'hover:brightness-110',
  ].filter(Boolean).join(' ')

  const stop = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className={wrapperCls} style={{ transition: 'filter 0.15s' }} data-signal-id={signal.id}>
      <div className="flex items-start gap-3">
        {selectable && (
          <button
            onClick={(e) => { stop(e); onSelect?.(signal.id, e) }}
            className="mt-1 w-4 h-4 rounded border border-white/20 hover:border-[#0ea5e9] flex items-center justify-center shrink-0"
            style={{ transition: 'border-color 0.15s, background 0.15s', background: selected ? '#0ea5e9' : 'transparent' }}
            aria-label="Select signal"
          >
            {selected && <span className="text-[10px] font-bold text-white leading-none">✓</span>}
          </button>
        )}

        <div className={`${isCompact ? 'w-7 h-7' : 'w-9 h-9'} rounded-xl flex items-center justify-center shrink-0 bg-white/5 border border-white/10`}>
          <Icon className={`${isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'} ${meta.color}`} />
        </div>

        <Link href={`/signals/${signal.id}`} className="flex-1 min-w-0">
          <div className={`flex items-center gap-2 flex-wrap ${isCompact ? '' : 'mb-1'}`}>
            <span className="text-sm font-bold text-white font-mono">{signal.ticker}</span>
            {pinned && <Pin className="w-3 h-3 text-yellow-400 fill-yellow-400" />}
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${severityBadge(signal.severity)}`}>
              {signal.severity}/10
            </span>
            <span className="text-xs text-slate-500">{meta.label}</span>
            <span className="text-xs text-slate-600 ml-auto shrink-0">{timeAgo(signal.created_at)}</span>
            {!signal.read && <span className="w-2 h-2 rounded-full bg-[#0ea5e9] shrink-0" />}
          </div>
          <p className={`${isCompact ? 'text-xs' : 'text-sm'} font-semibold text-slate-100 ${isCompact ? '' : 'mb-1'} leading-snug`}>{signal.title}</p>
          {!isCompact && (
            <p className={`text-xs text-slate-400 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>{signal.body}</p>
          )}
        </Link>

        <div className="flex flex-col gap-1 shrink-0">
          {onToggleExpand && !isCompact && (
            <button
              onClick={(e) => { stop(e); onToggleExpand(signal.id) }}
              className="p-1 rounded-lg text-slate-600 hover:text-white hover:bg-white/5 opacity-0 group-hover:opacity-100"
              style={{ transition: 'opacity 0.15s, color 0.15s' }}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
          {onTogglePin && (
            <button
              onClick={(e) => { stop(e); onTogglePin(signal.ticker) }}
              className="p-1 rounded-lg text-slate-600 hover:text-yellow-400 hover:bg-white/5 opacity-0 group-hover:opacity-100"
              style={{ transition: 'opacity 0.15s, color 0.15s' }}
              aria-label={pinned ? 'Unpin' : 'Pin'}
              title={pinned ? 'Unpin ticker' : 'Pin ticker'}
            >
              {pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
            </button>
          )}
          {onMuteTicker && (
            <button
              onClick={(e) => { stop(e); onMuteTicker(signal.ticker) }}
              className="p-1 rounded-lg text-slate-600 hover:text-red-400 hover:bg-white/5 opacity-0 group-hover:opacity-100"
              style={{ transition: 'opacity 0.15s, color 0.15s' }}
              aria-label="Mute ticker"
              title="Mute ticker"
            >
              <VolumeX className="w-3.5 h-3.5" />
            </button>
          )}
          <Link
            href={`/signals/${signal.id}`}
            className="p-1 rounded-lg text-slate-600 hover:text-white"
            style={{ transition: 'color 0.15s' }}
            aria-label="Open"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </div>
  )
}
