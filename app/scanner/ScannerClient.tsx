'use client'

import { useState, useMemo } from 'react'
import { Signal } from '@/app/components/SignalCard'
import SignalCard from '@/app/components/SignalCard'
import { Search, Flame, Clock } from 'lucide-react'

// Feature 11: Sector mapping
const SECTOR_MAP: Record<string, string> = {
  AAPL: 'Tech', MSFT: 'Tech', NVDA: 'Tech', AMD: 'Tech', META: 'Tech',
  GOOGL: 'Tech', GOOG: 'Tech', AMZN: 'Tech', TSLA: 'Tech', PLTR: 'Tech',
  CRM: 'Tech', ORCL: 'Tech', ADBE: 'Tech', INTC: 'Tech', MDB: 'Tech',
  DELL: 'Tech', SNOW: 'Tech', NET: 'Tech', CRWD: 'Tech', DDOG: 'Tech',
  NOW: 'Tech', WDAY: 'Tech', SHOP: 'Tech', ARM: 'Tech', AVGO: 'Tech',
  QCOM: 'Tech', TXN: 'Tech', MU: 'Tech', AMAT: 'Tech', KLAC: 'Tech',
  JPM: 'Finance', GS: 'Finance', MS: 'Finance', BAC: 'Finance', WFC: 'Finance',
  V: 'Finance', MA: 'Finance', PYPL: 'Finance', SQ: 'Finance', AXP: 'Finance',
  JNJ: 'Healthcare', PFE: 'Healthcare', MRNA: 'Healthcare', ABBV: 'Healthcare',
  UNH: 'Healthcare', LLY: 'Healthcare', BMY: 'Healthcare', GILD: 'Healthcare',
  XOM: 'Energy', CVX: 'Energy', COP: 'Energy', OXY: 'Energy', SLB: 'Energy',
  AMGN: 'Healthcare', BIIB: 'Healthcare', REGN: 'Healthcare', VRTX: 'Healthcare',
  NFLX: 'Media', DIS: 'Media', PARA: 'Media', WBD: 'Media',
  BA: 'Industrial', CAT: 'Industrial', GE: 'Industrial', HON: 'Industrial',
  TSLA2: 'Auto', GM: 'Auto', F: 'Auto', RIVN: 'Auto', LCID: 'Auto',
  WMT: 'Retail', COST: 'Retail', TGT: 'Retail', AMZN2: 'Retail',
  NKE: 'Consumer', SBUX: 'Consumer', MCD: 'Consumer', KO: 'Consumer',
}

function getSector(ticker: string): string {
  return SECTOR_MAP[ticker] ?? 'Other'
}

// Feature 12: Time range options
const TIME_OPTIONS = [
  { label: '1h', ms: 3600000 },
  { label: '4h', ms: 14400000 },
  { label: '24h', ms: 86400000 },
  { label: '7d', ms: 604800000 },
] as const

const ALL_SECTORS = ['All', 'Tech', 'Finance', 'Healthcare', 'Energy', 'Media', 'Industrial', 'Auto', 'Retail', 'Consumer', 'Other']

export default function ScannerClient({ signals }: { signals: Signal[] }) {
  const [search, setSearch] = useState('')
  const [minSeverity, setMinSeverity] = useState(5)
  // Feature 11: sector filter
  const [sectorFilter, setSectorFilter] = useState('All')
  // Feature 12: time range filter
  const [timeRange, setTimeRange] = useState<typeof TIME_OPTIONS[number]['ms']>(86400000)

  // Filter signals by time range first
  const timeFiltered = useMemo(() => {
    const cutoff = Date.now() - timeRange
    return signals.filter(s => new Date(s.created_at).getTime() >= cutoff)
  }, [signals, timeRange])

  // Group by ticker
  const tickerMap: Record<string, Signal[]> = {}
  for (const s of timeFiltered) {
    if (!tickerMap[s.ticker]) tickerMap[s.ticker] = []
    tickerMap[s.ticker].push(s)
  }

  // Sort tickers by total severity score
  const ranked = useMemo(() => Object.entries(tickerMap)
    .map(([ticker, sigs]) => ({
      ticker,
      signals: sigs,
      score: sigs.reduce((acc, s) => acc + s.severity, 0),
      maxSeverity: Math.max(...sigs.map(s => s.severity)),
      count: sigs.length,
      sector: getSector(ticker),
    }))
    .filter(t => t.maxSeverity >= minSeverity)
    .filter(t => search ? t.ticker.includes(search.toUpperCase()) : true)
    // Feature 11: sector filter
    .filter(t => sectorFilter === 'All' ? true : t.sector === sectorFilter)
    .sort((a, b) => b.score - a.score),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeFiltered, minSeverity, search, sectorFilter]
  )

  // Feature 13: max score for convergence bar
  const maxScore = ranked.length > 0 ? ranked[0].score : 1

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Opportunity Scanner</h1>
        <p className="text-sm text-slate-500 mt-0.5">Ranked by signal convergence · {ranked.length} tickers</p>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[140px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search ticker..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-[#14b8a6]/60 font-mono"
            style={{ fontSize: 16 }}
          />
        </div>

        {/* Min severity */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500 whitespace-nowrap">Sev</span>
          {[5, 7, 9].map(v => (
            <button key={v} onClick={() => setMinSeverity(v)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border ${minSeverity === v ? 'bg-[#14b8a6]/15 border-[#14b8a6]/40 text-[#14b8a6]' : 'border-white/10 text-slate-500 hover:text-white'}`}
              style={{ transition: 'color 0.15s, background 0.15s' }}
            >{v}+</button>
          ))}
        </div>

        {/* Feature 12: Time range */}
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-slate-500" />
          {TIME_OPTIONS.map(opt => (
            <button key={opt.label} onClick={() => setTimeRange(opt.ms)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border ${timeRange === opt.ms ? 'bg-purple-500/15 border-purple-500/40 text-purple-400' : 'border-white/10 text-slate-500 hover:text-white'}`}
              style={{ transition: 'color 0.15s, background 0.15s' }}
            >{opt.label}</button>
          ))}
        </div>
      </div>

      {/* Feature 11: Sector filter pills */}
      <div className="flex gap-1.5 flex-wrap">
        {ALL_SECTORS.map(s => (
          <button key={s} onClick={() => setSectorFilter(s)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border ${sectorFilter === s ? 'bg-sky-500/20 border-sky-500/40 text-sky-400' : 'border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20'}`}
            style={{ transition: 'all 0.1s' }}
          >{s}</button>
        ))}
      </div>

      {/* Hot tickers */}
      {ranked.length === 0 ? (
        <div className="text-center py-24 text-slate-500 text-sm">No signals matching your filters</div>
      ) : (
        <div className="flex flex-col gap-6">
          {ranked.map(({ ticker, signals: sigs, score, count, sector }) => (
            <div key={ticker} className="flex flex-col gap-3">
              {/* Ticker header */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl">
                  <Flame className={`w-4 h-4 ${score >= 30 ? 'text-red-400' : score >= 20 ? 'text-orange-400' : 'text-yellow-400'}`} />
                  <span className="text-sm font-bold text-white font-mono">{ticker}</span>
                  <span className="text-xs text-slate-500">{count} signal{count > 1 ? 's' : ''}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${score >= 30 ? 'bg-red-500/20 text-red-400' : score >= 20 ? 'bg-orange-500/20 text-orange-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                    Score {score}
                  </span>
                  {/* Feature 11: sector badge */}
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/[0.08] text-slate-500">{sector}</span>
                </div>
                {count >= 2 && (
                  <span className="text-xs text-orange-400 font-semibold">⚡ Multi-signal convergence</span>
                )}
                {/* Feature 13: convergence score bar */}
                <div className="flex-1 min-w-[80px] max-w-[160px] flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${score >= 30 ? 'bg-red-400' : score >= 20 ? 'bg-orange-400' : 'bg-yellow-400'}`}
                      style={{ width: `${Math.min(100, (score / maxScore) * 100)}%`, opacity: 0.7 }}
                    />
                  </div>
                  <span className="text-[10px] text-slate-600 tabular-nums">{Math.round((score / maxScore) * 100)}%</span>
                </div>
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
