'use client'

import { useState } from 'react'
import { Signal } from '@/app/components/SignalCard'
import SignalCard from '@/app/components/SignalCard'
import { Search, Flame } from 'lucide-react'

export default function ScannerClient({ signals }: { signals: Signal[] }) {
  const [search, setSearch] = useState('')
  const [minSeverity, setMinSeverity] = useState(5)

  // Group by ticker — find tickers with multiple signals (convergence)
  const tickerMap: Record<string, Signal[]> = {}
  for (const s of signals) {
    if (!tickerMap[s.ticker]) tickerMap[s.ticker] = []
    tickerMap[s.ticker].push(s)
  }

  // Sort tickers by total severity score (convergence)
  const ranked = Object.entries(tickerMap)
    .map(([ticker, sigs]) => ({
      ticker,
      signals: sigs,
      score: sigs.reduce((acc, s) => acc + s.severity, 0),
      maxSeverity: Math.max(...sigs.map(s => s.severity)),
      count: sigs.length,
    }))
    .filter(t => t.maxSeverity >= minSeverity)
    .filter(t => search ? t.ticker.includes(search.toUpperCase()) : true)
    .sort((a, b) => b.score - a.score)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Opportunity Scanner</h1>
        <p className="text-sm text-slate-500 mt-0.5">Last 24 hours — ranked by signal convergence</p>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative flex-1 min-w-[140px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search ticker..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/60 font-mono"
            style={{ fontSize: 16 }}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 whitespace-nowrap">Min severity</span>
          {[5, 7, 9].map(v => (
            <button
              key={v}
              onClick={() => setMinSeverity(v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${minSeverity === v ? 'bg-[#0ea5e9]/15 border-[#0ea5e9]/40 text-[#0ea5e9]' : 'border-white/10 text-slate-500 hover:text-white'}`}
              style={{ transition: 'color 0.15s, background 0.15s' }}
            >{v}+</button>
          ))}
        </div>
      </div>

      {/* Hot tickers */}
      {ranked.length === 0 ? (
        <div className="text-center py-24 text-slate-500 text-sm">No signals in the last 24 hours matching your filters</div>
      ) : (
        <div className="flex flex-col gap-6">
          {ranked.map(({ ticker, signals: sigs, score, count }) => (
            <div key={ticker} className="flex flex-col gap-3">
              {/* Ticker header */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl">
                  <Flame className={`w-4 h-4 ${score >= 30 ? 'text-red-400' : score >= 20 ? 'text-orange-400' : 'text-yellow-400'}`} />
                  <span className="text-sm font-bold text-white font-mono">{ticker}</span>
                  <span className="text-xs text-slate-500">{count} signal{count > 1 ? 's' : ''}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${score >= 30 ? 'bg-red-500/20 text-red-400' : score >= 20 ? 'bg-orange-500/20 text-orange-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                    Score {score}
                  </span>
                </div>
                {count >= 2 && (
                  <span className="text-xs text-orange-400 font-semibold">⚡ Multi-signal convergence</span>
                )}
              </div>
              {/* Signals for this ticker */}
              <div className="flex flex-col gap-2 pl-2">
                {sigs.slice(0, 3).map(s => <SignalCard key={s.id} signal={s} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
