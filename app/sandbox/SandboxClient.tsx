'use client'

import { useState, useMemo } from 'react'
import { FlaskConical, TrendingUp, TrendingDown, Target, AlertTriangle, Clock, BarChart2, Brain } from 'lucide-react'

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
  return v >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'
}

function directionBadge(d: string) {
  return d === 'long'
    ? 'bg-[#22c55e]/10 border-[#22c55e]/20 text-[#22c55e]'
    : 'bg-[#ef4444]/10 border-[#ef4444]/20 text-[#ef4444]'
}

function exitReasonLabel(r: string | null) {
  if (!r) return '—'
  return {
    target_hit: '🎯 Target hit',
    stop_hit: '🛑 Stop hit',
    groq_exit: '🤖 Groq exited',
    day_close: '📅 Day close',
    max_hold: '⏰ Max hold',
  }[r] ?? r
}

function TradeRow({ trade, expanded, onToggle }: { trade: SandboxTrade; expanded: boolean; onToggle: () => void }) {
  const isOpen = trade.status === 'open'
  const pnl = trade.pnl_pct

  return (
    <div
      className={`border rounded-2xl overflow-hidden cursor-pointer ${isOpen ? 'border-[#0ea5e9]/20 bg-[#0ea5e9]/3' : pnl != null && pnl >= 0 ? 'border-[#22c55e]/20 bg-[#22c55e]/3' : 'border-[#ef4444]/20 bg-[#ef4444]/3'}`}
      onClick={onToggle}
    >
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        {/* Direction icon */}
        <div className="shrink-0">
          {trade.direction === 'long'
            ? <TrendingUp className="w-4 h-4 text-[#22c55e]" />
            : <TrendingDown className="w-4 h-4 text-[#ef4444]" />}
        </div>

        {/* Ticker + badges */}
        <span className="font-bold text-sm text-white font-mono">{trade.ticker}</span>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${directionBadge(trade.direction)}`}>
          {trade.direction.toUpperCase()}
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 text-slate-400">
          {trade.trade_type}
        </span>
        {isOpen && (
          <span className="text-xs px-2 py-0.5 rounded-full border border-[#0ea5e9]/20 text-[#0ea5e9] bg-[#0ea5e9]/10 animate-pulse">
            OPEN
          </span>
        )}

        {/* Entry info */}
        <span className="text-xs text-slate-500 ml-1">
          Entry ${Number(trade.entry_price).toFixed(2)} · {trade.entry_date}
        </span>

        {/* P&L */}
        <span className={`text-sm font-bold tabular-nums ml-auto ${pnlColor(pnl)}`}>
          {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : 'Open'}
        </span>
        {trade.pnl != null && (
          <span className={`text-xs tabular-nums ${pnlColor(trade.pnl)}`}>
            ({trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)})
          </span>
        )}

        {/* Exit reason */}
        {trade.exit_reason && (
          <span className="text-xs text-slate-500">{exitReasonLabel(trade.exit_reason)}</span>
        )}
      </div>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-white/5 pt-3">
          {/* Levels */}
          <div className="flex gap-4 flex-wrap text-xs tabular-nums">
            <div>
              <span className="text-slate-500">Stop </span>
              <span className="text-[#ef4444] font-semibold">${Number(trade.stop_loss).toFixed(2)}</span>
            </div>
            <div>
              <span className="text-slate-500">Target </span>
              <span className="text-[#22c55e] font-semibold">${Number(trade.target_price).toFixed(2)}</span>
            </div>
            {trade.exit_price != null && (
              <div>
                <span className="text-slate-500">Exit </span>
                <span className="text-white font-semibold">${Number(trade.exit_price).toFixed(2)}</span>
              </div>
            )}
            <div>
              <span className="text-slate-500">Shares </span>
              <span className="text-white">{trade.shares}</span>
            </div>
          </div>

          {/* Thesis */}
          {trade.groq_thesis && (
            <div>
              <p className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                <Brain className="w-3 h-3" /> Groq thesis
              </p>
              <p className="text-xs text-slate-300 leading-relaxed">{trade.groq_thesis}</p>
            </div>
          )}

          {/* Exit note */}
          {trade.groq_exit_note && (
            <div>
              <p className="text-xs text-slate-500 mb-1">Exit note</p>
              <p className="text-xs text-slate-400 leading-relaxed">{trade.groq_exit_note}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function SandboxClient({
  openTrades,
  closedTrades,
  performance,
}: {
  openTrades: SandboxTrade[]
  closedTrades: SandboxTrade[]
  performance: Performance[]
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'open' | 'closed' | 'performance'>('open')

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

  const winRateColor = stats.winRate >= 70 ? 'text-[#22c55e]' : stats.winRate >= 50 ? 'text-[#f59e0b]' : 'text-[#ef4444]'

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center shrink-0">
          <FlaskConical className="w-4 h-4 text-purple-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">Groq Sandbox</h1>
          <p className="text-xs text-slate-500">Paper trading engine — learning to reach 70% win rate</p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white/2 border border-white/8 rounded-2xl p-4 flex flex-col gap-1">
          <p className="text-xs text-slate-500">Win Rate</p>
          <p className={`text-2xl font-bold tabular-nums ${winRateColor}`}>{stats.winRate.toFixed(1)}%</p>
          <p className="text-xs text-slate-600">Goal: 70%</p>
        </div>
        <div className="bg-white/2 border border-white/8 rounded-2xl p-4 flex flex-col gap-1">
          <p className="text-xs text-slate-500">Total Trades</p>
          <p className="text-2xl font-bold text-white tabular-nums">{stats.total}</p>
          <p className="text-xs text-slate-600">{stats.wins}W · {stats.losses}L</p>
        </div>
        <div className="bg-white/2 border border-white/8 rounded-2xl p-4 flex flex-col gap-1">
          <p className="text-xs text-slate-500">Gross P&L</p>
          <p className={`text-2xl font-bold tabular-nums ${pnlColor(stats.grossPnl)}`}>
            {stats.grossPnl >= 0 ? '+' : ''}${stats.grossPnl.toFixed(0)}
          </p>
          <p className="text-xs text-slate-600">paper money</p>
        </div>
        <div className="bg-white/2 border border-white/8 rounded-2xl p-4 flex flex-col gap-1">
          <p className="text-xs text-slate-500">Avg Win / Loss</p>
          <p className="text-sm font-bold text-white tabular-nums">
            <span className="text-[#22c55e]">{stats.avgWin >= 0 ? '+' : ''}{stats.avgWin.toFixed(1)}%</span>
            {' / '}
            <span className="text-[#ef4444]">{stats.avgLoss.toFixed(1)}%</span>
          </p>
          <p className="text-xs text-slate-600">
            R:R {stats.avgLoss !== 0 ? Math.abs(stats.avgWin / stats.avgLoss).toFixed(2) : '—'}
          </p>
        </div>
      </div>

      {/* Progress to 70% goal */}
      <div className="bg-white/2 border border-white/8 rounded-2xl p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500 flex items-center gap-1"><Target className="w-3 h-3" /> Progress to 70% win rate goal</span>
          <span className={`text-xs font-bold ${winRateColor}`}>{stats.winRate.toFixed(1)}% / 70%</span>
        </div>
        <div className="h-2 bg-white/5 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${stats.winRate >= 70 ? 'bg-[#22c55e]' : stats.winRate >= 50 ? 'bg-[#f59e0b]' : 'bg-[#ef4444]'}`}
            style={{ width: `${Math.min(100, (stats.winRate / 70) * 100).toFixed(1)}%`, transition: 'width 0.4s' }}
          />
        </div>
        {stats.total < 10 && (
          <p className="text-xs text-slate-600">Need at least 10 trades for a meaningful win rate. Currently {stats.total}.</p>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/3 border border-white/8 rounded-2xl p-1">
        {(['open', 'closed', 'performance'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-medium capitalize ${activeTab === tab ? 'bg-[#0ea5e9]/15 text-[#0ea5e9] border border-[#0ea5e9]/20' : 'text-slate-500 hover:text-white hover:bg-white/5'}`}
            style={{ transition: 'background 0.15s, color 0.15s' }}
          >
            {tab === 'open' ? `Open (${openTrades.length})` : tab === 'closed' ? `Closed (${closedTrades.length})` : 'Performance'}
          </button>
        ))}
      </div>

      {/* Open positions */}
      {activeTab === 'open' && (
        <div className="flex flex-col gap-3">
          {openTrades.length === 0 ? (
            <div className="bg-white/2 border border-white/8 rounded-2xl p-8 text-center flex flex-col items-center gap-3">
              <Clock className="w-8 h-8 text-slate-700" />
              <div>
                <p className="text-sm text-slate-400 font-medium">No open positions</p>
                <p className="text-xs text-slate-600 mt-1">Groq scans for entries at 9:30am ET on weekdays.</p>
              </div>
            </div>
          ) : (
            openTrades.map(t => (
              <TradeRow
                key={t.id}
                trade={t}
                expanded={expandedId === t.id}
                onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
              />
            ))
          )}
        </div>
      )}

      {/* Closed trades */}
      {activeTab === 'closed' && (
        <div className="flex flex-col gap-3">
          {closedTrades.length === 0 ? (
            <div className="bg-white/2 border border-white/8 rounded-2xl p-8 text-center flex flex-col items-center gap-3">
              <BarChart2 className="w-8 h-8 text-slate-700" />
              <div>
                <p className="text-sm text-slate-400 font-medium">No closed trades yet</p>
                <p className="text-xs text-slate-600 mt-1">Trades close at their stop, target, or end of day.</p>
              </div>
            </div>
          ) : (
            closedTrades.map(t => (
              <TradeRow
                key={t.id}
                trade={t}
                expanded={expandedId === t.id}
                onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
              />
            ))
          )}
        </div>
      )}

      {/* Performance history */}
      {activeTab === 'performance' && (
        <div className="flex flex-col gap-3">
          {performance.length === 0 ? (
            <div className="bg-white/2 border border-white/8 rounded-2xl p-8 text-center flex flex-col items-center gap-3">
              <AlertTriangle className="w-8 h-8 text-slate-700" />
              <div>
                <p className="text-sm text-slate-400 font-medium">No performance data yet</p>
                <p className="text-xs text-slate-600 mt-1">Daily summaries appear after the first trading day.</p>
              </div>
            </div>
          ) : (
            <div className="bg-white/2 border border-white/8 rounded-2xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Date</th>
                    <th className="text-right px-4 py-3 text-slate-500 font-medium">Trades</th>
                    <th className="text-right px-4 py-3 text-slate-500 font-medium">W/L</th>
                    <th className="text-right px-4 py-3 text-slate-500 font-medium">Win Rate</th>
                    <th className="text-right px-4 py-3 text-slate-500 font-medium">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map(p => (
                    <tr key={p.date} className="border-b border-white/3 hover:bg-white/2">
                      <td className="px-4 py-2.5 text-slate-300 font-mono">{p.date}</td>
                      <td className="px-4 py-2.5 text-right text-white">{p.trades_closed}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-[#22c55e]">{p.wins}W</span>
                        {' / '}
                        <span className="text-[#ef4444]">{p.losses}L</span>
                      </td>
                      <td className={`px-4 py-2.5 text-right font-bold tabular-nums ${p.win_rate >= 70 ? 'text-[#22c55e]' : p.win_rate >= 50 ? 'text-[#f59e0b]' : 'text-[#ef4444]'}`}>
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
