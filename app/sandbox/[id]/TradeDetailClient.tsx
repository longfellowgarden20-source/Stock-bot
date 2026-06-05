'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, TrendingUp, TrendingDown, Loader2, AlertTriangle,
  Brain, Target, Shield, Zap, Activity, BookOpen, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Clock
} from 'lucide-react'

type SandboxTrade = {
  id: string
  ticker: string
  direction: 'long' | 'short'
  trade_type: 'day' | 'swing'
  status: 'open' | 'closed'
  entry_price: number
  exit_price: number | null
  stop_loss: number
  target_price: number
  shares: number
  entry_date: string
  exit_date: string | null
  pnl: number | null
  pnl_pct: number | null
  exit_reason: string | null
  groq_thesis: string | null
  groq_exit_note: string | null
  signals_at_entry?: Array<{ type: string; sev: number; title: string }> | null
}

type PnlPoint = { time: string; price: number; pnl_pct: number; pnl_dollar: number }

type AnalysisResult = {
  analysis: string
  pnl_curve: PnlPoint[]
  trade: SandboxTrade
}

const SECTION_CONFIG: Record<string, { color: string; bg: string; border: string; icon: React.ReactNode }> = {
  'TRADE QUALITY':   { color: 'text-sky-400',     bg: 'bg-sky-500/8',     border: 'border-sky-500/20',     icon: <Activity className="w-3.5 h-3.5" /> },
  'WHAT WENT RIGHT': { color: 'text-emerald-400',  bg: 'bg-emerald-500/8', border: 'border-emerald-500/20', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
  'WHAT WENT WRONG': { color: 'text-red-400',      bg: 'bg-red-500/8',     border: 'border-red-500/20',     icon: <XCircle className="w-3.5 h-3.5" /> },
  'P&L ANALYSIS':    { color: 'text-yellow-400',   bg: 'bg-yellow-500/8',  border: 'border-yellow-500/20',  icon: <TrendingUp className="w-3.5 h-3.5" /> },
  'KEY LESSON':      { color: 'text-purple-400',   bg: 'bg-purple-500/8',  border: 'border-purple-500/20',  icon: <Brain className="w-3.5 h-3.5" /> },
  'NEXT SETUP':      { color: 'text-white',        bg: 'bg-white/4',       border: 'border-white/10',       icon: <Target className="w-3.5 h-3.5" /> },
}

function parseAnalysis(text: string): Array<{ header: string; body: string }> {
  const regex = /\*\*([\w&'/\s]+?)\*\*\s*:/g
  const matches: Array<{ index: number; header: string; len: number }> = []
  let m
  while ((m = regex.exec(text)) !== null) {
    matches.push({ index: m.index, header: m[1].trim().toUpperCase(), len: m[0].length })
  }
  if (matches.length < 2) {
    return text.split(/\n{2,}/).filter(Boolean).map(p => ({ header: '', body: p.replace(/\*\*/g, '').trim() }))
  }
  return matches.map((match, i) => {
    const start = match.index + match.len
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    return { header: match.header, body: text.slice(start, end).replace(/\*\*/g, '').trim() }
  })
}

function pnlColor(v: number | null) {
  if (v == null) return 'text-slate-500'
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400'
}

function MiniPnlChart({ curve, entry, stop, target, direction }: {
  curve: PnlPoint[]
  entry: number
  stop: number
  target: number
  direction: 'long' | 'short'
}) {
  if (curve.length < 2) {
    return (
      <div className="h-32 flex items-center justify-center text-xs text-slate-600">
        Not enough price data to draw chart
      </div>
    )
  }

  const pcts = curve.map(p => p.pnl_pct)
  const prices = curve.map(p => p.price)
  const minPct = Math.min(...pcts, -2)
  const maxPct = Math.max(...pcts, 2)
  const range = maxPct - minPct || 1

  const W = 600
  const H = 140
  const PAD = { top: 12, bottom: 24, left: 40, right: 12 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const toX = (i: number) => PAD.left + (i / (curve.length - 1)) * chartW
  const toY = (pct: number) => PAD.top + chartH - ((pct - minPct) / range) * chartH

  // Polyline points
  const points = curve.map((p, i) => `${toX(i)},${toY(p.pnl_pct)}`).join(' ')

  // Zero line Y
  const zeroY = toY(0)

  // Stop and target as pct from entry
  const stopPct = direction === 'long'
    ? (stop - entry) / entry * 100
    : (entry - stop) / entry * 100
  const targetPct = direction === 'long'
    ? (target - entry) / entry * 100
    : (entry - target) / entry * 100

  const stopY = toY(Math.max(minPct, Math.min(maxPct, stopPct)))
  const targetY = toY(Math.max(minPct, Math.min(maxPct, targetPct)))

  const lastPct = pcts[pcts.length - 1]
  const isWinning = lastPct > 0

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 280 }}>
        {/* Grid lines */}
        {[-4, -2, 0, 2, 4].map(pct => {
          const y = toY(pct)
          if (y < PAD.top || y > H - PAD.bottom) return null
          return (
            <g key={pct}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
              <text x={PAD.left - 4} y={y + 4} textAnchor="end" fontSize="9" fill="#475569">{pct > 0 ? `+${pct}` : pct}%</text>
            </g>
          )
        })}

        {/* Stop line */}
        {stopY > PAD.top && stopY < H - PAD.bottom && (
          <line x1={PAD.left} y1={stopY} x2={W - PAD.right} y2={stopY} stroke="#ef4444" strokeWidth="1" strokeDasharray="4 3" opacity="0.6" />
        )}

        {/* Target line */}
        {targetY > PAD.top && targetY < H - PAD.bottom && (
          <line x1={PAD.left} y1={targetY} x2={W - PAD.right} y2={targetY} stroke="#10b981" strokeWidth="1" strokeDasharray="4 3" opacity="0.6" />
        )}

        {/* Zero line */}
        <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />

        {/* Fill area */}
        <polygon
          points={`${toX(0)},${zeroY} ${points} ${toX(curve.length - 1)},${zeroY}`}
          fill={isWinning ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)'}
        />

        {/* Line */}
        <polyline
          points={points}
          fill="none"
          stroke={isWinning ? '#10b981' : '#ef4444'}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Current/final dot */}
        <circle
          cx={toX(curve.length - 1)}
          cy={toY(lastPct)}
          r="4"
          fill={isWinning ? '#10b981' : '#ef4444'}
        />

        {/* X axis labels */}
        {[0, Math.floor(curve.length / 2), curve.length - 1].map(i => {
          if (i >= curve.length) return null
          const d = new Date(curve[i].time)
          const label = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
          return (
            <text key={i} x={toX(i)} y={H - 4} textAnchor="middle" fontSize="8" fill="#475569">{label}</text>
          )
        })}
      </svg>

      {/* Legend */}
      <div className="flex gap-4 mt-1 text-[10px] text-slate-600">
        <span className="flex items-center gap-1"><span className="w-6 border-t border-dashed border-red-500/60" />Stop ${stop.toFixed(2)}</span>
        <span className="flex items-center gap-1"><span className="w-6 border-t border-dashed border-emerald-500/60" />Target ${target.toFixed(2)}</span>
        <span className="flex items-center gap-1"><span className="w-6 border-t border-white/20" />Break even</span>
      </div>
    </div>
  )
}

function exitReasonLabel(r: string | null) {
  if (!r) return null
  return { target_hit: '🎯 Target hit', stop_hit: '🛑 Stop hit', groq_exit: '🤖 Groq exited', day_close: '📅 EOD close', max_hold: '⏰ Max hold' }[r] ?? r
}

export default function TradeDetailClient({ trade }: { trade: SandboxTrade }) {
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedSection, setExpandedSection] = useState<string | null>(null)

  const isOpen = trade.status === 'open'
  const isWin = (trade.pnl ?? 0) > 0

  async function runAnalysis() {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/sandbox/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: trade.id }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analysis')
    } finally {
      setLoading(false)
    }
  }

  // Auto-run on mount
  useEffect(() => { runAnalysis() }, [])

  const sections = result ? parseAnalysis(result.analysis) : []
  const curve = result?.pnl_curve ?? []
  const maxPnl = curve.length > 0 ? Math.max(...curve.map(p => p.pnl_pct)) : null
  const minPnl = curve.length > 0 ? Math.min(...curve.map(p => p.pnl_pct)) : null
  const finalPnl = curve.length > 0 ? curve[curve.length - 1] : null

  // R:R calc
  const entry = Number(trade.entry_price)
  const stop = Number(trade.stop_loss)
  const target = Number(trade.target_price)
  const risk = trade.direction === 'long' ? entry - stop : stop - entry
  const reward = trade.direction === 'long' ? target - entry : entry - target
  const rr = risk > 0 ? (reward / risk).toFixed(2) : null

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-5">
      {/* Back */}
      <Link href="/sandbox" className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-white w-fit" style={{ transition: 'color 0.1s' }}>
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Sandbox
      </Link>

      {/* Trade header */}
      <div className="border border-white/[0.07] rounded-xl p-4 flex flex-col gap-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <div className="flex items-center gap-3 flex-wrap">
          {trade.direction === 'long'
            ? <TrendingUp className="w-5 h-5 text-emerald-400 shrink-0" />
            : <TrendingDown className="w-5 h-5 text-red-400 shrink-0" />}

          <span className="font-bold text-xl text-white font-mono">{trade.ticker}</span>

          <span className={`text-xs font-bold px-2 py-0.5 rounded border ${trade.direction === 'long' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : 'text-red-400 border-red-500/25 bg-red-500/8'}`}>
            {trade.direction.toUpperCase()}
          </span>
          <span className="text-xs border border-white/[0.08] px-2 py-0.5 rounded text-slate-400">{trade.trade_type}</span>

          {isOpen
            ? <span className="text-xs text-sky-400 border border-sky-500/20 bg-sky-500/8 px-2 py-0.5 rounded animate-pulse">LIVE</span>
            : isWin
              ? <span className="flex items-center gap-1 text-xs font-bold text-emerald-400 border border-emerald-500/25 bg-emerald-500/8 px-2 py-0.5 rounded"><CheckCircle2 className="w-3 h-3" /> WIN</span>
              : <span className="flex items-center gap-1 text-xs font-bold text-red-400 border border-red-500/25 bg-red-500/8 px-2 py-0.5 rounded"><XCircle className="w-3 h-3" /> LOSS</span>
          }

          {/* Final P&L */}
          {trade.pnl_pct != null && (
            <span className={`text-lg font-bold tabular-nums ml-auto ${pnlColor(trade.pnl_pct)}`}>
              {trade.pnl_pct >= 0 ? '+' : ''}{trade.pnl_pct.toFixed(2)}%
            </span>
          )}
          {trade.pnl != null && (
            <span className={`text-sm tabular-nums ${pnlColor(trade.pnl)}`}>
              ${trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)}
            </span>
          )}
        </div>

        {/* Key levels grid */}
        <div className="grid grid-cols-3 gap-2 text-xs tabular-nums">
          <div className="bg-red-500/8 border border-red-500/15 rounded-lg p-2.5 text-center">
            <p className="text-[10px] text-slate-500 mb-0.5 uppercase tracking-wider">Stop</p>
            <p className="font-bold text-red-400">${stop.toFixed(2)}</p>
          </div>
          <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-2.5 text-center">
            <p className="text-[10px] text-slate-500 mb-0.5 uppercase tracking-wider">Entry</p>
            <p className="font-bold text-white">${entry.toFixed(2)}</p>
            {trade.exit_price && <p className="text-[10px] text-slate-500 mt-0.5">exit ${Number(trade.exit_price).toFixed(2)}</p>}
          </div>
          <div className="bg-emerald-500/8 border border-emerald-500/15 rounded-lg p-2.5 text-center">
            <p className="text-[10px] text-slate-500 mb-0.5 uppercase tracking-wider">Target</p>
            <p className="font-bold text-emerald-400">${target.toFixed(2)}</p>
          </div>
        </div>

        {/* Meta row */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>Entered {trade.entry_date}</span>
          {trade.exit_date && <span>Closed {trade.exit_date}</span>}
          {rr && <span>R:R <span className="text-white font-semibold">{rr}:1</span></span>}
          <span>{trade.shares} shares</span>
          {trade.exit_reason && <span>{exitReasonLabel(trade.exit_reason)}</span>}
        </div>

        {/* Original thesis */}
        {trade.groq_thesis && (
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1"><Brain className="w-3 h-3" /> Original thesis</p>
            <p className="text-xs text-slate-300 leading-relaxed">{trade.groq_thesis}</p>
          </div>
        )}
      </div>

      {/* P&L chart */}
      {(result || loading) && (
        <div className="border border-white/[0.07] rounded-xl p-4 flex flex-col gap-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-sky-400" /> P&L Journey
            </p>
            {curve.length > 0 && (
              <div className="flex gap-4 text-xs tabular-nums">
                {maxPnl != null && <span className="text-emerald-400">Peak +{maxPnl.toFixed(2)}%</span>}
                {minPnl != null && <span className="text-red-400">Low {minPnl.toFixed(2)}%</span>}
                {finalPnl && (
                  <span className={`font-bold ${pnlColor(finalPnl.pnl_pct)}`}>
                    Final {finalPnl.pnl_pct >= 0 ? '+' : ''}{finalPnl.pnl_pct.toFixed(2)}%
                  </span>
                )}
              </div>
            )}
          </div>

          {loading && curve.length === 0 ? (
            <div className="h-32 flex items-center justify-center gap-2 text-xs text-slate-600">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading price history…
            </div>
          ) : (
            <MiniPnlChart
              curve={curve}
              entry={entry}
              stop={stop}
              target={target}
              direction={trade.direction}
            />
          )}
        </div>
      )}

      {/* Deep analysis */}
      <div className="border border-white/[0.07] rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.01)' }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.07] bg-white/[0.02]">
          <Brain className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-sm font-semibold text-white">Trade Review</span>
          {loading && <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin ml-auto" />}
        </div>

        <div className="p-4 flex flex-col gap-3">
          {loading && sections.length === 0 && (
            <div className="flex flex-col gap-4">
              {[3, 3, 3, 3, 2, 2].map((lines, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <div className="h-3 w-32 rounded bg-white/8 animate-pulse" />
                  {Array.from({ length: lines }).map((_, j) => (
                    <div key={j} className="h-3 rounded bg-white/5 animate-pulse" style={{ width: j === lines - 1 ? '60%' : '100%' }} />
                  ))}
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-red-500/10 border border-red-500/25 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span className="text-sm text-red-400">{error}</span>
              <button onClick={runAnalysis} className="ml-auto text-xs text-slate-400 hover:text-white underline">Retry</button>
            </div>
          )}

          {sections.map((section, i) => {
            const cfg = section.header ? SECTION_CONFIG[section.header] : null
            const key = section.header || `p${i}`
            const isExpanded = expandedSection === key || !section.header

            if (!section.header) {
              return <p key={i} className="text-sm text-slate-300 leading-relaxed">{section.body}</p>
            }

            return (
              <div key={i} className={`border rounded-xl overflow-hidden ${cfg?.border ?? 'border-white/[0.07]'}`}>
                <button
                  className={`w-full flex items-center gap-2.5 px-4 py-3 text-left ${cfg?.bg ?? 'bg-white/[0.02]'}`}
                  onClick={() => setExpandedSection(isExpanded ? null : key)}
                >
                  <span className={cfg?.color ?? 'text-slate-400'}>{cfg?.icon}</span>
                  <span className={`text-xs font-bold uppercase tracking-widest flex-1 ${cfg?.color ?? 'text-slate-400'}`}>
                    {cfg ? Object.keys(SECTION_CONFIG).find(k => k === section.header) ?? section.header : section.header}
                  </span>
                  {isExpanded
                    ? <ChevronUp className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                    : <ChevronDown className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
                </button>
                {isExpanded && (
                  <div className="px-4 py-3 border-t border-white/[0.05]">
                    <p className="text-sm text-slate-200 leading-relaxed">{section.body}</p>
                  </div>
                )}
                {!isExpanded && (
                  <div className="px-4 py-2 border-t border-white/[0.04]">
                    <p className="text-xs text-slate-600 line-clamp-1">{section.body}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {result && (
          <div className="px-4 py-2.5 border-t border-white/[0.05] flex items-center gap-1.5 bg-white/[0.01]">
            <span className="text-[10px] text-slate-600">Powered by</span>
            <span className="text-[10px] text-sky-500 font-semibold">Groq AI</span>
            <span className="text-[10px] text-slate-600">· llama-3.3-70b-versatile</span>
          </div>
        )}
      </div>

      {/* Signals at entry */}
      {trade.signals_at_entry && trade.signals_at_entry.length > 0 && (
        <div className="border border-white/[0.07] rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.07] bg-white/[0.02]">
            <Zap className="w-3.5 h-3.5 text-yellow-400" />
            <span className="text-sm font-semibold text-white">Signals at Entry</span>
          </div>
          <div className="p-4 flex flex-col gap-2">
            {trade.signals_at_entry.map((s, i) => (
              <div key={i} className="flex items-center gap-3 text-xs py-1.5 border-b border-white/[0.04] last:border-0">
                <span className={`font-bold tabular-nums w-6 ${s.sev >= 8 ? 'text-red-400' : s.sev >= 6 ? 'text-orange-400' : 'text-yellow-400'}`}>{s.sev}</span>
                <span className="text-slate-500 w-24 shrink-0 uppercase text-[10px] tracking-wide">{s.type.replace(/_/g, ' ')}</span>
                <span className="text-slate-300 truncate">{s.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
