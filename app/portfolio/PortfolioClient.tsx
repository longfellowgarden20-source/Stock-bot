'use client'

import { useState } from 'react'
import { Plus, Trash2, TrendingUp, TrendingDown, Loader2 } from 'lucide-react'

type Position = {
  id: string
  ticker: string
  shares: number
  avg_cost: number
  notes: string | null
  added_at: string
}

const input = 'px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/60'

export default function PortfolioClient({ portfolio: initial, snapshots }: { portfolio: Position[]; snapshots: Record<string, { price: number; change_pct: number }> }) {
  const [portfolio, setPortfolio] = useState(initial)
  const [ticker, setTicker] = useState('')
  const [shares, setShares] = useState('')
  const [avgCost, setAvgCost] = useState('')
  const [notes, setNotes] = useState('')
  const [adding, setAdding] = useState(false)

  const add = async () => {
    if (!ticker.trim() || !shares || !avgCost) return
    setAdding(true)
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: ticker.toUpperCase().trim(), shares: parseFloat(shares), avg_cost: parseFloat(avgCost), notes }),
    })
    const data = await res.json()
    if (res.ok) {
      setPortfolio(p => [data, ...p])
      setTicker(''); setShares(''); setAvgCost(''); setNotes('')
    }
    setAdding(false)
  }

  const remove = async (id: string) => {
    await fetch(`/api/portfolio?id=${id}`, { method: 'DELETE' })
    setPortfolio(p => p.filter(x => x.id !== id))
  }

  // Total P&L
  let totalValue = 0
  let totalCost = 0
  for (const pos of portfolio) {
    const snap = snapshots[pos.ticker]
    const currentPrice = snap?.price ?? pos.avg_cost
    totalValue += currentPrice * pos.shares
    totalCost += pos.avg_cost * pos.shares
  }
  const totalPnl = totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Portfolio</h1>
          <p className="text-sm text-slate-500 mt-0.5">{portfolio.length} position{portfolio.length !== 1 ? 's' : ''}</p>
        </div>
        {portfolio.length > 0 && (
          <div className="flex flex-col items-end gap-1">
            <p className="text-xs text-slate-500">Total P&L</p>
            <p className={`text-2xl font-bold tabular ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </p>
            <p className={`text-xs font-semibold ${totalPnlPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%
            </p>
          </div>
        )}
      </div>

      {/* Add position */}
      <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
        <p className="text-sm font-semibold text-white">Add Position</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="TSLA" className={`${input} font-mono font-bold`} style={{ fontSize: 16 }} />
          <input value={shares} onChange={e => setShares(e.target.value)} placeholder="Shares" type="number" className={input} style={{ fontSize: 16 }} />
          <input value={avgCost} onChange={e => setAvgCost(e.target.value)} placeholder="Avg cost $" type="number" className={input} style={{ fontSize: 16 }} />
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes" className={input} style={{ fontSize: 16 }} />
        </div>
        <button
          onClick={add}
          disabled={adding || !ticker.trim() || !shares || !avgCost}
          className="self-start flex items-center gap-2 px-4 py-2 text-sm font-bold text-black bg-[#0ea5e9] rounded-xl disabled:opacity-40 hover:bg-[#38bdf8] active:scale-[0.98]"
          style={{ transition: 'background 0.15s, transform 0.1s' }}
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {adding ? 'Adding...' : 'Add Position'}
        </button>
      </div>

      {/* Positions */}
      <div className="flex flex-col gap-2">
        {portfolio.length === 0 && (
          <div className="text-center py-16 text-slate-500 text-sm">No positions yet — add one above</div>
        )}
        {portfolio.map(pos => {
          const snap = snapshots[pos.ticker]
          const currentPrice = snap?.price ?? pos.avg_cost
          const pnl = (currentPrice - pos.avg_cost) * pos.shares
          const pnlPct = ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100
          const value = currentPrice * pos.shares
          const isUp = pnl >= 0

          return (
            <div key={pos.id} className="flex items-center gap-4 px-5 py-4 bg-white/4 border border-white/10 rounded-2xl hover:border-white/20" style={{ transition: 'border-color 0.15s' }}>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isUp ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                {isUp ? <TrendingUp className="w-4 h-4 text-green-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white font-mono">{pos.ticker}</span>
                  {snap?.change_pct != null && (
                    <span className={`text-xs font-semibold tabular ${snap.change_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {snap.change_pct >= 0 ? '+' : ''}{snap.change_pct.toFixed(2)}% today
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {pos.shares} shares @ ${pos.avg_cost.toFixed(2)} avg · Current: ${currentPrice.toFixed(2)}
                </p>
                {pos.notes && <p className="text-xs text-slate-600 mt-0.5">{pos.notes}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold text-white tabular">${value.toFixed(2)}</p>
                <p className={`text-xs font-semibold tabular ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                  {isUp ? '+' : ''}${pnl.toFixed(2)} ({isUp ? '+' : ''}{pnlPct.toFixed(2)}%)
                </p>
              </div>
              <button onClick={() => remove(pos.id)} className="text-slate-600 hover:text-red-400 shrink-0" style={{ transition: 'color 0.15s' }}>
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
