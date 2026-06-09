'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@supabase/ssr'
import { FlaskConical, TrendingUp, TrendingDown, Target, AlertTriangle, Clock, BarChart2, Brain, ChevronDown, ChevronUp, CheckCircle2, XCircle, ArrowUpRight, Crosshair, BookOpen, Activity, Zap, Search, Filter, Copy, Check, Trophy, Flame, TrendingUp as TUp } from 'lucide-react'

const MAX_OPEN_POSITIONS = 20

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
  confidence_used?: number | null
  peak_pnl_pct?: number | null
  profit_efficiency?: number | null
  stop_category?: string | null
  account_health?: string | null
  fill_status?: 'filled' | 'pending' | null  // FIX: Added missing field for pending order warning
}

type Performance = {
  date: string
  trades_closed: number
  wins: number
  losses: number
  win_rate: number
  gross_pnl: number
}

function pnlColor(v: number | null) {
  if (v == null) return 'text-slate-500'
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400'
}

function exitReasonLabel(r: string | null) {
  if (!r) return null
  return {
    target_hit: '🎯 Target hit',
    stop_hit: '🛑 Stop hit',
    groq_exit: '🤖 Groq exited',
    day_close: '📅 EOD close',
    max_hold: '⏰ Max hold',
  }[r] ?? r
}

// #20 — Trade quality scorecard: 0–5 points based on setup quality (not outcome)
function computeTradeQuality(trade: SandboxTrade): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0

  const entry = Number(trade.entry_price)
  const stop = Number(trade.stop_loss)
  const target = Number(trade.target_price)
  const risk = trade.direction === 'long' ? entry - stop : stop - entry
  const reward = trade.direction === 'long' ? target - entry : entry - target
  const rr = risk > 0 ? reward / risk : 0

  // +1: R:R >= 2:1
  if (rr >= 2) { score++; reasons.push('R:R ≥ 2:1') }
  else reasons.push('R:R < 2:1')

  // +1: Had 2+ signals with severity >= 7
  const highSevSigs = (trade.signals_at_entry || []).filter(s => s.sev >= 7)
  if (highSevSigs.length >= 2) { score++; reasons.push('2+ high-sev signals') }
  else reasons.push('weak signal support')

  // +1: Stop not too wide (<5%) and not too tight (>1%)
  const stopPct = risk / entry * 100
  if (stopPct >= 1.0 && stopPct <= 5.0) { score++; reasons.push('proper stop width') }
  else reasons.push(stopPct < 1 ? 'stop too tight' : 'stop too wide')

  // +1: Confidence >= 70
  const conf = trade.confidence_used ?? 0
  if (conf >= 70) { score++; reasons.push(`high confidence (${conf})`) }
  else reasons.push(`low confidence (${conf})`)

  // +1: Thesis is specific (> 80 chars = actually wrote something)
  if (trade.groq_thesis && trade.groq_thesis.length > 80) { score++; reasons.push('specific thesis') }
  else reasons.push('vague/missing thesis')

  return { score, reasons }
}

function QualityBadge({ score }: { score: number }) {
  const color = score >= 4 ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8'
    : score >= 3 ? 'text-yellow-400 border-yellow-500/25 bg-yellow-500/8'
    : 'text-red-400 border-red-500/25 bg-red-500/8'
  const label = score >= 4 ? 'A' : score >= 3 ? 'B' : score >= 2 ? 'C' : 'D'
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${color}`} title={`Setup quality: ${score}/5`}>
      {label} {score}/5
    </span>
  )
}

// Feature 2: Personal trade note — persisted in localStorage
function TradeNoteEditor({ tradeId }: { tradeId: string }) {
  const [note, setNote] = useState<string>(() => {
    try { return JSON.parse(localStorage.getItem('sandbox.tradeNotes') ?? '{}')[tradeId] ?? '' } catch { return '' }
  })
  const [saved, setSaved] = useState(false)
  function save() {
    try {
      const all = JSON.parse(localStorage.getItem('sandbox.tradeNotes') ?? '{}')
      all[tradeId] = note
      localStorage.setItem('sandbox.tradeNotes', JSON.stringify(all))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch { /* quota */ }
  }
  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1">
        📝 My Note
      </p>
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        onClick={e => e.stopPropagation()}
        placeholder="Your personal note on this trade…"
        rows={2}
        className="w-full bg-transparent text-xs text-slate-300 placeholder-slate-600 resize-none focus:outline-none"
      />
      <button
        onClick={e => { e.stopPropagation(); save() }}
        className="mt-1 text-[10px] font-semibold text-sky-400 hover:text-sky-300"
        style={{ transition: 'color 0.1s' }}
      >
        {saved ? '✓ Saved' : 'Save note'}
      </button>
    </div>
  )
}

// Fetch latest snapshot price from DB via API
async function fetchLatestPrice(ticker: string): Promise<number | null> {
  try {
    const r = await fetch(`/api/price/${ticker}`)
    if (!r.ok) return null
    const d = await r.json()
    return d.price ?? null
  } catch {
    return null
  }
}

function PriceBar({ entry, stop, target, current, direction }: {
  entry: number; stop: number; target: number; current: number | null; direction: 'long' | 'short'
}) {
  if (!current) return null
  // Map stop→target as 0→100%, show where current price and entry sit
  const range = Math.abs(target - stop)
  if (range === 0) return null

  const toPos = (p: number) => {
    if (direction === 'long') return Math.max(0, Math.min(100, ((p - stop) / range) * 100))
    return Math.max(0, Math.min(100, ((stop - p) / range) * 100))
  }

  const entryPos = toPos(entry)
  const currentPos = toPos(current)
  const isWinning = direction === 'long' ? current > entry : current < entry

  return (
    <div className="mt-2">
      <div className="relative h-2 bg-white/[0.06] rounded-full overflow-visible">
        {/* Fill from entry to current */}
        <div
          className={`absolute top-0 h-full rounded-full ${isWinning ? 'bg-emerald-500/40' : 'bg-red-500/40'}`}
          style={{
            left: `${Math.min(entryPos, currentPos)}%`,
            width: `${Math.abs(currentPos - entryPos)}%`,
          }}
        />
        {/* Stop marker */}
        <div className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 bg-red-500 rounded-sm" style={{ left: '0%', transform: 'translateX(-50%) translateY(-50%)' }} title={`Stop $${stop}`} />
        {/* Target marker */}
        <div className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 bg-emerald-500 rounded-sm" style={{ left: '100%', transform: 'translateX(-50%) translateY(-50%)' }} title={`Target $${target}`} />
        {/* Entry marker */}
        <div className="absolute top-1/2 -translate-y-1/2 w-1 h-4 bg-white/60 rounded-sm" style={{ left: `${entryPos}%`, transform: 'translateX(-50%) translateY(-50%)' }} title={`Entry $${entry}`} />
        {/* Current price marker */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-2 h-4 rounded-sm ${isWinning ? 'bg-emerald-400' : 'bg-red-400'}`}
          style={{ left: `${currentPos}%`, transform: 'translateX(-50%) translateY(-50%)' }}
          title={`Current $${current}`}
        />
      </div>
      <div className="flex justify-between mt-1 text-[10px] text-slate-600 tabular-nums">
        <span className="text-red-500">${Number(stop).toFixed(2)}</span>
        <span className="text-slate-500">entry ${Number(entry).toFixed(2)}</span>
        <span className="text-emerald-500">${Number(target).toFixed(2)}</span>
      </div>
    </div>
  )
}

function TradeRow({ trade, expanded, onToggle, preloadedPrice }: {
  trade: SandboxTrade
  expanded: boolean
  onToggle: () => void
  preloadedPrice?: number | null
}) {
  const isOpen = trade.status === 'open'
  const [livePrice, setLivePrice] = useState<number | null>(preloadedPrice ?? null)
  const [priceLoading, setPriceLoading] = useState(false)

  useEffect(() => {
    if (preloadedPrice != null) {
      setLivePrice(preloadedPrice)
      return
    }
    if (!isOpen || !expanded) return
    setPriceLoading(true)
    fetchLatestPrice(trade.ticker).then(p => {
      setLivePrice(p)
      setPriceLoading(false)
    })
  }, [isOpen, expanded, trade.ticker, preloadedPrice])

  // Compute live P&L for open trades
  const livePnlPct = useMemo(() => {
    if (!isOpen || !livePrice) return null
    const entry = Number(trade.entry_price)
    if (trade.direction === 'long') return (livePrice - entry) / entry * 100
    return (entry - livePrice) / entry * 100
  }, [isOpen, livePrice, trade.entry_price, trade.direction])

  const displayPnlPct = isOpen ? livePnlPct : trade.pnl_pct
  const isWin = isOpen ? (livePnlPct ?? 0) > 0 : (trade.pnl ?? 0) > 0
  const isClosed = !isOpen

  // Border / bg color
  const rowColor = isOpen
    ? 'border-sky-500/15 hover:border-sky-500/25'
    : isWin
      ? 'border-emerald-500/20 hover:border-emerald-500/30'
      : 'border-red-500/20 hover:border-red-500/30'

  return (
    <div
      className={`border rounded-xl overflow-hidden cursor-pointer ${rowColor}`}
      style={{ background: 'rgba(255,255,255,0.02)', transition: 'border-color 0.15s' }}
      onClick={onToggle}
    >
      {/* Main row */}
      <div className="px-4 py-3 flex items-center gap-3">
        {/* Direction icon */}
        {trade.direction === 'long'
          ? <TrendingUp className="w-4 h-4 text-emerald-400 shrink-0" />
          : <TrendingDown className="w-4 h-4 text-red-400 shrink-0" />}

        {/* Ticker */}
        <span className="font-bold text-sm text-white font-mono w-12 shrink-0">{trade.ticker}</span>

        {/* Badges — #17 compact on mobile: only direction + WIN/LOSS shown, rest hidden on xs */}
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${trade.direction === 'long' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : 'text-red-400 border-red-500/25 bg-red-500/8'}`}>
            {trade.direction.toUpperCase()}
          </span>
          <span className="text-[10px] text-slate-500 border border-white/[0.07] px-1.5 py-0.5 rounded hidden sm:inline">
            {trade.trade_type}
          </span>
          {isOpen && (
            <span className="text-[10px] text-sky-400 border border-sky-500/20 bg-sky-500/8 px-1.5 py-0.5 rounded animate-pulse">
              LIVE
            </span>
          )}
          {isClosed && isWin && (
            <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 border border-emerald-500/25 bg-emerald-500/8 px-1.5 py-0.5 rounded">
              <CheckCircle2 className="w-3 h-3" /> WIN
            </span>
          )}
          {isClosed && !isWin && (
            <span className="flex items-center gap-1 text-[10px] font-bold text-red-400 border border-red-500/25 bg-red-500/8 px-1.5 py-0.5 rounded">
              <XCircle className="w-3 h-3" /> LOSS
            </span>
          )}
          {isClosed && <span className="hidden sm:inline"><QualityBadge score={computeTradeQuality(trade).score} /></span>}
        </div>

        {/* Entry date */}
        <span className="text-[11px] text-slate-600 hidden sm:block">{trade.entry_date}</span>

        {/* FIX #12: Pending order warning — show age if pending >20min */}
        {trade.status === 'open' && trade.fill_status === 'pending' && (() => {
          const entryTime = new Date(trade.entry_date)
          const ageMin = Math.round((Date.now() - entryTime.getTime()) / 60000)
          if (ageMin > 20) {
            return <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">
              PENDING {ageMin}m
            </span>
          }
          return null
        })()}

        {/* P&L — right side */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {displayPnlPct != null ? (
            <span className={`text-sm font-bold tabular-nums ${pnlColor(displayPnlPct)}`}>
              {displayPnlPct >= 0 ? '+' : ''}{displayPnlPct.toFixed(2)}%
            </span>
          ) : (
            <span className="text-xs text-slate-600 animate-pulse">fetching…</span>
          )}
          {isClosed && trade.pnl != null && (
            <span className={`text-xs tabular-nums ${pnlColor(trade.pnl)}`}>
              ${trade.pnl >= 0 ? '+' : ''}{trade.pnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          )}
          {isOpen && livePrice != null && trade.pnl == null && (() => {
            const entry = Number(trade.entry_price)
            const dollarPnl = trade.direction === 'long'
              ? (livePrice - entry) * Number(trade.shares || 1)
              : (entry - livePrice) * Number(trade.shares || 1)
            return (
              <span className={`text-xs tabular-nums ${pnlColor(dollarPnl)}`}>
                ${dollarPnl >= 0 ? '+' : ''}{dollarPnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </span>
            )
          })()}
          {trade.exit_reason && (
            <span className="text-[10px] text-slate-500 hidden sm:block">{exitReasonLabel(trade.exit_reason)}</span>
          )}
          {expanded
            ? <ChevronUp className="w-3.5 h-3.5 text-slate-600" />
            : <ChevronDown className="w-3.5 h-3.5 text-slate-600" />}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-white/[0.05] pt-3 flex flex-col gap-3">

          {/* Price bar — visual stop/target/current */}
          <PriceBar
            entry={Number(trade.entry_price)}
            stop={Number(trade.stop_loss)}
            target={Number(trade.target_price)}
            current={isOpen ? livePrice : trade.exit_price}
            direction={trade.direction}
          />

          {/* Key levels */}
          <div className="grid grid-cols-3 gap-2 text-xs tabular-nums">
            <div className="bg-red-500/8 border border-red-500/15 rounded-lg p-2.5 text-center">
              <p className="text-[10px] text-slate-500 mb-0.5">STOP</p>
              <p className="font-bold text-red-400">${Number(trade.stop_loss).toFixed(2)}</p>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-2.5 text-center">
              <p className="text-[10px] text-slate-500 mb-0.5">ENTRY</p>
              <p className="font-bold text-white">${Number(trade.entry_price).toFixed(2)}</p>
              {isOpen && livePrice && !priceLoading && (
                <p className={`text-[10px] mt-0.5 ${pnlColor(livePnlPct)}`}>
                  now ${livePrice.toFixed(2)}
                </p>
              )}
              {isOpen && priceLoading && <p className="text-[10px] text-slate-600 mt-0.5">loading…</p>}
              {isClosed && trade.exit_price && (
                <p className="text-[10px] text-slate-500 mt-0.5">exit ${Number(trade.exit_price).toFixed(2)}</p>
              )}
            </div>
            <div className="bg-emerald-500/8 border border-emerald-500/15 rounded-lg p-2.5 text-center">
              <p className="text-[10px] text-slate-500 mb-0.5">TARGET</p>
              <p className="font-bold text-emerald-400">${Number(trade.target_price).toFixed(2)}</p>
            </div>
          </div>

          {/* R:R */}
          {(() => {
            const entry = Number(trade.entry_price)
            const stop = Number(trade.stop_loss)
            const target = Number(trade.target_price)
            const risk = trade.direction === 'long' ? entry - stop : stop - entry
            const reward = trade.direction === 'long' ? target - entry : entry - target
            const rr = risk > 0 ? (reward / risk).toFixed(2) : null
            return rr ? (
              <p className="text-xs text-slate-500">
                R:R <span className="text-white font-semibold">{rr}:1</span>
                <span className="ml-2">· {trade.shares} shares · entry ${Number(trade.entry_price).toFixed(2)}</span>
              </p>
            ) : null
          })()}

          {/* View Trade button */}
          <Link
            href={`/sandbox/${trade.id}`}
            onClick={e => e.stopPropagation()}
            className="flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold text-sky-400 border border-sky-500/25 bg-sky-500/8 hover:bg-sky-500/15 w-full"
            style={{ transition: 'background 0.1s' }}
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            Deep Analysis + P&L Chart
          </Link>

          {/* Groq thesis */}
          {trade.groq_thesis && (
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <Brain className="w-3 h-3" /> Groq Thesis
              </p>
              <p className="text-xs text-slate-300 leading-relaxed">{trade.groq_thesis}</p>
            </div>
          )}

          {/* Signals at entry */}
          {trade.signals_at_entry && trade.signals_at_entry.length > 0 && (
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Signals at entry</p>
              <div className="flex flex-col gap-1">
                {trade.signals_at_entry.slice(0, 4).map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-slate-500 w-16 shrink-0">{s.type.replace(/_/g, ' ')}</span>
                    <span className={`text-[10px] font-bold tabular-nums ${s.sev >= 8 ? 'text-red-400' : s.sev >= 6 ? 'text-orange-400' : 'text-yellow-400'}`}>{s.sev}</span>
                    <span className="text-slate-500 truncate">{s.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Signal source attribution — top signals shown as pills */}
          {trade.signals_at_entry && trade.signals_at_entry.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] text-slate-600 self-center">Triggered by:</span>
              {trade.signals_at_entry.slice(0, 5).map((s, i) => {
                const color = s.sev >= 9 ? 'text-red-400 border-red-500/30 bg-red-500/8'
                  : s.sev >= 7 ? 'text-orange-400 border-orange-500/30 bg-orange-500/8'
                  : s.sev >= 5 ? 'text-yellow-400 border-yellow-500/25 bg-yellow-500/8'
                  : 'text-slate-400 border-white/[0.08] bg-white/[0.03]'
                return (
                  <span key={i} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${color}`} title={s.title}>
                    {s.type.replace(/_/g, ' ')} · {s.sev}
                  </span>
                )
              })}
            </div>
          )}

          {/* Exit note */}
          {trade.groq_exit_note && (
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Exit note</p>
              <p className="text-xs text-slate-400 leading-relaxed">{trade.groq_exit_note}</p>
            </div>
          )}

          {/* Feature 2: Personal trade note */}
          <TradeNoteEditor tradeId={trade.id} />

          {/* #20 — Quality scorecard for closed trades */}
          {isClosed && (() => {
            const { score, reasons } = computeTradeQuality(trade)
            return (
              <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Setup Quality</p>
                  <QualityBadge score={score} />
                  <span className="text-[10px] text-slate-600 ml-auto">independent of P&L outcome</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {reasons.map((r, i) => {
                    const isGood = score > 0 && ['R:R', '2+', 'proper', 'high confidence', 'specific'].some(k => r.includes(k))
                    return (
                      <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded border ${isGood ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5' : 'text-slate-500 border-white/[0.06]'}`}>
                        {r}
                      </span>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

type Account = {
  balance: number
  starting_balance: number
  peak_balance: number
  total_trades: number
  winning_trades: number
  losing_trades: number
}

type EquityPoint = {
  date: string
  balance: number
  daily_pnl: number
  drawdown_pct: number
  win_rate: number | null
}

type PremktPick = {
  ticker: string
  direction: string
  trade_type: string
  entry_zone: number
  stop: number
  target: number
  conviction: number
  thesis: string
}

type RejectedCandidate = {
  ticker: string
  score: number
  price: number | null
  change_pct: number | null
  top_signal: string
  reason: string
}

type PremktPlan = {
  date: string
  picks: PremktPick[]
  outlook_direction: string | null
  rejected_candidates?: RejectedCandidate[]
}

type GroqLesson = {
  date: string
  lesson: string
  key_factors?: Record<string, unknown> | null
}

type TradeEval = {
  id: string
  trade_id: string
  ticker: string
  decision: string
  reason: string | null
  price_at_eval: number
  pnl_pct_at_eval: number
  evaluated_at: string
}

// Intraday live P&L sparkline — shows balance movement during current session
function IntradaySparkline({ points, starting }: { points: { t: number; balance: number }[]; starting: number }) {
  if (points.length < 2) return null
  const W = 320, H = 48, PAD = { l: 4, r: 4, t: 4, b: 4 }
  const cW = W - PAD.l - PAD.r
  const cH = H - PAD.t - PAD.b
  const balances = points.map(p => p.balance)
  const minB = Math.min(...balances, starting * 0.998)
  const maxB = Math.max(...balances, starting * 1.002)
  const range = maxB - minB || 1
  const toX = (i: number) => PAD.l + (i / (points.length - 1)) * cW
  const toY = (b: number) => PAD.t + (1 - (b - minB) / range) * cH
  const pts = points.map((p, i) => `${toX(i)},${toY(p.balance)}`).join(' ')
  const last = points[points.length - 1]
  const isUp = last.balance >= starting
  const pct = ((last.balance - starting) / starting * 100)
  const startTime = new Date(points[0].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const lastTime = new Date(last.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const stroke = isUp ? '#10b981' : '#ef4444'

  return (
    <div className="mt-3 pt-3 border-t border-white/[0.06]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider flex items-center gap-1">
          <Activity className="w-3 h-3 text-emerald-400 animate-pulse" /> Intraday Live
        </span>
        <span className={`text-xs font-bold tabular-nums ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
          {pct >= 0 ? '+' : ''}{pct.toFixed(3)}% today
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 48 }}>
        {/* Zero line (starting balance) */}
        <line x1={PAD.l} y1={toY(starting)} x2={W - PAD.r} y2={toY(starting)} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="3 3" />
        {/* Filled area */}
        <polygon
          points={`${toX(0)},${toY(starting)} ${pts} ${toX(points.length - 1)},${toY(starting)}`}
          fill={isUp ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)'}
        />
        {/* Line */}
        <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {/* End dot */}
        <circle cx={toX(points.length - 1)} cy={toY(last.balance)} r="3" fill={stroke} />
      </svg>
      <div className="flex justify-between text-[10px] text-slate-600 mt-0.5 tabular-nums">
        <span>{startTime}</span>
        <span>{points.length} snapshots</span>
        <span>{lastTime}</span>
      </div>
    </div>
  )
}

// #4 — SPY benchmark: { date, balance } where balance = starting * (1 + cumulative_return)
type SpyPoint = { date: string; balance: number }

type TradeMarker = { date: string; isWin: boolean; type: 'entry' | 'exit' }

function EquityCurve({ equity, starting, spy, tradeMarkers }: { equity: EquityPoint[]; starting: number; spy?: SpyPoint[]; tradeMarkers?: TradeMarker[] }) {
  if (equity.length < 2) return (
    <div className="h-24 flex items-center justify-center text-xs text-slate-600">
      Equity curve appears after first closed trade
    </div>
  )

  const balances = equity.map(e => e.balance)
  // Include SPY values in min/max so both lines fit in view
  const spyBalances = (spy && spy.length > 1) ? spy.map(s => s.balance) : []
  const minB = Math.min(...balances, ...spyBalances, starting * 0.95)
  const maxB = Math.max(...balances, ...spyBalances, starting * 1.05)
  const range = maxB - minB || 1

  const W = 600; const H = 96
  const PAD = { top: 8, bottom: 20, left: 48, right: 8 }
  const cW = W - PAD.left - PAD.right
  const cH = H - PAD.top - PAD.bottom

  const toX = (i: number) => PAD.left + (i / (equity.length - 1)) * cW
  const toY = (b: number) => PAD.top + cH - ((b - minB) / range) * cH

  const points = equity.map((e, i) => `${toX(i)},${toY(e.balance)}`).join(' ')
  const startY = toY(starting)
  const lastBal = balances[balances.length - 1]
  const isUp = lastBal >= starting

  // Map SPY points to same X scale as equity (by date alignment)
  const equityDates = equity.map(e => e.date)
  const spyPoints = spy && spy.length > 1
    ? spy
        .map(s => {
          const idx = equityDates.findIndex(d => d >= s.date)
          if (idx < 0) return null
          return `${toX(idx)},${toY(s.balance)}`
        })
        .filter(Boolean)
        .join(' ')
    : null

  const lastSpy = spy && spy.length > 0 ? spy[spy.length - 1].balance : null
  const spyReturn = lastSpy ? ((lastSpy - starting) / starting * 100).toFixed(1) : null

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 280 }}>
        {/* Starting balance line */}
        <line x1={PAD.left} y1={startY} x2={W - PAD.right} y2={startY} stroke="rgba(255,255,255,0.12)" strokeWidth="1" strokeDasharray="4 3" />
        <text x={PAD.left - 4} y={startY + 4} textAnchor="end" fontSize="8" fill="#475569">${(starting / 1000).toFixed(0)}k</text>

        {/* Fill */}
        <polygon
          points={`${toX(0)},${startY} ${points} ${toX(equity.length - 1)},${startY}`}
          fill={isUp ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}
        />

        {/* Main equity line */}
        <polyline points={points} fill="none" stroke={isUp ? '#10b981' : '#ef4444'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* #4 — SPY benchmark line */}
        {spyPoints && (
          <polyline points={spyPoints} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="5 3" strokeLinejoin="round" strokeLinecap="round" opacity="0.6" />
        )}

        {/* #16 — Trade markers: triangles at entry/exit dates */}
        {tradeMarkers && tradeMarkers.map((m, idx) => {
          const eqIdx = equityDates.findIndex(d => d >= m.date)
          if (eqIdx < 0) return null
          const x = toX(eqIdx)
          const y = toY(equity[eqIdx]?.balance ?? starting)
          const color = m.isWin ? '#10b981' : '#ef4444'
          // Entry = upward triangle, Exit = downward triangle
          const pts = m.type === 'exit'
            ? `${x},${y + 6} ${x - 4},${y - 2} ${x + 4},${y - 2}`
            : `${x},${y - 6} ${x - 4},${y + 2} ${x + 4},${y + 2}`
          return <polygon key={idx} points={pts} fill={color} opacity="0.8" />
        })}

        {/* End dot */}
        <circle cx={toX(equity.length - 1)} cy={toY(lastBal)} r="4" fill={isUp ? '#10b981' : '#ef4444'} />

        {/* Y axis labels */}
        {[minB, (minB + maxB) / 2, maxB].map((b, i) => (
          <text key={i} x={PAD.left - 4} y={toY(b) + 4} textAnchor="end" fontSize="8" fill="#334155">
            ${(b / 1000).toFixed(1)}k
          </text>
        ))}

        {/* X axis labels */}
        {[0, Math.floor(equity.length / 2), equity.length - 1].map(i => {
          if (i >= equity.length) return null
          const d = equity[i].date
          return <text key={i} x={toX(i)} y={H - 2} textAnchor="middle" fontSize="8" fill="#334155">{d.slice(5)}</text>
        })}
      </svg>
      {/* Legend */}
      {spyPoints && (
        <div className="flex items-center gap-4 mt-1 text-[10px] text-slate-500">
          <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-emerald-400 rounded" />Groq ({((lastBal - starting) / starting * 100).toFixed(1)}%)</span>
          <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-slate-400 rounded opacity-60" />SPY benchmark {spyReturn ? `(${Number(spyReturn) >= 0 ? '+' : ''}${spyReturn}%)` : ''}</span>
        </div>
      )}
    </div>
  )
}

export default function SandboxClient({
  openTrades,
  closedTrades,
  performance,
  account,
  equity,
  premktPlan,
  groqSelfCritiques,
  groqPatterns,
  groqWeekly,
  tradeEvals,
  spyBenchmark,
}: {
  openTrades: SandboxTrade[]
  closedTrades: SandboxTrade[]
  performance: Performance[]
  account: Account | null
  equity: EquityPoint[]
  premktPlan: PremktPlan | null
  groqSelfCritiques: GroqLesson[]
  groqPatterns: GroqLesson | null
  groqWeekly: GroqLesson | null
  tradeEvals: TradeEval[]
  spyBenchmark?: SpyPoint[]
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'open' | 'closed' | 'performance' | 'gameplan' | 'learning' | 'evals' | 'history' | 'stats'>('open')
  const [livePrices, setLivePrices] = useState<Record<string, number>>({})
  const [liveMode, setLiveMode] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [resetting, setResetting] = useState(false)
  const [forceClosing, setForceClosing] = useState<string | null>(null)
  const [workerStatus, setWorkerStatus] = useState<{ worker_alive: boolean; hours_since_last_activity: number; stale_day_trades: number } | null>(null)
  const [dataFreshness, setDataFreshness] = useState<Record<string, { age_minutes: number; is_stale_10min: boolean; is_stale_1hr: boolean }>>({}) // #7

  // Live P&L graph — intraday equity points (balance snapshots every 60s from open positions)
  const [intradayEquity, setIntradayEquity] = useState<{ t: number; balance: number }[]>([])
  const intradayRef = useRef<{ t: number; balance: number }[]>([])

  // History tab filters
  const [historySearch, setHistorySearch] = useState('')
  const [historyDirection, setHistoryDirection] = useState<'all' | 'long' | 'short'>('all')
  const [historyExit, setHistoryExit] = useState<'all' | 'target_hit' | 'stop_hit' | 'groq_exit' | 'day_close' | 'max_hold'>('all')
  const [historyOutcome, setHistoryOutcome] = useState<'all' | 'win' | 'loss'>('all')

  // Derived account values — declared before the effects/memos that read them
  // (the live P&L effect closes over `starting`).
  const starting = account?.starting_balance ?? 50000
  const balance = account?.balance ?? starting
  const peak = account?.peak_balance ?? starting
  const totalPnl = balance - starting
  const totalPnlPct = (totalPnl / starting) * 100
  const drawdown = peak > 0 ? ((peak - balance) / peak) * 100 : 0
  const winRate = account && account.total_trades > 0
    ? (account.winning_trades / account.total_trades) * 100
    : 0
  // Mirrors workers/sandbox_worker.py get_confidence_threshold() exactly so the
  // displayed bar matches what the worker actually enforces (base 55, learning mode <10 trades).
  const totalTrades = account?.total_trades ?? 0
  const confThreshold =
    totalTrades < 10 ? 55
    : winRate < 40 ? 70
    : winRate < 50 ? 60
    : winRate >= 65 ? 45
    : 55

  // Note: per-trade notes are persisted directly by the <TradeNoteEditor> component
  // (keyed by trade id in localStorage), so no shared state is needed here.

  // Feature 3: re-entry detector — tickers traded 3+ times
  const reentryTickers = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of [...openTrades, ...closedTrades]) {
      counts[t.ticker] = (counts[t.ticker] ?? 0) + 1
    }
    return new Set(Object.entries(counts).filter(([, n]) => n >= 3).map(([t]) => t))
  }, [openTrades, closedTrades])

  // Feature 5: position size heatmap data — closed trades sorted by $ size
  const positionSizes = useMemo(() => {
    return [...closedTrades]
      .map(t => ({
        id: t.id, ticker: t.ticker, direction: t.direction,
        size: Number(t.entry_price) * Number(t.shares || 1),
        pnl: t.pnl ?? 0,
      }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 20)
  }, [closedTrades])

  // Feature 6: time-of-day win rate (buckets: pre-market, morning, midday, afternoon)
  const timeOfDayStats = useMemo(() => {
    // Hour-resolution buckets (entry_date is parsed to a local hour). Ranges are
    // non-overlapping so a trade lands in exactly one bucket.
    const buckets = [
      { label: 'Pre-mkt', range: '4–9', check: (h: number) => h >= 4 && h < 9 },
      { label: 'Morning', range: '9–11', check: (h: number) => h >= 9 && h < 11 },
      { label: 'Midday', range: '11–13', check: (h: number) => h >= 11 && h < 13 },
      { label: 'Afternoon', range: '13–16', check: (h: number) => h >= 13 && h < 16 },
    ]
    return buckets.map(b => {
      const trades = closedTrades.filter(t => {
        const et = new Date(t.entry_date)
        const h = et.getHours()
        return b.check(h)
      })
      const wins = trades.filter(t => (t.pnl ?? 0) > 0).length
      const wr = trades.length > 0 ? wins / trades.length * 100 : null
      const pnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
      return { ...b, total: trades.length, wins, wr, pnl }
    }).filter(b => b.total > 0)
  }, [closedTrades])

  // #1 — Fetch worker status on mount
  useEffect(() => {
    fetch('/api/sandbox/status')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setWorkerStatus(d) })
      .catch(() => {})
  }, [])

  // #20 — Realtime: reload page when a sandbox trade closes or account balance changes
  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    // Debounce: batch rapid DB changes into a single reload after 3s quiet period
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => window.location.reload(), 3000)
    }
    const channel = supabase
      .channel('sandbox-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sandbox_trades' }, scheduleReload)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sandbox_account' }, scheduleReload)
      .subscribe()
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      supabase.removeChannel(channel)
    }
  }, [])

  async function handleReset() {
    if (!window.confirm('Reset sandbox to $50,000? This deletes ALL trades, P&L, and history. Cannot be undone.')) return
    setResetting(true)
    try {
      const r = await fetch('/api/sandbox/reset', { method: 'POST' })
      if (r.ok) {
        window.location.reload()
      } else {
        const d = await r.json()
        alert(`Reset failed: ${d.error}`)
      }
    } catch {
      alert('Reset failed — network error')
    } finally {
      setResetting(false)
    }
  }

  // #19 — Force-close a trade from the UI
  async function handleForceClose(tradeId: string, ticker: string) {
    if (!window.confirm(`Force-close ${ticker} at current snapshot price?`)) return
    setForceClosing(tradeId)
    try {
      const r = await fetch('/api/sandbox/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: tradeId }),
      })
      if (r.ok) {
        window.location.reload()
      } else {
        const d = await r.json()
        alert(`Force close failed: ${d.error}`)
      }
    } catch {
      alert('Force close failed — network error')
    } finally {
      setForceClosing(null)
    }
  }

  // Returns true if market is currently open (9:30am–4:00pm ET weekdays)
  function isMarketHours(): boolean {
    const now = new Date()
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = et.getDay()
    if (day === 0 || day === 6) return false
    const h = et.getHours(), m = et.getMinutes()
    const total = h * 60 + m
    return total >= 570 && total < 960 // 9:30–4:00pm
  }

  // #7: Check data freshness for all open tickers
  function fetchDataFreshness() {
    if (openTrades.length === 0) return
    const uniqueTickers = [...new Set(openTrades.map(t => t.ticker))]
    Promise.all(
      uniqueTickers.map(ticker =>
        fetch(`/api/data-freshness?ticker=${ticker}`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
          .then(d => ({ ticker, freshness: d }))
      )
    ).then(results => {
      const fresh: Record<string, any> = {}
      results.forEach(({ ticker, freshness }) => {
        if (freshness) fresh[ticker] = freshness
      })
      setDataFreshness(fresh)
    }).catch(() => {})
  }

  function fetchAllPrices() {
    if (openTrades.length === 0) return
    const uniqueTickers = [...new Set(openTrades.map(t => t.ticker))]
    fetchDataFreshness()
    Promise.all(
      uniqueTickers.map(ticker =>
        fetchLatestPrice(ticker).then(price => ({ ticker, price }))
      )
    ).then(results => {
      const prices: Record<string, number> = {}
      for (const { ticker, price } of results) {
        if (price != null) prices[ticker] = price
      }
      setLivePrices(prices)
      setLastRefresh(new Date())
    })
  }

  // Fetch prices on mount
  useEffect(() => {
    fetchAllPrices()
  }, [openTrades]) // eslint-disable-line react-hooks/exhaustive-deps

  // #19 — Auto-refresh every 60s when live mode is on and market is open
  useEffect(() => {
    if (!liveMode) return
    if (!isMarketHours()) return
    const interval = setInterval(() => {
      fetchAllPrices()
    }, 60_000)
    return () => clearInterval(interval)
  }, [liveMode, openTrades]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live P&L graph — build intraday equity curve from live prices
  // Every time livePrices updates during market hours, snapshot the total account balance
  useEffect(() => {
    if (Object.keys(livePrices).length === 0) return
    const unrealized = openTrades.reduce((sum, t) => {
      const price = livePrices[t.ticker]
      if (price == null) return sum
      const entry = Number(t.entry_price)
      const shares = Number(t.shares || 1)
      const pnl = t.direction === 'long' ? (price - entry) * shares : (entry - price) * shares
      return sum + pnl
    }, 0)
    const snap = { t: Date.now(), balance: (account?.balance ?? starting) + unrealized }
    intradayRef.current = [...intradayRef.current.slice(-60), snap] // keep last 60 points
    setIntradayEquity([...intradayRef.current])
  }, [livePrices]) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const wins = closedTrades.filter(t => (t.pnl ?? 0) > 0).length
    const losses = closedTrades.filter(t => (t.pnl ?? 0) < 0).length
    const total = closedTrades.length
    const winRate = total > 0 ? (wins / total) * 100 : 0
    const grossPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
    const avgWin = wins > 0
      ? closedTrades.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / wins
      : 0
    const avgLoss = losses > 0
      ? closedTrades.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / losses
      : 0

    // FIX #13: Calculate streak (3+ wins or 7+ losses)
    let winStreak = 0, lossStreak = 0
    for (let i = closedTrades.length - 1; i >= 0; i--) {
      const pnl = closedTrades[i].pnl ?? 0
      if (pnl > 0) {
        winStreak++
        lossStreak = 0
      } else if (pnl < 0) {
        lossStreak++
        winStreak = 0
      }
    }

    return { wins, losses, total, winRate, grossPnl, avgWin, avgLoss, winStreak, lossStreak }
  }, [closedTrades])

  // Unrealized P&L across all open trades using pre-fetched prices
  const unrealizedPnl = useMemo(() => {
    let total = 0
    let priced = 0
    for (const t of openTrades) {
      const price = livePrices[t.ticker]
      if (price == null) continue
      const entry = Number(t.entry_price)
      const shares = Number(t.shares || 1)
      const pnl = t.direction === 'long' ? (price - entry) * shares : (entry - price) * shares
      total += pnl
      priced++
    }
    return { total, priced }
  }, [openTrades, livePrices])

  const openWinning = useMemo(() => {
    return openTrades.filter(t => {
      const price = livePrices[t.ticker]
      if (price == null) return false
      const entry = Number(t.entry_price)
      return t.direction === 'long' ? price > entry : price < entry
    }).length
  }, [openTrades, livePrices])

  const winRateColor = winRate >= 70 ? 'text-emerald-400' : winRate >= 50 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <FlaskConical className="w-5 h-5 text-purple-400 shrink-0" />
        <div>
          <h1 className="text-lg font-bold text-white">Groq Sandbox</h1>
          <p className="text-xs text-slate-500">$50,000 paper account — goal: 70% win rate, profitable over time</p>
          {/* FIX #13: Show streak counter */}
          {stats.winStreak >= 3 && (
            <p className="text-xs text-emerald-400 font-bold mt-1">🔥 {stats.winStreak}-win streak</p>
          )}
          {stats.lossStreak >= 7 && (
            <p className="text-xs text-red-400 font-bold mt-1">📉 {stats.lossStreak}-loss drawdown</p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] text-slate-600">
              updated {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => {
              setLiveMode(m => !m)
              if (!liveMode) fetchAllPrices()
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${liveMode ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10 animate-pulse' : 'text-slate-500 border-white/[0.08] bg-white/[0.03] hover:text-slate-300'}`}
            style={{ transition: 'all 0.1s' }}
          >
            <Activity className="w-3 h-3" />
            {liveMode ? 'LIVE' : 'Live Off'}
          </button>
          <button
            onClick={fetchAllPrices}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold border text-slate-500 border-white/[0.08] bg-white/[0.03] hover:text-slate-300"
            style={{ transition: 'color 0.1s' }}
          >
            ↻ Refresh
          </button>
          <button
            onClick={handleReset}
            disabled={resetting}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold border text-red-500/60 border-red-500/20 bg-red-500/5 hover:text-red-400 hover:border-red-500/30 disabled:opacity-40"
            style={{ transition: 'all 0.1s' }}
            title="Reset sandbox to $50,000"
          >
            {resetting ? '…' : '↺ Reset'}
          </button>
        </div>
      </div>

      {/* #1 — Worker status banner */}
      {workerStatus && (
        <div className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border text-xs ${
          !workerStatus.worker_alive
            ? 'border-red-500/30 bg-red-500/8 text-red-400'
            : workerStatus.stale_day_trades > 0
            ? 'border-yellow-500/25 bg-yellow-500/8 text-yellow-400'
            : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400'
        }`}>
          <div className={`w-2 h-2 rounded-full shrink-0 ${
            !workerStatus.worker_alive ? 'bg-red-400' : workerStatus.stale_day_trades > 0 ? 'bg-yellow-400' : 'bg-emerald-400 animate-pulse'
          }`} />
          {!workerStatus.worker_alive
            ? `Worker offline — last activity ${workerStatus.hours_since_last_activity.toFixed(0)}h ago. Trades are NOT being managed.`
            : workerStatus.stale_day_trades > 0
            ? `${workerStatus.stale_day_trades} stale day trade${workerStatus.stale_day_trades > 1 ? 's' : ''} from a previous session — worker will close them on next tick.`
            : `Worker active — last activity ${workerStatus.hours_since_last_activity.toFixed(0)}h ago`
          }
        </div>
      )}

      {/* #7 — Stale data warning */}
      {Object.entries(dataFreshness).filter(([_, f]) => f.is_stale_1hr).length > 0 && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl border border-red-500/30 bg-red-500/8 text-red-400 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            ⚠️ Data stale for {Object.entries(dataFreshness).filter(([_, f]) => f.is_stale_1hr).map(([t]) => t).join(', ')} — over 1h old. Click Refresh.
          </span>
        </div>
      )}
      {Object.entries(dataFreshness).filter(([_, f]) => f.is_stale_10min && !f.is_stale_1hr).length > 0 && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl border border-yellow-500/25 bg-yellow-500/8 text-yellow-400 text-xs">
          <Clock className="w-4 h-4 shrink-0" />
          <span>
            Data {Math.round(Math.min(...Object.entries(dataFreshness).filter(([_, f]) => f.is_stale_10min).map(([_, f]) => f.age_minutes)) || 0)} min old for {Object.entries(dataFreshness).filter(([_, f]) => f.is_stale_10min && !f.is_stale_1hr).map(([t]) => t).join(', ')}
          </span>
        </div>
      )}

      {/* Account balance hero */}
      <div className="border border-white/[0.07] rounded-xl p-5" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div>
            <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">Account Balance</p>
            <p className={`text-4xl font-bold tabular-nums ${pnlColor(totalPnl)}`}>
              ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <div className="flex items-center gap-3 mt-1">
              <span className={`text-sm font-semibold tabular-nums ${pnlColor(totalPnl)}`}>
                {totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className={`text-sm font-semibold tabular-nums ${pnlColor(totalPnlPct)}`}>
                ({totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%)
              </span>
              <span className="text-xs text-slate-600">from $50,000 start</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-right">
            <div className="flex items-center gap-2 justify-end">
              <span className="text-[11px] text-slate-500">Win Rate</span>
              <span className={`text-sm font-bold tabular-nums ${winRateColor}`}>{winRate.toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <span className="text-[11px] text-slate-500">Trades</span>
              <span className="text-sm font-bold text-white tabular-nums">
                {account?.winning_trades ?? 0}W / {account?.losing_trades ?? 0}L
              </span>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <span className="text-[11px] text-slate-500">Max Drawdown</span>
              <span className="text-sm font-bold text-red-400 tabular-nums">{drawdown.toFixed(2)}%</span>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <span className="text-[11px] text-slate-500">Conf. Threshold</span>
              <span className="text-sm font-bold text-purple-400 tabular-nums">{confThreshold}%</span>
            </div>
          </div>
        </div>

        {/* Equity curve */}
        <EquityCurve
          equity={equity}
          starting={starting}
          spy={spyBenchmark}
          tradeMarkers={closedTrades.map(t => ({
            date: t.exit_date ?? t.entry_date,
            isWin: (t.pnl ?? 0) > 0,
            type: 'exit' as const,
          }))}
        />

        {/* Intraday live P&L sparkline — only shown during market hours when live mode is on */}
        {liveMode && intradayEquity.length >= 2 && (
          <IntradaySparkline points={intradayEquity} starting={account?.balance ?? starting} />
        )}

        {/* Unrealized P&L strip — only when open positions have prices */}
        {unrealizedPnl.priced > 0 && (
          <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs">
            <span className="text-slate-500">
              Unrealized P&L — {unrealizedPnl.priced}/{openTrades.length} positions priced
              {openWinning > 0 && <span className="text-emerald-400 ml-1">({openWinning} winning)</span>}
              {openTrades.length - openWinning - (openTrades.length - unrealizedPnl.priced) > 0 && (
                <span className="text-red-400 ml-1">({openTrades.length - openWinning - (openTrades.length - unrealizedPnl.priced)} losing)</span>
              )}
            </span>
            <span className={`font-bold tabular-nums text-sm ${pnlColor(unrealizedPnl.total)}`}>
              {unrealizedPnl.total >= 0 ? '+' : ''}${unrealizedPnl.total.toFixed(0)}
            </span>
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Win Rate', value: `${winRate.toFixed(1)}%`, sub: 'Goal: 70%', color: winRateColor },
          { label: 'Open Positions', value: openTrades.length, sub: `${MAX_OPEN_POSITIONS} max`, color: 'text-sky-400' },
          { label: 'Avg Win / Loss', value: `${stats.avgWin.toFixed(1)}% / ${Math.abs(stats.avgLoss).toFixed(1)}%`, sub: `R:R ${stats.avgLoss !== 0 ? Math.abs(stats.avgWin / stats.avgLoss).toFixed(2) : '—'}`, color: 'text-white' },
          { label: 'Peak Balance', value: `$${(peak / 1000).toFixed(1)}k`, sub: `${drawdown.toFixed(1)}% from peak`, color: 'text-slate-300' },
        ].map(s => (
          <div key={s.label} className="border border-white/[0.07] rounded-xl p-3.5 flex flex-col gap-1" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[11px] text-slate-500 uppercase tracking-wider">{s.label}</p>
            <p className={`text-lg font-bold tabular-nums ${s.color}`}>{s.value}</p>
            <p className="text-[11px] text-slate-600">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Confidence calibration status */}
      <div className={`border rounded-xl px-4 py-3 flex items-center gap-3 text-xs ${winRate < 50 && (account?.total_trades ?? 0) >= 10 ? 'border-yellow-500/20 bg-yellow-500/5' : 'border-white/[0.07]'}`} style={{ background: winRate >= 50 || (account?.total_trades ?? 0) < 10 ? 'rgba(255,255,255,0.02)' : undefined }}>
        <Brain className="w-4 h-4 text-purple-400 shrink-0" />
        <div className="flex-1">
          <span className="text-slate-300 font-medium">Confidence threshold: </span>
          <span className="text-purple-400 font-bold">{confThreshold}%</span>
          {winRate < 40 && (account?.total_trades ?? 0) >= 10 && <span className="text-yellow-400 ml-2">— Win rate low, being selective</span>}
          {winRate >= 40 && winRate < 50 && (account?.total_trades ?? 0) >= 10 && <span className="text-yellow-400 ml-2">— Underperforming, tightened up</span>}
          {winRate >= 65 && <span className="text-emerald-400 ml-2">— On a roll, pressing the edge</span>}
          {winRate >= 50 && winRate < 65 && <span className="text-slate-500 ml-2">— Normal operation</span>}
          {(account?.total_trades ?? 0) < 10 && <span className="text-slate-500 ml-2">— Learning mode (need 10+ trades)</span>}
        </div>
        <span className="text-slate-600 tabular-nums">{account?.total_trades ?? 0} trades</span>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap border-b border-white/[0.07]">
        {[
          { id: 'open',       label: `Open (${openTrades.length})` },
          { id: 'closed',     label: `Closed (${closedTrades.length})` },
          { id: 'history',    label: '📋 History' },
          { id: 'stats',      label: '📊 Stats' },
          { id: 'performance',label: 'Performance' },
          { id: 'gameplan',   label: premktPlan ? '🎯 Game Plan' : 'Game Plan' },
          { id: 'learning',   label: '🧠 Learning' },
          { id: 'evals',      label: `Re-Evals (${tradeEvals.length})` },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`px-3 py-2 text-xs font-semibold border-b-2 -mb-px ${activeTab === tab.id ? 'border-sky-400 text-sky-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
            style={{ transition: 'color 0.1s' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Open */}
      {activeTab === 'open' && (
        <div className="flex flex-col gap-2">
          {openTrades.length === 0 ? (
            <div className="border border-white/[0.07] rounded-xl p-10 text-center flex flex-col items-center gap-3">
              <Clock className="w-8 h-8 text-slate-700" />
              <p className="text-sm text-slate-400">No open positions</p>
              <p className="text-xs text-slate-600">Groq scans for entries at 9:30am ET on weekdays.</p>
            </div>
          ) : openTrades.map(t => (
            <div key={t.id} className="flex flex-col gap-0">
              <TradeRow trade={t} expanded={expandedId === t.id} onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)} preloadedPrice={livePrices[t.ticker] ?? null} />
              {/* #19 — Force-close button */}
              {expandedId === t.id && (
                <button
                  onClick={e => { e.stopPropagation(); handleForceClose(t.id, t.ticker) }}
                  disabled={forceClosing === t.id}
                  className="mt-0.5 w-full py-1.5 rounded-b-xl text-[10px] font-bold text-red-400/70 border border-t-0 border-red-500/20 bg-red-500/5 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                  style={{ transition: 'all 0.1s' }}
                >
                  {forceClosing === t.id ? 'Closing…' : '⚡ Force Close at Current Price'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Closed */}
      {activeTab === 'closed' && (
        <div className="flex flex-col gap-2">
          {/* #17 — Stats summary bar */}
          {closedTrades.length > 0 && (() => {
            const wins = closedTrades.filter(t => (t.pnl ?? 0) > 0)
            const losses = closedTrades.filter(t => (t.pnl ?? 0) < 0)
            const gross = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
            const avgWinPct = wins.length ? wins.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / wins.length : 0
            const avgLossPct = losses.length ? losses.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / losses.length : 0
            const best = closedTrades.reduce((b, t) => (t.pnl ?? 0) > (b.pnl ?? 0) ? t : b, closedTrades[0])
            const worst = closedTrades.reduce((b, t) => (t.pnl ?? 0) < (b.pnl ?? 0) ? t : b, closedTrades[0])
            const wr = closedTrades.length > 0 ? wins.length / closedTrades.length * 100 : 0
            return (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border border-white/[0.07] rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="text-center">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Win Rate</p>
                  <p className={`text-sm font-bold tabular-nums ${wr >= 70 ? 'text-emerald-400' : wr >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>{wr.toFixed(1)}%</p>
                  <p className="text-[10px] text-slate-600">{wins.length}W / {losses.length}L</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Gross P&amp;L</p>
                  <p className={`text-sm font-bold tabular-nums ${pnlColor(gross)}`}>{gross >= 0 ? '+' : ''}${gross.toFixed(0)}</p>
                  <p className="text-[10px] text-slate-600">{closedTrades.length} trades</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Avg Win / Loss</p>
                  <p className="text-sm font-bold text-white tabular-nums">{avgWinPct.toFixed(1)}% / {Math.abs(avgLossPct).toFixed(1)}%</p>
                  <p className="text-[10px] text-slate-600">R:R {avgLossPct !== 0 ? Math.abs(avgWinPct / avgLossPct).toFixed(2) : '—'}</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Best / Worst</p>
                  <p className="text-sm font-bold tabular-nums">
                    <span className="text-emerald-400">+${(best.pnl ?? 0).toFixed(0)}</span>
                    <span className="text-slate-600"> / </span>
                    <span className="text-red-400">${(worst.pnl ?? 0).toFixed(0)}</span>
                  </p>
                  <p className="text-[10px] text-slate-600">{best.ticker} / {worst.ticker}</p>
                </div>
              </div>
            )
          })()}
          {closedTrades.length === 0 ? (
            <div className="border border-white/[0.07] rounded-xl p-10 text-center flex flex-col items-center gap-3">
              <BarChart2 className="w-8 h-8 text-slate-700" />
              <p className="text-sm text-slate-400">No closed trades yet</p>
              <p className="text-xs text-slate-600">Trades close at their stop, target, or 4pm ET.</p>
            </div>
          ) : closedTrades.map(t => (
            <TradeRow key={t.id} trade={t} expanded={expandedId === t.id} onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)} />
          ))}
        </div>
      )}

      {/* History — searchable, filterable full trade log */}
      {activeTab === 'history' && (() => {
        const allTrades = [...openTrades, ...closedTrades].sort((a, b) =>
          new Date(b.entry_date).getTime() - new Date(a.entry_date).getTime()
        )
        const filtered = allTrades.filter(t => {
          if (historySearch && !t.ticker.toLowerCase().includes(historySearch.toLowerCase()) &&
              !(t.groq_thesis ?? '').toLowerCase().includes(historySearch.toLowerCase())) return false
          if (historyDirection !== 'all' && t.direction !== historyDirection) return false
          if (historyExit !== 'all' && t.exit_reason !== historyExit) return false
          if (historyOutcome === 'win' && (t.pnl ?? 0) <= 0 && t.status === 'closed') return false
          if (historyOutcome === 'loss' && (t.pnl ?? 0) >= 0 && t.status === 'closed') return false
          return true
        })
        const wins = filtered.filter(t => t.status === 'closed' && (t.pnl ?? 0) > 0).length
        const losses = filtered.filter(t => t.status === 'closed' && (t.pnl ?? 0) < 0).length
        const gross = filtered.filter(t => t.status === 'closed').reduce((s, t) => s + (t.pnl ?? 0), 0)

        return (
          <div className="flex flex-col gap-3">
            {/* Filters */}
            <div className="flex flex-wrap gap-2 items-center">
              {/* Search */}
              <div className="flex items-center gap-1.5 border border-white/[0.08] bg-white/[0.03] rounded-lg px-2.5 py-1.5 flex-1 min-w-[160px]">
                <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <input
                  value={historySearch}
                  onChange={e => setHistorySearch(e.target.value)}
                  placeholder="Search ticker or thesis…"
                  className="bg-transparent text-xs text-slate-300 placeholder-slate-600 outline-none w-full"
                />
                {historySearch && (
                  <button onClick={() => setHistorySearch('')} className="text-slate-500 hover:text-slate-300">×</button>
                )}
              </div>
              {/* Direction */}
              <div className="flex items-center gap-1 border border-white/[0.07] rounded-lg p-0.5">
                {(['all', 'long', 'short'] as const).map(d => (
                  <button key={d} onClick={() => setHistoryDirection(d)}
                    className={`px-2.5 py-1 rounded text-[10px] font-bold ${historyDirection === d ? 'bg-sky-500/20 text-sky-400' : 'text-slate-500 hover:text-slate-300'}`}
                    style={{ transition: 'all 0.1s' }}>
                    {d === 'all' ? 'All' : d === 'long' ? '↑ Long' : '↓ Short'}
                  </button>
                ))}
              </div>
              {/* Outcome */}
              <div className="flex items-center gap-1 border border-white/[0.07] rounded-lg p-0.5">
                {(['all', 'win', 'loss'] as const).map(o => (
                  <button key={o} onClick={() => setHistoryOutcome(o)}
                    className={`px-2.5 py-1 rounded text-[10px] font-bold ${historyOutcome === o ? (o === 'win' ? 'bg-emerald-500/20 text-emerald-400' : o === 'loss' ? 'bg-red-500/20 text-red-400' : 'bg-sky-500/20 text-sky-400') : 'text-slate-500 hover:text-slate-300'}`}
                    style={{ transition: 'all 0.1s' }}>
                    {o === 'all' ? 'All' : o === 'win' ? 'Wins' : 'Losses'}
                  </button>
                ))}
              </div>
              {/* Exit reason */}
              <select
                value={historyExit}
                onChange={e => setHistoryExit(e.target.value as typeof historyExit)}
                className="border border-white/[0.07] bg-[#0a0f1a] text-slate-400 text-[10px] rounded-lg px-2 py-1.5 outline-none"
              >
                <option value="all">All exits</option>
                <option value="target_hit">🎯 Target hit</option>
                <option value="stop_hit">🛑 Stop hit</option>
                <option value="groq_exit">🤖 Groq exit</option>
                <option value="day_close">📅 EOD close</option>
                <option value="max_hold">⏰ Max hold</option>
              </select>
            </div>

            {/* Summary bar */}
            {filtered.length > 0 && (
              <div className="flex items-center gap-4 px-3 py-2 border border-white/[0.07] rounded-lg bg-white/[0.02] text-xs">
                <span className="text-slate-500">{filtered.length} trades</span>
                <span className="text-emerald-400 font-semibold">{wins}W</span>
                <span className="text-red-400 font-semibold">{losses}L</span>
                {(wins + losses) > 0 && <span className={`font-bold ${wins / (wins + losses) >= 0.5 ? 'text-emerald-400' : 'text-red-400'}`}>{(wins / (wins + losses) * 100).toFixed(1)}% WR</span>}
                <span className={`ml-auto font-bold tabular-nums ${pnlColor(gross)}`}>{gross >= 0 ? '+' : ''}${gross.toFixed(0)} P&L</span>
              </div>
            )}

            {/* Trade table */}
            {filtered.length === 0 ? (
              <div className="border border-white/[0.07] rounded-xl p-10 text-center">
                <p className="text-sm text-slate-400">No trades match filters</p>
              </div>
            ) : (
              <div className="border border-white/[0.07] rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.07] bg-white/[0.02]">
                      <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Ticker</th>
                      <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider hidden sm:table-cell">Dir</th>
                      <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider hidden sm:table-cell">Type</th>
                      <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider hidden md:table-cell">Signals</th>
                      <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider hidden sm:table-cell">Exit</th>
                      <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider hidden sm:table-cell">Date</th>
                      <th className="text-right px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">P&L</th>
                      <th className="text-right px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider hidden md:table-cell">Quality</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(t => {
                      const isWin = (t.pnl ?? 0) > 0
                      const topSignal = (t.signals_at_entry ?? [])[0]
                      return (
                        <tr
                          key={t.id}
                          className="border-b border-white/[0.04] hover:bg-white/[0.02] cursor-pointer"
                          onClick={() => { setActiveTab('open'); setExpandedId(t.id) }}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              {t.direction === 'long'
                                ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                : <TrendingDown className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                              <span className="font-bold text-white font-mono">{t.ticker}</span>
                              {t.status === 'open' && (
                                <span className="text-[9px] text-sky-400 border border-sky-500/25 px-1 rounded animate-pulse">LIVE</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 hidden sm:table-cell">
                            <span className={`text-[10px] font-bold ${t.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                              {t.direction.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 hidden sm:table-cell text-slate-500">{t.trade_type}</td>
                          <td className="px-3 py-2.5 hidden md:table-cell">
                            {topSignal ? (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${topSignal.sev >= 8 ? 'text-red-400 border-red-500/25 bg-red-500/8' : topSignal.sev >= 6 ? 'text-orange-400 border-orange-500/25 bg-orange-500/8' : 'text-yellow-400 border-yellow-500/25 bg-yellow-500/8'}`}>
                                {topSignal.type.replace(/_/g, ' ')} ·{topSignal.sev}
                              </span>
                            ) : <span className="text-slate-600">—</span>}
                            {(t.signals_at_entry ?? []).length > 1 && (
                              <span className="text-[10px] text-slate-600 ml-1">+{(t.signals_at_entry ?? []).length - 1}</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 hidden sm:table-cell text-slate-500 text-[10px]">{exitReasonLabel(t.exit_reason)}</td>
                          <td className="px-3 py-2.5 hidden sm:table-cell text-slate-600 tabular-nums text-[10px]">{t.exit_date ?? t.entry_date}</td>
                          <td className="px-3 py-2.5 text-right">
                            {t.status === 'open' ? (
                              <span className="text-sky-400 text-[10px]">open</span>
                            ) : (
                              <div className="flex flex-col items-end">
                                <span className={`font-bold tabular-nums ${pnlColor(t.pnl_pct)}`}>
                                  {(t.pnl_pct ?? 0) >= 0 ? '+' : ''}{(t.pnl_pct ?? 0).toFixed(2)}%
                                </span>
                                <span className={`text-[10px] tabular-nums ${pnlColor(t.pnl)}`}>
                                  {(t.pnl ?? 0) >= 0 ? '+' : ''}${(t.pnl ?? 0).toFixed(0)}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right hidden md:table-cell">
                            {t.status === 'closed' && <QualityBadge score={computeTradeQuality(t).score} />}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })()}

      {/* Stats — 12 deep analytics, zero Groq */}
      {activeTab === 'stats' && (() => {
        const closed = closedTrades.filter(t => t.status === 'closed')
        if (closed.length === 0) return (
          <div className="border border-white/[0.07] rounded-xl p-10 text-center flex flex-col items-center gap-3">
            <BarChart2 className="w-8 h-8 text-slate-700" />
            <p className="text-sm text-slate-400">Stats appear after first closed trade</p>
          </div>
        )

        // ── 1. Per-ticker breakdown ───────────────────────────────────────────
        const byTicker: Record<string, { wins: number; losses: number; pnl: number; trades: number }> = {}
        for (const t of closed) {
          if (!byTicker[t.ticker]) byTicker[t.ticker] = { wins: 0, losses: 0, pnl: 0, trades: 0 }
          byTicker[t.ticker].trades++
          byTicker[t.ticker].pnl += t.pnl ?? 0
          if ((t.pnl ?? 0) > 0) byTicker[t.ticker].wins++
          else byTicker[t.ticker].losses++
        }
        const tickerRows = Object.entries(byTicker).sort((a, b) => b[1].pnl - a[1].pnl)
        const bestTicker = tickerRows[0]
        const worstTicker = tickerRows[tickerRows.length - 1]

        // ── 2. Profit factor ─────────────────────────────────────────────────
        const grossWins = closed.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0)
        const grossLosses = Math.abs(closed.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + (t.pnl ?? 0), 0))
        const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0

        // ── 3. Exit reason breakdown ─────────────────────────────────────────
        const exitCounts: Record<string, { wins: number; total: number; pnl: number }> = {}
        for (const t of closed) {
          const r = t.exit_reason ?? 'unknown'
          if (!exitCounts[r]) exitCounts[r] = { wins: 0, total: 0, pnl: 0 }
          exitCounts[r].total++
          exitCounts[r].pnl += t.pnl ?? 0
          if ((t.pnl ?? 0) > 0) exitCounts[r].wins++
        }

        // ── 4. Day vs swing breakdown ────────────────────────────────────────
        const dayTrades = closed.filter(t => t.trade_type === 'day')
        const swingTrades = closed.filter(t => t.trade_type === 'swing')
        const dayWr = dayTrades.length > 0 ? dayTrades.filter(t => (t.pnl ?? 0) > 0).length / dayTrades.length * 100 : 0
        const swingWr = swingTrades.length > 0 ? swingTrades.filter(t => (t.pnl ?? 0) > 0).length / swingTrades.length * 100 : 0
        const dayPnl = dayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
        const swingPnl = swingTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)

        // ── 5. Long vs short breakdown ───────────────────────────────────────
        const longs = closed.filter(t => t.direction === 'long')
        const shorts = closed.filter(t => t.direction === 'short')
        const longWr = longs.length > 0 ? longs.filter(t => (t.pnl ?? 0) > 0).length / longs.length * 100 : 0
        const shortWr = shorts.length > 0 ? shorts.filter(t => (t.pnl ?? 0) > 0).length / shorts.length * 100 : 0
        const longPnl = longs.reduce((s, t) => s + (t.pnl ?? 0), 0)
        const shortPnl = shorts.reduce((s, t) => s + (t.pnl ?? 0), 0)

        // ── 6. Confidence vs win rate (buckets: <60, 60-70, 70-80, 80+) ─────
        const confBuckets: Record<string, { wins: number; total: number }> = {
          '<60': { wins: 0, total: 0 },
          '60–70': { wins: 0, total: 0 },
          '70–80': { wins: 0, total: 0 },
          '80+': { wins: 0, total: 0 },
        }
        for (const t of closed) {
          const c = t.confidence_used ?? 0
          const b = c < 60 ? '<60' : c < 70 ? '60–70' : c < 80 ? '70–80' : '80+'
          confBuckets[b].total++
          if ((t.pnl ?? 0) > 0) confBuckets[b].wins++
        }

        // ── 7. R-multiple distribution ───────────────────────────────────────
        const rMultiples = closed.map(t => {
          const entry = Number(t.entry_price)
          const stop = Number(t.stop_loss)
          const risk = t.direction === 'long' ? entry - stop : stop - entry
          if (risk <= 0 || !t.pnl) return null
          return t.pnl / (risk * Number(t.shares || 1))
        }).filter((r): r is number => r !== null)
        const avgR = rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : 0
        const posR = rMultiples.filter(r => r > 0).length
        const negR = rMultiples.filter(r => r <= 0).length

        // ── 8. Holding period (entry to exit in calendar days) ───────────────
        const holdingDays = closed.map(t => {
          if (!t.exit_date) return null
          return Math.round((new Date(t.exit_date).getTime() - new Date(t.entry_date).getTime()) / 86400000)
        }).filter((d): d is number => d !== null && d >= 0)
        const avgHold = holdingDays.length > 0 ? holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length : 0

        // ── 9. Profit efficiency (pnl_pct / peak_pnl_pct) ───────────────────
        const efficiencies = closed
          .filter(t => t.profit_efficiency != null && t.profit_efficiency > 0)
          .map(t => t.profit_efficiency as number)
        const avgEff = efficiencies.length > 0 ? efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length : null

        // ── 10. Win streak calendar (last 20 trades) ─────────────────────────
        const last20 = [...closed].reverse().slice(0, 20)

        // ── 11. Consecutive losses (drawdown streaks) ────────────────────────
        let maxLossStreak = 0, curStreak = 0
        for (const t of closed) {
          if ((t.pnl ?? 0) < 0) { curStreak++; maxLossStreak = Math.max(maxLossStreak, curStreak) }
          else curStreak = 0
        }

        // ── 12. Expected value per trade ─────────────────────────────────────
        const wins2 = closed.filter(t => (t.pnl ?? 0) > 0)
        const losses2 = closed.filter(t => (t.pnl ?? 0) < 0)
        const avgWinPnlPct = wins2.length > 0 ? wins2.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / wins2.length : 0
        const avgLossPnlPct = losses2.length > 0 ? Math.abs(losses2.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / losses2.length) : 0
        const wrFrac = closed.length > 0 ? wins2.length / closed.length : 0
        const expectedValue = (wrFrac * avgWinPnlPct) - ((1 - wrFrac) * avgLossPnlPct)

        return (
          <div className="flex flex-col gap-4">

            {/* Row 1 — Key ratios */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Profit Factor', value: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2), sub: '>1.5 is solid', color: profitFactor >= 1.5 ? 'text-emerald-400' : profitFactor >= 1 ? 'text-yellow-400' : 'text-red-400' },
                { label: 'Avg R-Multiple', value: avgR.toFixed(2) + 'R', sub: `${posR} pos / ${negR} neg`, color: avgR >= 1 ? 'text-emerald-400' : avgR >= 0 ? 'text-yellow-400' : 'text-red-400' },
                { label: 'Expected Value', value: `${expectedValue >= 0 ? '+' : ''}${expectedValue.toFixed(2)}%`, sub: 'per trade avg', color: expectedValue > 0 ? 'text-emerald-400' : 'text-red-400' },
                { label: 'Avg Hold Time', value: `${avgHold.toFixed(1)}d`, sub: `${holdingDays.length} trades measured`, color: 'text-slate-300' },
              ].map(s => (
                <div key={s.label} className="border border-white/[0.07] rounded-xl p-3.5 flex flex-col gap-1" style={{ background: 'rgba(255,255,255,0.02)' }}>
                  <p className="text-[11px] text-slate-500 uppercase tracking-wider">{s.label}</p>
                  <p className={`text-xl font-bold tabular-nums ${s.color}`}>{s.value}</p>
                  <p className="text-[11px] text-slate-600">{s.sub}</p>
                </div>
              ))}
            </div>

            {/* Row 2 — Day vs Swing / Long vs Short */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Day vs Swing */}
              <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Day vs Swing</p>
                <div className="flex flex-col gap-2">
                  {[
                    { label: 'Day', count: dayTrades.length, wr: dayWr, pnl: dayPnl, color: 'bg-sky-500' },
                    { label: 'Swing', count: swingTrades.length, wr: swingWr, pnl: swingPnl, color: 'bg-purple-500' },
                  ].map(row => (
                    <div key={row.label} className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-10 shrink-0">{row.label}</span>
                      <div className="flex-1 h-2 bg-white/[0.05] rounded-full overflow-hidden">
                        <div className={`h-full ${row.color} rounded-full opacity-60`} style={{ width: `${row.wr}%` }} />
                      </div>
                      <span className={`text-xs font-bold tabular-nums w-10 text-right ${row.wr >= 60 ? 'text-emerald-400' : row.wr >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>{row.wr.toFixed(0)}%</span>
                      <span className={`text-[11px] tabular-nums w-16 text-right ${pnlColor(row.pnl)}`}>{row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(0)}</span>
                      <span className="text-[10px] text-slate-600 w-6 text-right">{row.count}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Long vs Short */}
              <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Long vs Short</p>
                <div className="flex flex-col gap-2">
                  {[
                    { label: 'Long', count: longs.length, wr: longWr, pnl: longPnl, color: 'bg-emerald-500' },
                    { label: 'Short', count: shorts.length, wr: shortWr, pnl: shortPnl, color: 'bg-red-500' },
                  ].map(row => (
                    <div key={row.label} className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-10 shrink-0">{row.label}</span>
                      <div className="flex-1 h-2 bg-white/[0.05] rounded-full overflow-hidden">
                        <div className={`h-full ${row.color} rounded-full opacity-60`} style={{ width: `${row.wr}%` }} />
                      </div>
                      <span className={`text-xs font-bold tabular-nums w-10 text-right ${row.wr >= 60 ? 'text-emerald-400' : row.wr >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>{row.wr.toFixed(0)}%</span>
                      <span className={`text-[11px] tabular-nums w-16 text-right ${pnlColor(row.pnl)}`}>{row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(0)}</span>
                      <span className="text-[10px] text-slate-600 w-6 text-right">{row.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Row 3 — Confidence buckets */}
            <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Confidence vs Win Rate</p>
              <div className="flex flex-col gap-2">
                {Object.entries(confBuckets).map(([bucket, { wins, total }]) => {
                  const wr = total > 0 ? wins / total * 100 : 0
                  return (
                    <div key={bucket} className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-12 shrink-0 tabular-nums">{bucket}%</span>
                      <div className="flex-1 h-2 bg-white/[0.05] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full opacity-70 ${wr >= 60 ? 'bg-emerald-500' : wr >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: total > 0 ? `${wr}%` : '0%' }} />
                      </div>
                      <span className={`text-xs font-bold tabular-nums w-12 text-right ${wr >= 60 ? 'text-emerald-400' : wr >= 50 ? 'text-yellow-400' : total === 0 ? 'text-slate-600' : 'text-red-400'}`}>{total > 0 ? `${wr.toFixed(0)}%` : '—'}</span>
                      <span className="text-[10px] text-slate-600 w-12 text-right">{total} trades</span>
                    </div>
                  )
                })}
                <p className="text-[10px] text-slate-600 mt-1">Higher confidence = should mean higher win rate. If not, Groq is overconfident.</p>
              </div>
            </div>

            {/* Row 4 — Exit reason breakdown */}
            <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Exit Reason Breakdown</p>
              <div className="flex flex-col gap-2">
                {Object.entries(exitCounts).sort((a, b) => b[1].total - a[1].total).map(([reason, { wins, total, pnl }]) => {
                  const wr = total > 0 ? wins / total * 100 : 0
                  const label = exitReasonLabel(reason) ?? reason
                  return (
                    <div key={reason} className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-28 shrink-0">{label}</span>
                      <div className="flex-1 h-2 bg-white/[0.05] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full opacity-70 ${wr >= 60 ? 'bg-emerald-500' : wr >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${wr}%` }} />
                      </div>
                      <span className={`text-xs font-bold tabular-nums w-10 text-right ${wr >= 60 ? 'text-emerald-400' : wr >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>{wr.toFixed(0)}%</span>
                      <span className={`text-[11px] tabular-nums w-16 text-right ${pnlColor(pnl)}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}</span>
                      <span className="text-[10px] text-slate-600 w-6 text-right">{total}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Row 5 — Per-ticker leaderboard */}
            <div className="border border-white/[0.07] rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
                <Trophy className="w-4 h-4 text-yellow-400" />
                <span className="text-sm font-bold text-white">Per-Ticker Leaderboard</span>
                {bestTicker && <span className="text-[11px] text-emerald-400 ml-auto">Best: {bestTicker[0]}</span>}
                {worstTicker && bestTicker?.[0] !== worstTicker?.[0] && <span className="text-[11px] text-red-400">Worst: {worstTicker[0]}</span>}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                    <th className="text-left px-4 py-2 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Ticker</th>
                    <th className="text-right px-4 py-2 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Trades</th>
                    <th className="text-right px-4 py-2 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">W/L</th>
                    <th className="text-right px-4 py-2 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Win %</th>
                    <th className="text-right px-4 py-2 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {tickerRows.slice(0, 10).map(([ticker, d]) => {
                    const wr = d.trades > 0 ? d.wins / d.trades * 100 : 0
                    return (
                      <tr key={ticker} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                        <td className="px-4 py-2.5 font-bold text-white font-mono">{ticker}</td>
                        <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums">{d.trades}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          <span className="text-emerald-400">{d.wins}W</span>
                          <span className="text-slate-600"> / </span>
                          <span className="text-red-400">{d.losses}L</span>
                        </td>
                        <td className={`px-4 py-2.5 text-right font-bold tabular-nums ${wr >= 60 ? 'text-emerald-400' : wr >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {wr.toFixed(0)}%
                        </td>
                        <td className={`px-4 py-2.5 text-right font-bold tabular-nums ${pnlColor(d.pnl)}`}>
                          {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(0)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Row 6 — Last 20 trades win/loss streak calendar */}
            <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Flame className="w-4 h-4 text-orange-400" />
                <p className="text-sm font-bold text-white">Last 20 Trades</p>
                <span className="text-[11px] text-slate-500 ml-auto">Max loss streak: {maxLossStreak}</span>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {last20.map((t, i) => {
                  const isWin = (t.pnl ?? 0) > 0
                  const pct = t.pnl_pct ?? 0
                  return (
                    <div
                      key={t.id}
                      title={`${t.ticker} ${isWin ? '+' : ''}${pct.toFixed(2)}% — ${t.exit_date ?? t.entry_date}`}
                      className={`w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold border ${isWin ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' : 'bg-red-500/15 border-red-500/30 text-red-400'}`}
                    >
                      {t.ticker.slice(0, 2)}
                    </div>
                  )
                })}
              </div>
              <div className="flex gap-3 mt-2 text-[10px] text-slate-600">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-500/20 border border-emerald-500/30 inline-block" /> Win</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-500/20 border border-red-500/30 inline-block" /> Loss</span>
                <span className="ml-auto">hover for details</span>
              </div>
            </div>

            {/* Feature 6: Time-of-day win rate */}
            {timeOfDayStats.length > 0 && (
              <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Entry Time Win Rate</p>
                <div className="flex gap-2 flex-wrap">
                  {timeOfDayStats.map(b => (
                    <div key={b.label} className="flex flex-col items-center gap-1 flex-1 min-w-[72px] border border-white/[0.07] rounded-xl p-3">
                      <span className="text-[10px] text-slate-500">{b.label}</span>
                      <span className="text-[9px] text-slate-600">{b.range} ET</span>
                      <span className={`text-lg font-bold tabular-nums mt-1 ${b.wr != null && b.wr >= 60 ? 'text-emerald-400' : b.wr != null && b.wr >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {b.wr != null ? `${b.wr.toFixed(0)}%` : '—'}
                      </span>
                      <span className="text-[10px] text-slate-600">{b.total} trades</span>
                      <span className={`text-[10px] tabular-nums ${pnlColor(b.pnl)}`}>{b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(0)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-slate-600 mt-2">Best time to enter = highest win rate window</p>
              </div>
            )}

            {/* Feature 4: MAE / MFE */}
            {(() => {
              const withPeak = closed.filter(t => t.peak_pnl_pct != null && t.pnl_pct != null)
              if (withPeak.length === 0) return null
              // MAE = average worst drawdown reached during the trade (always <= 0)
              const avgMAE = withPeak.reduce((s, t) => s + Math.min(0, t.pnl_pct ?? 0), 0) / withPeak.length
              const avgMFE = withPeak.reduce((s, t) => s + (t.peak_pnl_pct ?? 0), 0) / withPeak.length
              const avgClose = withPeak.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / withPeak.length
              return (
                <div className="grid grid-cols-3 gap-3">
                  <div className="border border-white/[0.07] rounded-xl p-4 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Avg Peak Gain (MFE)</p>
                    <p className="text-xl font-bold text-emerald-400 tabular-nums">{avgMFE.toFixed(2)}%</p>
                    <p className="text-[10px] text-slate-600 mt-1">Max favorable excursion</p>
                  </div>
                  <div className="border border-white/[0.07] rounded-xl p-4 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Avg Close</p>
                    <p className={`text-xl font-bold tabular-nums ${pnlColor(avgClose)}`}>{avgClose >= 0 ? '+' : ''}{avgClose.toFixed(2)}%</p>
                    <p className="text-[10px] text-slate-600 mt-1">Where you exited</p>
                  </div>
                  <div className="border border-white/[0.07] rounded-xl p-4 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">MFE vs Close Gap</p>
                    <p className="text-xl font-bold text-yellow-400 tabular-nums">{(avgMFE - avgClose).toFixed(2)}%</p>
                    <p className="text-[10px] text-slate-600 mt-1">Left on table avg</p>
                  </div>
                </div>
              )
            })()}

            {/* Feature 5: Position size heatmap */}
            {positionSizes.length >= 3 && (
              <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-3">Position Size vs Outcome</p>
                <div className="flex flex-col gap-1.5">
                  {positionSizes.slice(0, 10).map(pos => {
                    const maxSize = positionSizes[0].size
                    const widthPct = (pos.size / maxSize) * 100
                    return (
                      <div key={pos.id} className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-white w-10 shrink-0">{pos.ticker}</span>
                        <div className="flex-1 h-3 bg-white/[0.04] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pos.pnl > 0 ? 'bg-emerald-500/50' : 'bg-red-500/50'}`}
                            style={{ width: `${widthPct}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-slate-500 tabular-nums w-16 text-right">${pos.size.toFixed(0)}</span>
                        <span className={`text-[10px] font-bold tabular-nums w-16 text-right ${pnlColor(pos.pnl)}`}>{pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(0)}</span>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[10px] text-slate-600 mt-2">Bar width = position size. Color = outcome.</p>
              </div>
            )}

            {/* Feature 3: Re-entry detector */}
            {reentryTickers.size > 0 && (
              <div className="border border-yellow-500/20 bg-yellow-500/5 rounded-xl p-4">
                <p className="text-[11px] text-yellow-400 font-bold mb-2 uppercase tracking-wider">⚠️ Re-entry Patterns (3+ trades)</p>
                <div className="flex flex-wrap gap-1.5">
                  {[...reentryTickers].map(ticker => {
                    const count = [...openTrades, ...closedTrades].filter(t => t.ticker === ticker).length
                    const wins = closedTrades.filter(t => t.ticker === ticker && (t.pnl ?? 0) > 0).length
                    const total = closedTrades.filter(t => t.ticker === ticker).length
                    const wr = total > 0 ? (wins / total * 100).toFixed(0) : '?'
                    return (
                      <span key={ticker} className="text-[11px] px-2 py-1 rounded-lg border border-yellow-500/25 text-yellow-300 bg-yellow-500/8 font-mono font-bold">
                        {ticker} ×{count} · {wr}% WR
                      </span>
                    )
                  })}
                </div>
                <p className="text-[10px] text-slate-600 mt-2">Trading same tickers repeatedly. Check if this is a strength or bias.</p>
              </div>
            )}

            {/* Row 7 — Profit efficiency + R stats */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-2">Profit Efficiency</p>
                <p className={`text-2xl font-bold tabular-nums ${avgEff != null ? (avgEff >= 0.7 ? 'text-emerald-400' : avgEff >= 0.4 ? 'text-yellow-400' : 'text-red-400') : 'text-slate-600'}`}>
                  {avgEff != null ? `${(avgEff * 100).toFixed(0)}%` : '—'}
                </p>
                <p className="text-[11px] text-slate-600 mt-1">% of peak gain captured before exit. 70%+ is strong.</p>
              </div>
              <div className="border border-white/[0.07] rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-2">R Distribution</p>
                <div className="flex gap-3 items-end mt-1">
                  {[-3, -2, -1, 0, 1, 2, 3].map(bucket => {
                    const count = rMultiples.filter(r => bucket === -3 ? r < -2 : bucket === 3 ? r >= 2 : Math.floor(r) === bucket).length
                    const maxCount = Math.max(1, ...[-3, -2, -1, 0, 1, 2, 3].map(b =>
                      rMultiples.filter(r => b === -3 ? r < -2 : b === 3 ? r >= 2 : Math.floor(r) === b).length
                    ))
                    const h = count > 0 ? Math.max(8, (count / maxCount) * 48) : 0
                    return (
                      <div key={bucket} className="flex flex-col items-center gap-1 flex-1">
                        <span className="text-[9px] text-slate-600 tabular-nums">{count}</span>
                        <div className="w-full flex items-end justify-center" style={{ height: 48 }}>
                          <div
                            className={`w-full rounded-t ${bucket >= 1 ? 'bg-emerald-500/50' : bucket === 0 ? 'bg-slate-500/50' : 'bg-red-500/50'}`}
                            style={{ height: h }}
                          />
                        </div>
                        <span className={`text-[9px] tabular-nums ${bucket >= 1 ? 'text-emerald-500' : bucket === 0 ? 'text-slate-500' : 'text-red-500'}`}>
                          {bucket === -3 ? '<-2' : bucket === 3 ? '2+' : `${bucket}R`}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

          </div>
        )
      })()}

      {/* Performance */}
      {activeTab === 'performance' && (
        <div className="flex flex-col gap-2">
          {performance.length === 0 ? (
            <div className="border border-white/[0.07] rounded-xl p-10 text-center flex flex-col items-center gap-3">
              <AlertTriangle className="w-8 h-8 text-slate-700" />
              <p className="text-sm text-slate-400">No performance data yet</p>
              <p className="text-xs text-slate-600">Daily summaries appear after first trading day closes.</p>
            </div>
          ) : (
            <div className="border border-white/[0.07] rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/[0.07] bg-white/[0.02]">
                    <th className="text-left px-4 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Date</th>
                    <th className="text-right px-4 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Trades</th>
                    <th className="text-right px-4 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">W / L</th>
                    <th className="text-right px-4 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Win %</th>
                    <th className="text-right px-4 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map(p => (
                    <tr key={p.date} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                      <td className="px-4 py-2.5 text-slate-300 font-mono">{p.date}</td>
                      <td className="px-4 py-2.5 text-right text-white tabular-nums">{p.trades_closed}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        <span className="text-emerald-400">{p.wins}W</span>
                        <span className="text-slate-600"> / </span>
                        <span className="text-red-400">{p.losses}L</span>
                      </td>
                      <td className={`px-4 py-2.5 text-right font-bold tabular-nums ${p.win_rate >= 70 ? 'text-emerald-400' : p.win_rate >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {Number(p.win_rate).toFixed(1)}%
                      </td>
                      <td className={`px-4 py-2.5 text-right font-bold tabular-nums ${pnlColor(p.gross_pnl)}`}>
                        {p.gross_pnl >= 0 ? '+' : ''}${Number(p.gross_pnl).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* #12 — Game Plan tab */}
      {activeTab === 'gameplan' && (
        <div className="flex flex-col gap-3">
          {!premktPlan || premktPlan.picks.length === 0 ? (
            <div className="border border-white/[0.07] rounded-xl p-10 text-center flex flex-col items-center gap-3">
              <Crosshair className="w-8 h-8 text-slate-700" />
              <p className="text-sm text-slate-400">No game plan for today</p>
              <p className="text-xs text-slate-600">Groq builds a pre-market game plan at 8:15am ET each trading day.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 px-1">
                <Crosshair className="w-4 h-4 text-sky-400" />
                <span className="text-sm font-bold text-white">Today&apos;s Game Plan</span>
                <span className="text-xs text-slate-500">{premktPlan.date}</span>
                {premktPlan.outlook_direction && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ml-auto ${premktPlan.outlook_direction === 'bullish' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : premktPlan.outlook_direction === 'bearish' ? 'text-red-400 border-red-500/25 bg-red-500/8' : 'text-slate-400 border-white/10'}`}>
                    {premktPlan.outlook_direction.toUpperCase()} OUTLOOK
                  </span>
                )}
              </div>
              {premktPlan.picks.map((pick, i) => {
                const rrDenom = pick.direction === 'long' ? pick.entry_zone - pick.stop : pick.stop - pick.entry_zone
                const rr = rrDenom > 0
                  ? (pick.direction === 'long' ? pick.target - pick.entry_zone : pick.entry_zone - pick.target) / rrDenom
                  : 0
                const isEntered = openTrades.some(t => t.ticker === pick.ticker)
                // #18 — show TRADED badge + final P&L for picks already closed
                const closedTrade = closedTrades.find(t => t.ticker === pick.ticker)
                return (
                  <div key={i} className={`border rounded-xl p-4 flex flex-col gap-2.5 ${isEntered ? 'border-sky-500/30' : closedTrade ? (closedTrade.pnl ?? 0) > 0 ? 'border-emerald-500/25' : 'border-red-500/20' : 'border-white/[0.07]'}`} style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <div className="flex items-center gap-2.5">
                      <span className="font-bold text-white font-mono">{pick.ticker}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${pick.direction === 'long' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : 'text-red-400 border-red-500/25 bg-red-500/8'}`}>
                        {pick.direction.toUpperCase()}
                      </span>
                      <span className="text-[10px] text-slate-500 border border-white/[0.07] px-1.5 py-0.5 rounded">{pick.trade_type}</span>
                      {isEntered && <span className="text-[10px] text-sky-400 border border-sky-500/20 bg-sky-500/8 px-1.5 py-0.5 rounded">ENTERED</span>}
                      {/* #18 — closed trade badge */}
                      {closedTrade && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${(closedTrade.pnl ?? 0) > 0 ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/8' : 'text-red-400 border-red-500/20 bg-red-500/8'}`}>
                          TRADED {(closedTrade.pnl_pct ?? 0) >= 0 ? '+' : ''}{(closedTrade.pnl_pct ?? 0).toFixed(2)}%
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-500">conviction</span>
                        <span className={`text-sm font-bold ${pick.conviction >= 8 ? 'text-emerald-400' : pick.conviction >= 6 ? 'text-yellow-400' : 'text-slate-400'}`}>{pick.conviction}/10</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs tabular-nums">
                      <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-2 text-center">
                        <p className="text-[10px] text-slate-500 mb-0.5">ENTRY ZONE</p>
                        <p className="font-bold text-white">${pick.entry_zone.toFixed(2)}</p>
                      </div>
                      <div className="bg-red-500/8 border border-red-500/15 rounded-lg p-2 text-center">
                        <p className="text-[10px] text-slate-500 mb-0.5">STOP</p>
                        <p className="font-bold text-red-400">${pick.stop.toFixed(2)}</p>
                      </div>
                      <div className="bg-emerald-500/8 border border-emerald-500/15 rounded-lg p-2 text-center">
                        <p className="text-[10px] text-slate-500 mb-0.5">TARGET</p>
                        <p className="font-bold text-emerald-400">${pick.target.toFixed(2)}</p>
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-500">R:R <span className="text-white font-semibold">{rr > 0 ? rr.toFixed(2) : '—'}:1</span></p>
                    <p className="text-xs text-slate-300 leading-relaxed">{pick.thesis}</p>
                  </div>
                )
              })}

              {/* #15 — Rejected candidates */}
              {premktPlan.rejected_candidates && premktPlan.rejected_candidates.length > 0 && (
                <div className="mt-2">
                  <p className="text-[11px] text-slate-500 uppercase tracking-wider px-1 mb-2">
                    Rejected ({premktPlan.rejected_candidates.length}) — candidates Groq passed on
                  </p>
                  <div className="border border-white/[0.07] rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.05] bg-white/[0.02]">
                          <th className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold uppercase">Ticker</th>
                          <th className="text-right px-3 py-2 text-[10px] text-slate-500 font-semibold uppercase">Score</th>
                          <th className="text-right px-3 py-2 text-[10px] text-slate-500 font-semibold uppercase">Price</th>
                          <th className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold uppercase">Top Signal</th>
                        </tr>
                      </thead>
                      <tbody>
                        {premktPlan.rejected_candidates.slice(0, 10).map((r, i) => (
                          <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="px-3 py-1.5 font-bold text-slate-400 font-mono">{r.ticker}</td>
                            <td className="px-3 py-1.5 text-right text-slate-500 tabular-nums">{r.score.toFixed(1)}</td>
                            <td className="px-3 py-1.5 text-right text-slate-400 tabular-nums">
                              {r.price ? `$${r.price.toFixed(2)}` : '—'}
                              {r.change_pct != null && (
                                <span className={`ml-1 text-[10px] ${r.change_pct >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                  {r.change_pct >= 0 ? '+' : ''}{r.change_pct.toFixed(1)}%
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-slate-500">{r.top_signal.replace(/_/g, ' ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* #14 — Learning tab */}
      {activeTab === 'learning' && (
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2 px-1">
              <Brain className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-bold text-white">Self-Critiques</span>
              <span className="text-xs text-slate-500">Groq&apos;s nightly review of its own decisions</span>
            </div>
            {groqSelfCritiques.length === 0 ? (
              <div className="border border-white/[0.07] rounded-xl p-6 text-center">
                <p className="text-xs text-slate-500">Self-critiques appear after the first trading day closes at 5pm ET.</p>
              </div>
            ) : groqSelfCritiques.map((c, i) => {
              const kf = c.key_factors as Record<string, unknown> | null
              return (
                <div key={i} className="border border-purple-500/20 bg-purple-500/5 rounded-xl p-4 mb-2">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[11px] text-purple-400 font-bold">{c.date}</span>
                    {kf && (
                      <span className="text-[10px] text-slate-500 ml-auto">
                        {String(kf.wins ?? 0)}W/{String(kf.losses ?? 0)}L · {Number(kf.gross_pnl ?? 0) >= 0 ? '+' : ''}${Number(kf.gross_pnl ?? 0).toFixed(0)} P&amp;L
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{c.lesson.slice(0, 800)}{c.lesson.length > 800 ? '…' : ''}</p>
                </div>
              )
            })}
          </div>
          {groqPatterns && (
            <div>
              <div className="flex items-center gap-2 mb-2 px-1">
                <Activity className="w-4 h-4 text-yellow-400" />
                <span className="text-sm font-bold text-white">Pattern Rules</span>
                <span className="text-xs text-slate-500">{groqPatterns.date}</span>
              </div>
              <div className="border border-yellow-500/20 bg-yellow-500/5 rounded-xl p-4">
                <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{groqPatterns.lesson.slice(0, 1000)}</p>
              </div>
            </div>
          )}
          {groqWeekly && (
            <div>
              <div className="flex items-center gap-2 mb-2 px-1">
                <BookOpen className="w-4 h-4 text-sky-400" />
                <span className="text-sm font-bold text-white">Weekly Review</span>
                <span className="text-xs text-slate-500">{groqWeekly.date}</span>
              </div>
              <div className="border border-sky-500/20 bg-sky-500/5 rounded-xl p-4">
                <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{groqWeekly.lesson.slice(0, 1000)}</p>
              </div>
            </div>
          )}
          {!groqPatterns && !groqWeekly && groqSelfCritiques.length === 0 && (
            <div className="border border-white/[0.07] rounded-xl p-10 text-center">
              <p className="text-xs text-slate-500">Learning rules appear after the first week of trading.</p>
            </div>
          )}
        </div>
      )}

      {/* #13 — Re-Evals tab */}
      {activeTab === 'evals' && (
        <div className="flex flex-col gap-2">
          {tradeEvals.length === 0 ? (
            <div className="border border-white/[0.07] rounded-xl p-10 text-center flex flex-col items-center gap-3">
              <Zap className="w-8 h-8 text-slate-700" />
              <p className="text-sm text-slate-400">No re-evaluations yet</p>
              <p className="text-xs text-slate-600">Groq re-evaluates open swing trades every 30 min and logs each hold/exit decision here.</p>
            </div>
          ) : (
            <div className="border border-white/[0.07] rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/[0.07] bg-white/[0.02]">
                    <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Time</th>
                    <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Ticker</th>
                    <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Decision</th>
                    <th className="text-right px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">P&amp;L at eval</th>
                    <th className="text-left px-3 py-2.5 text-[11px] text-slate-500 font-semibold uppercase tracking-wider">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeEvals.map(e => {
                    const isExit = e.decision === 'exit' || e.decision === 'exit_at_open'
                    const evalTime = new Date(e.evaluated_at)
                    return (
                      <tr key={e.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                        <td className="px-3 py-2 text-slate-500 font-mono text-[10px]">
                          {evalTime.toLocaleDateString()} {evalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="px-3 py-2 font-bold text-white font-mono">{e.ticker}</td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${isExit ? 'text-red-400 border-red-500/25 bg-red-500/8' : 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8'}`}>
                            {e.decision.toUpperCase().replace('_', ' ')}
                          </span>
                        </td>
                        <td className={`px-3 py-2 text-right font-bold tabular-nums ${pnlColor(e.pnl_pct_at_eval)}`}>
                          {e.pnl_pct_at_eval >= 0 ? '+' : ''}{Number(e.pnl_pct_at_eval).toFixed(2)}%
                        </td>
                        <td className="px-3 py-2 text-slate-400 max-w-xs truncate">{e.reason || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
