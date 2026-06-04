import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import Link from 'next/link'
import { ArrowLeft, Zap, ChevronDown } from 'lucide-react'
import RRCalculator from './RRCalculator'
import TradingViewChart from './TradingViewChart'
import AnalysisPanel from './AnalysisPanel'

export const dynamic = 'force-dynamic'

function severityColors(severity: number) {
  if (severity >= 9) return 'text-red-400 bg-red-500/10 border-red-500/30'
  if (severity >= 7) return 'text-orange-400 bg-orange-500/10 border-orange-500/30'
  if (severity >= 5) return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30'
  return 'text-slate-400 bg-slate-500/10 border-slate-500/30'
}

function severityDot(severity: number) {
  if (severity >= 9) return 'bg-red-400'
  if (severity >= 7) return 'bg-orange-400'
  if (severity >= 5) return 'bg-yellow-400'
  return 'bg-slate-400'
}

export default async function SignalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: signal } = await supabase.from('signals').select('*').eq('id', id).single()
  if (!signal) notFound()

  // Mark as read — run in background, don't await (avoids stale read=false in render)
  supabase.from('signals').update({ read: true }).eq('id', id).then(() => {})
  // Treat signal as read for this render
  const displaySignal = { ...signal, read: true }

  // Get other recent signals for same ticker
  const { data: related } = await supabase
    .from('signals')
    .select('*')
    .eq('ticker', signal.ticker)
    .neq('id', id)
    .order('created_at', { ascending: false })
    .limit(6)

  const createdAt = new Date(displaySignal.created_at)
  const timeStr = createdAt.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }) + ' ET'

  const signalTypeLabel = signal.signal_type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c: string) => c.toUpperCase())

  return (
    <AppShell>
      <div className="flex flex-col gap-5 max-w-[1100px]">

        {/* Header row */}
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href="/dashboard"
            className="p-3 rounded-xl text-slate-400 hover:text-white hover:bg-white/8 border border-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea5e9]/60"
            style={{ transitionProperty: 'color, background', transitionDuration: '0.15s' }}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <h1 className="text-2xl font-bold text-white font-mono tracking-tight">{signal.ticker}</h1>
          <span className={`px-3 py-1 rounded-full text-xs font-bold border ${severityColors(signal.severity)}`}>
            Severity {signal.severity}/10
          </span>
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-white/5 border border-white/10 text-slate-300">
            {signalTypeLabel}
          </span>
          {!signal.read && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 text-[#0ea5e9]">
              UNREAD
            </span>
          )}
        </div>

        {/* Signal title + body summary */}
        <div className="bg-white/4 border border-white/10 rounded-2xl px-5 py-4">
          <h2 className="text-base font-bold text-white leading-snug mb-1">{signal.title}</h2>
          <p className="text-sm text-slate-400 leading-relaxed">{signal.body}</p>
        </div>

        {/* TradingView Chart */}
        <div className="bg-white/4 border border-white/10 rounded-2xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-white/8 flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">Chart</span>
            <span className="text-xs font-mono text-[#0ea5e9]">{signal.ticker}</span>
          </div>
          <TradingViewChart ticker={signal.ticker} />
        </div>

        {/* Two-column layout */}
        <div className="flex flex-col lg:flex-row gap-5 items-start">

          {/* Left column — analysis + sources + related */}
          <div className="flex-1 min-w-0 flex flex-col gap-5">
            <AnalysisPanel signalId={id} />

            {/* Related signals */}
            {related && related.length > 0 && (
              <div className="flex flex-col gap-3">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5" /> Other signals for {signal.ticker}
                </p>
                {related.map(s => (
                  <Link
                    key={s.id}
                    href={`/signals/${s.id}`}
                    className="flex items-start gap-3 px-4 py-3 bg-white/3 border border-white/8 rounded-xl hover:border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea5e9]/50"
                    style={{ transitionProperty: 'border-color', transitionDuration: '0.15s' }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{s.title}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {s.signal_type.replace(/_/g, ' ')} · {new Date(s.created_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${s.severity >= 9 ? 'bg-red-500/20 text-red-400' : s.severity >= 7 ? 'bg-orange-500/20 text-orange-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                      {s.severity}/10
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Right column — metadata + RR calc + raw data */}
          <div className="w-full lg:w-72 shrink-0 flex flex-col gap-5">

            {/* Signal metadata card */}
            <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Signal Details</p>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">Ticker</span>
                  <span className="text-xs font-mono font-bold text-white">{signal.ticker}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">Type</span>
                  <span className="text-xs font-semibold text-slate-300">{signalTypeLabel}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">Severity</span>
                  <span className="flex items-center gap-1.5">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${severityDot(signal.severity)}`} />
                    <span className={`text-xs font-bold ${signal.severity >= 9 ? 'text-red-400' : signal.severity >= 7 ? 'text-orange-400' : signal.severity >= 5 ? 'text-yellow-400' : 'text-slate-400'}`}>
                      {signal.severity}/10
                    </span>
                  </span>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs text-slate-500 shrink-0">Time</span>
                  <span className="text-xs text-slate-300 text-right">{timeStr}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">Status</span>
                  <span className={`text-xs font-semibold ${signal.read ? 'text-slate-500' : 'text-[#0ea5e9]'}`}>
                    {signal.read ? 'Read' : 'Unread'}
                  </span>
                </div>
              </div>
            </div>

            {/* R:R Calculator */}
            <RRCalculator />

            {/* Raw Data — collapsed by default */}
            {signal.raw_data && (
              <details className="bg-white/4 border border-white/10 rounded-2xl overflow-hidden group">
                <summary className="flex items-center justify-between gap-2 px-5 py-3 cursor-pointer select-none list-none hover:bg-white/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea5e9]/50"
                  style={{ transitionProperty: 'background', transitionDuration: '0.15s' }}>
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Raw Data</span>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-500 group-open:rotate-180"
                    style={{ transitionProperty: 'transform', transitionDuration: '0.2s' }} />
                </summary>
                <div className="px-4 pb-4 pt-1">
                  <pre className="text-[11px] text-slate-400 bg-black/30 rounded-xl p-3 overflow-x-auto leading-relaxed">
                    {JSON.stringify(signal.raw_data, null, 2)}
                  </pre>
                </div>
              </details>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
