import { Zap, TrendingUp, TrendingDown, BarChart2, FileText, Newspaper, MessageSquare, Users, AlertTriangle, DollarSign, Calendar, ArrowUpRight } from 'lucide-react'
import Link from 'next/link'

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
  price_move:       { label: 'Price Move',       icon: TrendingUp,     color: 'text-[#0ea5e9]' },
  volume_spike:     { label: 'Volume Spike',      icon: BarChart2,      color: 'text-purple-400' },
  options_unusual:  { label: 'Unusual Options',   icon: Zap,            color: 'text-yellow-400' },
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

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function SignalCard({ signal }: { signal: Signal }) {
  const meta = TYPE_META[signal.signal_type] ?? { label: signal.signal_type, icon: Zap, color: 'text-slate-400' }
  const Icon = meta.icon
  const isPulse = signal.severity >= 9

  return (
    <Link href={`/signals/${signal.id}`} className={`block border rounded-2xl p-4 ${severityBorder(signal.severity)} ${isPulse ? 'pulse-red' : ''} hover:brightness-110`} style={{ transition: 'filter 0.15s' }}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-white/5 border border-white/10`}>
          <Icon className={`w-4 h-4 ${meta.color}`} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-bold text-white font-mono">{signal.ticker}</span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${severityBadge(signal.severity)}`}>
              {signal.severity}/10
            </span>
            <span className="text-xs text-slate-500">{meta.label}</span>
            {!signal.read && <span className="w-2 h-2 rounded-full bg-[#0ea5e9] ml-auto shrink-0" />}
          </div>
          <p className="text-sm font-semibold text-slate-100 mb-1 leading-snug">{signal.title}</p>
          <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">{signal.body}</p>
          <p className="text-xs text-slate-600 mt-2">{timeAgo(signal.created_at)}</p>
        </div>

        <ArrowUpRight className="w-4 h-4 text-slate-600 shrink-0 mt-1" />
      </div>
    </Link>
  )
}
