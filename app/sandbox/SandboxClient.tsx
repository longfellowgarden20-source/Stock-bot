'use client'

import { useState, useMemo, useEffect } from 'react'
import Link from 'next/link'
import { FlaskConical, TrendingUp, TrendingDown, Target, AlertTriangle, Clock, BarChart2, Brain, ChevronDown, ChevronUp, CheckCircle2, XCircle, ArrowUpRight } from 'lucide-react'

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
}: {
  openTrades: SandboxTrade[]
  closedTrades: SandboxTrade[]
  performance: Performance[]
  account: Account | null
  equity: EquityPoint[]
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'open' | 'closed' | 'performance'>('open')
  const [livePrices, setLivePrices] = useState<Record<string, number>>({})

  // Fetch current prices for all open trades on mount
  useEffect(() => {
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
    })
  }, [openTrades])

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
      <div className="flex border-b border-white/[0.07]">
        {(['open', 'closed', 'performance'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px ${activeTab === tab ? 'border-sky-400 text-sky-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
            style={{ transition: 'color 0.1s' }}
          >
            {tab === 'open' ? `Open (${openTrades.length})` : tab === 'closed' ? `Closed (${closedTrades.length})` : 'Performance'}
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
    </div>
  )
}
