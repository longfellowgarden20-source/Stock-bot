'use client'

import { useState, useMemo, useEffect } from 'react'
import Link from 'next/link'
import { FlaskConical, TrendingUp, TrendingDown, Target, AlertTriangle, Clock, BarChart2, Brain, ChevronDown, ChevronUp, CheckCircle2, XCircle, ArrowUpRight, Crosshair, BookOpen, Activity, Zap } from 'lucide-react'

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

        {/* Badges */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${trade.direction === 'long' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : 'text-red-400 border-red-500/25 bg-red-500/8'}`}>
            {trade.direction.toUpperCase()}
          </span>
          <span className="text-[10px] text-slate-500 border border-white/[0.07] px-1.5 py-0.5 rounded">
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
          {isClosed && <QualityBadge score={computeTradeQuality(trade).score} />}
        </div>

        {/* Entry date */}
        <span className="text-[11px] text-slate-600 hidden sm:block">{trade.entry_date}</span>

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
              ${trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(0)}
            </span>
          )}
          {isOpen && livePrice != null && trade.pnl == null && (() => {
            const entry = Number(trade.entry_price)
            const dollarPnl = trade.direction === 'long'
              ? (livePrice - entry) * Number(trade.shares || 1)
              : (entry - livePrice) * Number(trade.shares || 1)
            return (
              <span className={`text-xs tabular-nums ${pnlColor(dollarPnl)}`}>
                ${dollarPnl >= 0 ? '+' : ''}{dollarPnl.toFixed(0)}
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

          {/* Exit note */}
          {trade.groq_exit_note && (
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Exit note</p>
              <p className="text-xs text-slate-400 leading-relaxed">{trade.groq_exit_note}</p>
            </div>
          )}

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

type PremktPlan = {
  date: string
  picks: PremktPick[]
  outlook_direction: string | null
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

function EquityCurve({ equity, starting }: { equity: EquityPoint[]; starting: number }) {
  if (equity.length < 2) return (
    <div className="h-24 flex items-center justify-center text-xs text-slate-600">
      Equity curve appears after first closed trade
    </div>
  )

  const balances = equity.map(e => e.balance)
  const minB = Math.min(...balances, starting * 0.95)
  const maxB = Math.max(...balances, starting * 1.05)
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

        {/* Line */}
        <polyline points={points} fill="none" stroke={isUp ? '#10b981' : '#ef4444'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

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
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'open' | 'closed' | 'performance' | 'gameplan' | 'learning' | 'evals'>('open')
  const [livePrices, setLivePrices] = useState<Record<string, number>>({})
  const [liveMode, setLiveMode] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [resetting, setResetting] = useState(false)

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

  function fetchAllPrices() {
    if (openTrades.length === 0) return
    const uniqueTickers = [...new Set(openTrades.map(t => t.ticker))]
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

  const starting = account?.starting_balance ?? 50000
  const balance = account?.balance ?? starting
  const peak = account?.peak_balance ?? starting
  const totalPnl = balance - starting
  const totalPnlPct = (totalPnl / starting) * 100
  const drawdown = peak > 0 ? ((peak - balance) / peak) * 100 : 0
  const winRate = account && account.total_trades > 0
    ? (account.winning_trades / account.total_trades) * 100
    : 0
  const confThreshold = winRate < 40 ? 70 : winRate < 50 ? 60 : winRate >= 65 ? 45 : 50

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
    return { wins, losses, total, winRate, grossPnl, avgWin, avgLoss }
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
        <EquityCurve equity={equity} starting={starting} />

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
            <TradeRow key={t.id} trade={t} expanded={expandedId === t.id} onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)} preloadedPrice={livePrices[t.ticker] ?? null} />
          ))}
        </div>
      )}

      {/* Closed */}
      {activeTab === 'closed' && (
        <div className="flex flex-col gap-2">
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
                return (
                  <div key={i} className={`border rounded-xl p-4 flex flex-col gap-2.5 ${isEntered ? 'border-sky-500/30' : 'border-white/[0.07]'}`} style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <div className="flex items-center gap-2.5">
                      <span className="font-bold text-white font-mono">{pick.ticker}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${pick.direction === 'long' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : 'text-red-400 border-red-500/25 bg-red-500/8'}`}>
                        {pick.direction.toUpperCase()}
                      </span>
                      <span className="text-[10px] text-slate-500 border border-white/[0.07] px-1.5 py-0.5 rounded">{pick.trade_type}</span>
                      {isEntered && <span className="text-[10px] text-sky-400 border border-sky-500/20 bg-sky-500/8 px-1.5 py-0.5 rounded">ENTERED</span>}
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
