'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Plus, Trash2, TrendingUp, TrendingDown, Loader2, Calculator, X, LayoutGrid, List } from 'lucide-react'

type Position = {
  id: string
  ticker: string
  shares: number
  avg_cost: number
  notes: string | null
  added_at: string
}

const input = 'px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-[#14b8a6]/60'

export default function PortfolioClient({ portfolio: initial, snapshots }: { portfolio: Position[]; snapshots: Record<string, { price: number; change_pct: number }> }) {
  const [portfolio, setPortfolio] = useState(initial)
  const [ticker, setTicker] = useState('')
  const [shares, setShares] = useState('')
  const [avgCost, setAvgCost] = useState('')
  const [notes, setNotes] = useState('')
  const [adding, setAdding] = useState(false)
  const [viewMode, setViewMode] = useState<'list' | 'heatmap'>('list')

  // Size calculator
  const [calcOpen, setCalcOpen] = useState(false)
  const [calcAccount, setCalcAccount] = useState('')
  const [calcRisk, setCalcRisk] = useState('')
  const [calcEntry, setCalcEntry] = useState('')
  const [calcStop, setCalcStop] = useState('')

  const calcResult = useMemo(() => {
    const account = parseFloat(calcAccount)
    const riskPct = parseFloat(calcRisk)
    const entry = parseFloat(calcEntry)
    const stop = parseFloat(calcStop)
    if (!account || !riskPct || !entry || !stop || entry <= 0 || stop <= 0 || entry === stop) return null
    const riskDollar = account * (riskPct / 100)
    const riskPerShare = Math.abs(entry - stop)
    const maxShares = Math.floor(riskDollar / riskPerShare)
    const positionSize = maxShares * entry
    const positionPct = (positionSize / account) * 100
    return { riskDollar, riskPerShare, maxShares, positionSize, positionPct }
  }, [calcAccount, calcRisk, calcEntry, calcStop])

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
    const currentPrice = snap?.price || pos.avg_cost
    totalValue += currentPrice * pos.shares
    totalCost += pos.avg_cost * pos.shares
  }
  const totalPnl = totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0

  // Feature 19: sector concentration warning
  const SECTOR_MAP: Record<string, string> = {
    AAPL: 'Tech', MSFT: 'Tech', NVDA: 'Tech', AMD: 'Tech', META: 'Tech',
    GOOGL: 'Tech', GOOG: 'Tech', AMZN: 'Tech', TSLA: 'Tech', PLTR: 'Tech',
    CRM: 'Tech', NET: 'Tech', CRWD: 'Tech', DDOG: 'Tech', SNOW: 'Tech',
    AVGO: 'Tech', QCOM: 'Tech', TXN: 'Tech', MU: 'Tech', AMAT: 'Tech',
    JPM: 'Finance', GS: 'Finance', MS: 'Finance', BAC: 'Finance', V: 'Finance',
    MA: 'Finance', PYPL: 'Finance', SQ: 'Finance', AXP: 'Finance', WFC: 'Finance',
    JNJ: 'Healthcare', PFE: 'Healthcare', MRNA: 'Healthcare', LLY: 'Healthcare',
    UNH: 'Healthcare', ABBV: 'Healthcare', GILD: 'Healthcare', BMY: 'Healthcare',
    XOM: 'Energy', CVX: 'Energy', COP: 'Energy', OXY: 'Energy', SLB: 'Energy',
    NFLX: 'Media', DIS: 'Media', BA: 'Industrial', CAT: 'Industrial',
    GM: 'Auto', F: 'Auto', RIVN: 'Auto', WMT: 'Retail', COST: 'Retail',
  }
  const sectorGroups = useMemo(() => {
    const groups: Record<string, string[]> = {}
    for (const pos of portfolio) {
      const s = SECTOR_MAP[pos.ticker] ?? null
      if (s) {
        if (!groups[s]) groups[s] = []
        groups[s].push(pos.ticker)
      }
    }
    return Object.entries(groups).filter(([, tickers]) => tickers.length >= 2)
  }, [portfolio])

  // Feature 20: target exit calculator state (per-ticker)
  const [targetPct, setTargetPct] = useState<Record<string, string>>({})

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Portfolio</h1>
          <p className="text-sm text-slate-500 mt-0.5">{portfolio.length} position{portfolio.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {portfolio.length > 0 && (
            <div className="flex bg-white/5 border border-white/10 rounded-xl overflow-hidden">
              <button
                onClick={() => setViewMode('list')}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold ${viewMode === 'list' ? 'bg-[#14b8a6]/15 text-[#14b8a6]' : 'text-slate-400 hover:text-white'}`}
                style={{ transition: 'color 0.15s, background 0.15s' }}
                title="List view"
              >
                <List className="w-3.5 h-3.5" />
                List
              </button>
              <button
                onClick={() => setViewMode('heatmap')}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold ${viewMode === 'heatmap' ? 'bg-[#14b8a6]/15 text-[#14b8a6]' : 'text-slate-400 hover:text-white'}`}
                style={{ transition: 'color 0.15s, background 0.15s' }}
                title="Heat Map view"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                Heat Map
              </button>
            </div>
          )}
          <button
            onClick={() => setCalcOpen(o => !o)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold border rounded-xl ${calcOpen ? 'text-[#14b8a6] border-[#14b8a6]/30 bg-[#14b8a6]/10' : 'text-slate-300 border-white/10 hover:bg-white/5 hover:text-white'}`}
            style={{ transition: 'color 0.15s, background 0.15s' }}
          >
            <Calculator className="w-4 h-4" />
            Size Calculator
          </button>
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
      </div>

      {/* Size Calculator Panel */}
      {calcOpen && (
        <div className="bg-[#14b8a6]/5 border border-[#14b8a6]/20 rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-[#14b8a6] flex items-center gap-2"><Calculator className="w-4 h-4" /> Position Size Calculator</p>
            <button onClick={() => setCalcOpen(false)} className="text-slate-500 hover:text-white" style={{ transition: 'color 0.15s' }}><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Account Size ($)</label>
              <input value={calcAccount} onChange={e => setCalcAccount(e.target.value)} placeholder="50000" type="number" className={input} style={{ fontSize: 16 }} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Risk Per Trade (%)</label>
              <input value={calcRisk} onChange={e => setCalcRisk(e.target.value)} placeholder="1" type="number" step="0.1" className={input} style={{ fontSize: 16 }} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Entry Price ($)</label>
              <input value={calcEntry} onChange={e => setCalcEntry(e.target.value)} placeholder="150.00" type="number" step="0.01" className={input} style={{ fontSize: 16 }} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Stop Loss ($)</label>
              <input value={calcStop} onChange={e => setCalcStop(e.target.value)} placeholder="145.00" type="number" step="0.01" className={input} style={{ fontSize: 16 }} />
            </div>
          </div>
          {calcResult ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
                <p className="text-xs text-slate-500 mb-1">Max Shares</p>
                <p className="text-lg font-bold text-white tabular">{calcResult.maxShares.toLocaleString()}</p>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
                <p className="text-xs text-slate-500 mb-1">Max $ Risk</p>
                <p className="text-lg font-bold text-[#f59e0b] tabular">${calcResult.riskDollar.toFixed(2)}</p>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
                <p className="text-xs text-slate-500 mb-1">Position Size</p>
                <p className="text-lg font-bold text-white tabular">${calcResult.positionSize.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
              </div>
              <div className={`border rounded-xl p-3 text-center ${calcResult.positionPct > 25 ? 'bg-red-500/10 border-red-500/20' : calcResult.positionPct > 10 ? 'bg-yellow-500/10 border-yellow-500/20' : 'bg-green-500/10 border-green-500/20'}`}>
                <p className="text-xs text-slate-500 mb-1">% of Account</p>
                <p className={`text-lg font-bold tabular ${calcResult.positionPct > 25 ? 'text-red-400' : calcResult.positionPct > 10 ? 'text-yellow-400' : 'text-green-400'}`}>{calcResult.positionPct.toFixed(1)}%</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-600 text-center py-2">Fill in all four fields to see position sizing</p>
          )}
        </div>
      )}

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
          className="self-start flex items-center gap-2 px-4 py-2 text-sm font-bold text-black bg-[#14b8a6] rounded-xl disabled:opacity-40 hover:bg-[#2dd4bf] active:scale-[0.98]"
          style={{ transition: 'background 0.15s, transform 0.1s' }}
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {adding ? 'Adding...' : 'Add Position'}
        </button>
      </div>

      {/* Feature 19: sector concentration warning */}
      {sectorGroups.length > 0 && (
        <div className="flex flex-col gap-1.5 px-4 py-3 border border-yellow-500/25 bg-yellow-500/8 rounded-xl text-xs">
          <p className="font-bold text-yellow-400 flex items-center gap-1.5">
            ⚠️ Sector Concentration Risk
          </p>
          {sectorGroups.map(([sector, tickers]) => (
            <p key={sector} className="text-yellow-300/80">
              <span className="font-semibold">{sector}:</span> {tickers.join(', ')} — {tickers.length} positions. Consider reducing exposure.
            </p>
          ))}
        </div>
      )}

      {/* Heat Map View */}
      {viewMode === 'heatmap' && portfolio.length > 0 && (
        <HeatMapView portfolio={portfolio} snapshots={snapshots} />
      )}

      {/* Positions List */}
      <div className={`flex flex-col gap-2 ${viewMode === 'heatmap' ? 'hidden' : ''}`}>
        {portfolio.length === 0 && (
          <div className="text-center py-16 text-slate-500 text-sm">No positions yet — add one above</div>
        )}
        {portfolio.map(pos => {
          const snap = snapshots[pos.ticker]
          const currentPrice = snap?.price || pos.avg_cost
          const pnl = (currentPrice - pos.avg_cost) * pos.shares
          const pnlPct = ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100
          const value = currentPrice * pos.shares
          const isUp = pnl >= 0

          return (
            <div key={pos.id} className="relative flex items-center gap-3 sm:gap-4 px-3 sm:px-5 py-4 bg-white/4 border border-white/10 rounded-2xl hover:border-white/20" style={{ transition: 'border-color 0.15s' }}>
              <Link href={`/portfolio/${pos.ticker}`} className="absolute inset-0 rounded-2xl z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6]/60" aria-label={`View ${pos.ticker} detail`} />
              <div className={`relative z-10 w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isUp ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                {isUp ? <TrendingUp className="w-4 h-4 text-green-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
              </div>
              <div className="relative z-10 flex-1 min-w-0">
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
                {/* Break-even info */}
                <p className="text-[11px] text-slate-600 mt-0.5">
                  Cost: ${(pos.avg_cost * pos.shares).toFixed(0)} ·
                  Break-even: ${pos.avg_cost.toFixed(2)} ·
                  <span className={pnl >= 0 ? ' text-emerald-500/70' : ' text-red-500/70'}>
                    {pnl >= 0 ? ` $${Math.abs(currentPrice - pos.avg_cost).toFixed(2)}/sh above` : ` $${Math.abs(currentPrice - pos.avg_cost).toFixed(2)}/sh below`}
                  </span>
                </p>
                {/* Feature 20: target exit calculator */}
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] text-slate-600">Exit at</span>
                  <input
                    type="number"
                    placeholder="5"
                    value={targetPct[pos.id] ?? ''}
                    onChange={e => setTargetPct(p => ({ ...p, [pos.id]: e.target.value }))}
                    onClick={e => e.stopPropagation()}
                    className="w-12 px-1.5 py-0.5 text-[10px] bg-white/[0.04] border border-white/[0.08] rounded text-white focus:outline-none focus:border-sky-500/40 tabular-nums"
                  />
                  <span className="text-[10px] text-slate-600">% gain →</span>
                  {targetPct[pos.id] && (() => {
                    const pct = parseFloat(targetPct[pos.id])
                    if (isNaN(pct)) return null
                    const exitPrice = pos.avg_cost * (1 + pct / 100)
                    const gain = (exitPrice - pos.avg_cost) * pos.shares
                    return (
                      <span className="text-[10px] text-emerald-400 tabular-nums font-semibold">
                        ${exitPrice.toFixed(2)} (+${gain.toFixed(0)})
                      </span>
                    )
                  })()}
                </div>
                {pos.notes && <p className="text-xs text-slate-600 mt-0.5">{pos.notes}</p>}
              </div>
              <div className="relative z-10 text-right shrink-0">
                <p className="text-sm font-bold text-white tabular">${value.toFixed(2)}</p>
                <p className={`text-xs font-semibold tabular ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                  {isUp ? '+' : ''}${pnl.toFixed(2)} ({isUp ? '+' : ''}{pnlPct.toFixed(2)}%)
                </p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); remove(pos.id) }}
                className="relative z-10 p-2 text-slate-600 hover:text-red-400 shrink-0"
                style={{ transition: 'color 0.15s' }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function getHeatMapClasses(changePct: number | undefined): string {
  if (changePct === undefined) return 'bg-white/4 border-white/10'
  if (changePct > 3) return 'bg-[#22c55e]/25 border-[#22c55e]/30'
  if (changePct > 1) return 'bg-[#22c55e]/12 border-[#22c55e]/20'
  if (changePct > 0) return 'bg-[#22c55e]/6 border-[#22c55e]/10'
  if (changePct > -1) return 'bg-[#ef4444]/6 border-[#ef4444]/10'
  if (changePct > -3) return 'bg-[#ef4444]/12 border-[#ef4444]/20'
  return 'bg-[#ef4444]/25 border-[#ef4444]/30'
}

function getHeatMapColSpan(value: number): string {
  if (value >= 10000) return 'col-span-2 row-span-2'
  if (value >= 5000) return 'col-span-2'
  return ''
}

function HeatMapView({
  portfolio,
  snapshots,
}: {
  portfolio: Position[]
  snapshots: Record<string, { price: number; change_pct: number }>
}) {
  const positions = portfolio.map(pos => {
    const snap = snapshots[pos.ticker]
    const currentPrice = snap?.price || pos.avg_cost
    const value = currentPrice * pos.shares
    const dayDollarPnl = snap?.change_pct != null
      ? pos.shares * currentPrice * (snap.change_pct / 100)
      : null
    return { pos, snap, currentPrice, value, dayDollarPnl }
  }).sort((a, b) => b.value - a.value)

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2" style={{ gridAutoRows: '120px' }}>
        {positions.map(({ pos, snap, currentPrice, value, dayDollarPnl }) => {
          const changePct = snap?.change_pct
          const colorClasses = getHeatMapClasses(changePct)
          const spanClasses = getHeatMapColSpan(value)
          const isLarge = value >= 10000
          const isMedium = value >= 5000 && value < 10000

          return (
            <Link
              key={pos.id}
              href={`/portfolio/${pos.ticker}`}
              className={`relative border rounded-xl p-3 flex flex-col justify-between overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6]/60 ${colorClasses} ${spanClasses}`}
              style={{ transitionProperty: 'filter', transitionDuration: '0.15s' }}
            >
              <div>
                <p className={`font-mono font-bold text-white leading-none ${isLarge ? 'text-2xl' : isMedium ? 'text-xl' : 'text-base'}`}>
                  {pos.ticker}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">${currentPrice.toFixed(2)}</p>
              </div>
              <div>
                {changePct != null ? (
                  <>
                    <p className={`font-bold tabular leading-none ${isLarge ? 'text-xl' : 'text-sm'} ${changePct >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                      {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
                    </p>
                    {dayDollarPnl != null && (
                      <p className={`text-xs tabular mt-0.5 ${dayDollarPnl >= 0 ? 'text-[#22c55e]/80' : 'text-[#ef4444]/80'}`}>
                        {dayDollarPnl >= 0 ? '+' : ''}${dayDollarPnl.toFixed(0)}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-slate-600">No data</p>
                )}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
