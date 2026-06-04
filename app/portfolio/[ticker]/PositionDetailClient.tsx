'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  BarChart2,
  Newspaper,
  Users,
  ShieldAlert,
  LayoutDashboard,
} from 'lucide-react'
import TradingViewChart from '@/app/signals/[id]/TradingViewChart'
import SignalCard, { Signal } from '@/app/components/SignalCard'

// ── Types ─────────────────────────────────────────────────────────────────────

type Position = {
  id: string
  ticker: string
  shares: number
  avg_cost: number
  notes: string | null
  added_at: string
}

type Snapshot = {
  id: string
  ticker: string
  price: number
  volume: number
  change_pct: number
  created_at: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FinnhubProfile = Record<string, any> | null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FinnhubMetrics = Record<string, any> | null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FinnhubNews = Record<string, any>[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FinnhubRecs = Record<string, any>[] | null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PolygonPrev = Record<string, any> | null

interface Props {
  position: Position
  snapshots: Snapshot[]
  latestSnapshot: Snapshot | null
  signals: Signal[]
  totalPortfolioValue: number
  profile: FinnhubProfile
  metrics: FinnhubMetrics
  news: FinnhubNews
  recommendations: FinnhubRecs
  prevClose: PolygonPrev
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined, decimals = 2): string {
  if (n == null || isNaN(n)) return '—'
  return '$' + n.toFixed(decimals)
}

function fmtPct(n: number | null | undefined, decimals = 2): string {
  if (n == null || isNaN(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%'
}

function fmtLargeNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T'
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'b'
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'm'
  return '$' + n.toFixed(0)
}

function etTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }) + ' ET'
}

const TABS = [
  { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'signals',  label: 'Signals',  Icon: BarChart2 },
  { id: 'news',     label: 'News',     Icon: Newspaper },
  { id: 'analyst',  label: 'Analyst',  Icon: Users },
  { id: 'risk',     label: 'Risk',     Icon: ShieldAlert },
] as const

type TabId = typeof TABS[number]['id']

const SIGNAL_TYPES = [
  'all', 'price_move', 'volume_spike', 'options_unusual', 'dark_pool',
  'insider_buy', 'insider_sell', 'sec_filing', 'short_squeeze', 'earnings_upcoming',
  'analyst_change', 'congress_trade', 'technical', 'macro', 'convergence',
]

// ── Main component ─────────────────────────────────────────────────────────────

export default function PositionDetailClient({
  position,
  latestSnapshot,
  signals,
  totalPortfolioValue,
  profile,
  metrics,
  news,
  recommendations,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [descExpanded, setDescExpanded] = useState(false)
  const [signalTypeFilter, setSignalTypeFilter] = useState('all')
  const [stopPrice, setStopPrice] = useState('')
  const [targetPrice, setTargetPrice] = useState('')

  const ticker = position.ticker
  const currentPrice = latestSnapshot?.price || position.avg_cost
  const pnl = (currentPrice - position.avg_cost) * position.shares
  const pnlPct = position.avg_cost > 0 ? ((currentPrice - position.avg_cost) / position.avg_cost) * 100 : 0
  const totalValue = currentPrice * position.shares
  const isUp = pnl >= 0
  const dayChange = latestSnapshot?.change_pct ?? null

  const m = metrics?.metric ?? {}

  // Analyst consensus
  const latestRec = Array.isArray(recommendations) && recommendations.length > 0
    ? recommendations[0]
    : null

  function analystLabel(rec: Record<string, number> | null): string {
    if (!rec) return '—'
    const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = rec
    const total = strongBuy + buy + hold + sell + strongSell
    if (total === 0) return '—'
    const score = (strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell * 1) / total
    if (score >= 4.5) return 'Strong Buy'
    if (score >= 3.5) return 'Buy'
    if (score >= 2.5) return 'Hold'
    if (score >= 1.5) return 'Sell'
    return 'Strong Sell'
  }

  function analystColor(label: string) {
    if (label === 'Strong Buy' || label === 'Buy') return 'text-[#22c55e]'
    if (label === 'Strong Sell' || label === 'Sell') return 'text-[#ef4444]'
    return 'text-[#f59e0b]'
  }

  const filteredSignals = signalTypeFilter === 'all'
    ? signals
    : signals.filter(s => s.signal_type === signalTypeFilter)

  const analystSignals = signals.filter(s => s.signal_type === 'analyst_change')

  // Risk calcs
  const positionCost = position.avg_cost * position.shares
  const positionSizePct = totalPortfolioValue > 0
    ? (positionCost / totalPortfolioValue) * 100
    : null
  const unrealizedPct = pnlPct
  const week52High = m['52WeekHigh'] as number | undefined
  const week52Low = m['52WeekLow'] as number | undefined
  const distFromHigh = week52High != null
    ? ((currentPrice - week52High) / week52High) * 100
    : null
  const distFromLow = week52Low != null
    ? ((currentPrice - week52Low) / week52Low) * 100
    : null
  const beta = m['beta'] as number | undefined

  const stopNum = parseFloat(stopPrice)
  const targetNum = parseFloat(targetPrice)
  const maxLossDollar = !isNaN(stopNum) && stopNum > 0
    ? (stopNum - currentPrice) * position.shares
    : null
  const maxLossPct = !isNaN(stopNum) && stopNum > 0 && currentPrice > 0
    ? ((stopNum - currentPrice) / currentPrice) * 100
    : null
  const potentialGainDollar = !isNaN(targetNum) && targetNum > 0
    ? (targetNum - currentPrice) * position.shares
    : null
  const potentialGainPct = !isNaN(targetNum) && targetNum > 0 && currentPrice > 0
    ? ((targetNum - currentPrice) / currentPrice) * 100
    : null
  // Valid R:R: stop must be below entry (maxLossDollar < 0) AND target above entry (potentialGainDollar > 0)
  const rrRatio = maxLossDollar != null && potentialGainDollar != null && maxLossDollar < 0 && potentialGainDollar > 0
    ? Math.abs(potentialGainDollar / maxLossDollar)
    : null

  const inputCls = 'px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/60 w-full'

  return (
    <div className="flex flex-col gap-5 max-w-[1100px]">

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          href="/portfolio"
          className="p-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/8 border border-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea5e9]/60"
          style={{ transitionProperty: 'color, background', transitionDuration: '0.15s' }}
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white font-mono tracking-tight">{ticker}</h1>
          {profile?.name && (
            <span className="text-sm text-slate-400 hidden sm:block">{profile.name}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-sm font-bold ${isUp ? 'bg-[#22c55e]/10 border-[#22c55e]/30 text-[#22c55e]' : 'bg-[#ef4444]/10 border-[#ef4444]/30 text-[#ef4444]'}`}>
            {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            {isUp ? '+' : ''}{pnlPct.toFixed(2)}%
          </div>
          {dayChange != null && (
            <span className={`text-xs font-semibold ${dayChange >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
              {dayChange >= 0 ? '+' : ''}{dayChange.toFixed(2)}% today
            </span>
          )}
        </div>
      </div>

      {/* Page title (hidden, for tab title) */}
      <title>{ticker} — Position Detail</title>

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 bg-white/4 border border-white/10 rounded-2xl p-1.5 overflow-x-auto">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea5e9]/60 ${
              activeTab === id
                ? 'bg-[#0ea5e9]/15 text-[#0ea5e9] border border-[#0ea5e9]/20'
                : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
            style={{ transitionProperty: 'color, background', transitionDuration: '0.15s' }}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* ── Tab: Overview ── */}
      {activeTab === 'overview' && (
        <div className="flex flex-col gap-5">

          {/* TradingView chart */}
          <div className="bg-white/4 border border-white/10 rounded-2xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-white/8 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-400">Chart</span>
              <span className="text-xs font-mono text-[#0ea5e9]">{ticker}</span>
            </div>
            <TradingViewChart ticker={ticker} />
          </div>

          {/* Position summary */}
          <div className="bg-white/4 border border-white/10 rounded-2xl p-5">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-4">Position Summary</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              {[
                { label: 'Shares', value: position.shares.toLocaleString() },
                { label: 'Avg Cost', value: fmt$(position.avg_cost) },
                { label: 'Current Price', value: fmt$(currentPrice) },
                { label: 'Total Value', value: fmt$(totalValue) },
                {
                  label: 'Unrealized P&L',
                  value: `${isUp ? '+' : ''}${fmt$(pnl)} (${fmtPct(pnlPct)})`,
                  color: isUp ? 'text-[#22c55e]' : 'text-[#ef4444]',
                },
                {
                  label: 'Day Change',
                  value: dayChange != null ? fmtPct(dayChange) : '—',
                  color: dayChange != null ? (dayChange >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]') : 'text-slate-400',
                },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex flex-col gap-1">
                  <span className="text-xs text-slate-500">{label}</span>
                  <span className={`text-sm font-bold tabular ${color ?? 'text-white'}`}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Company info */}
          {profile && Object.keys(profile).length > 0 && (
            <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Company</p>
                {profile.weburl && (
                  <a
                    href={profile.weburl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-[#0ea5e9] hover:text-[#38bdf8]"
                    style={{ transitionProperty: 'color', transitionDuration: '0.15s' }}
                  >
                    <ExternalLink className="w-3 h-3" /> Website
                  </a>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                {[
                  { label: 'Name', value: profile.name },
                  { label: 'Exchange', value: profile.exchange },
                  { label: 'Sector', value: profile.finnhubIndustry },
                  { label: 'Market Cap', value: fmtLargeNum(profile.marketCapitalization * 1e6) },
                  { label: 'Country', value: profile.country },
                  { label: 'IPO Date', value: profile.ipo },
                ].map(({ label, value }) =>
                  value ? (
                    <div key={label} className="flex flex-col gap-0.5">
                      <span className="text-xs text-slate-500">{label}</span>
                      <span className="text-sm text-white">{value}</span>
                    </div>
                  ) : null
                )}
              </div>
              {profile.description && (
                <div className="mt-1">
                  <p className={`text-xs text-slate-400 leading-relaxed ${descExpanded ? '' : 'line-clamp-3'}`}>
                    {profile.description}
                  </p>
                  <button
                    onClick={() => setDescExpanded(x => !x)}
                    className="mt-1 flex items-center gap-1 text-xs text-[#0ea5e9] hover:text-[#38bdf8]"
                    style={{ transitionProperty: 'color', transitionDuration: '0.15s' }}
                  >
                    {descExpanded
                      ? <><ChevronUp className="w-3 h-3" /> Show less</>
                      : <><ChevronDown className="w-3 h-3" /> Show more</>}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Key stats */}
          <div className="bg-white/4 border border-white/10 rounded-2xl p-5">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-4">Key Stats</p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: 'P/E Ratio', value: m.peBasicExclExtraTTM != null ? m.peBasicExclExtraTTM.toFixed(2) : '—' },
                { label: 'EPS (TTM)', value: m.epsBasicExclExtraItemsTTM != null ? fmt$(m.epsBasicExclExtraItemsTTM) : '—' },
                { label: '52W High', value: week52High != null ? fmt$(week52High) : '—' },
                { label: '52W Low', value: week52Low != null ? fmt$(week52Low) : '—' },
                { label: 'Beta', value: beta != null ? beta.toFixed(2) : '—' },
                { label: 'Dividend Yield', value: m.dividendYieldIndicatedAnnual != null ? fmtPct(m.dividendYieldIndicatedAnnual, 2) : '—' },
                { label: 'Revenue TTM', value: m.revenueTTM != null ? fmtLargeNum(m.revenueTTM) : '—' },
                { label: 'Profit Margin', value: m.netProfitMarginTTM != null ? fmtPct(m.netProfitMarginTTM, 1) : '—' },
              ].map(({ label, value }) => (
                <div key={label} className="flex flex-col gap-1 bg-white/3 border border-white/8 rounded-xl p-3">
                  <span className="text-xs text-slate-500">{label}</span>
                  <span className="text-sm font-bold text-white tabular">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: Signals ── */}
      {activeTab === 'signals' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">{signals.length} signal{signals.length !== 1 ? 's' : ''}</span>
              <span className="text-xs text-slate-500">in last 30 days</span>
            </div>
            <select
              value={signalTypeFilter}
              onChange={e => setSignalTypeFilter(e.target.value)}
              className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:border-[#0ea5e9]/60"
              style={{ fontSize: 16 }}
            >
              {SIGNAL_TYPES.map(t => (
                <option key={t} value={t} className="bg-[#0a0f1a]">
                  {t === 'all' ? 'All types' : t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>

          {filteredSignals.length === 0 ? (
            <div className="text-center py-16 text-slate-500 text-sm">
              No signals{signalTypeFilter !== 'all' ? ` of type "${signalTypeFilter.replace(/_/g, ' ')}"` : ''} in the last 30 days
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredSignals.map(s => (
                <SignalCard key={s.id} signal={s} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: News ── */}
      {activeTab === 'news' && (
        <div className="flex flex-col gap-3">
          {news.length === 0 ? (
            <div className="text-center py-16 text-slate-500 text-sm">No recent news</div>
          ) : (
            news.map((article, i) => {
              const sentiment = article.sentiment as number | undefined
              const sentimentDot =
                sentiment == null
                  ? 'bg-slate-500'
                  : sentiment > 0.1
                  ? 'bg-[#22c55e]'
                  : sentiment < -0.1
                  ? 'bg-[#ef4444]'
                  : 'bg-slate-500'
              const sentimentLabel =
                sentiment == null
                  ? 'Neutral'
                  : sentiment > 0.1
                  ? 'Positive'
                  : sentiment < -0.1
                  ? 'Negative'
                  : 'Neutral'

              return (
                <a
                  key={article.id ?? i}
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-white/4 border border-white/10 rounded-xl p-4 hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea5e9]/60"
                  style={{ transitionProperty: 'border-color', transitionDuration: '0.15s' }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white leading-snug">{article.headline}</p>
                      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                        <span className="text-xs text-slate-500">{article.source}</span>
                        {article.datetime && (
                          <span className="text-xs text-slate-600">{etTime(article.datetime)}</span>
                        )}
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                          <span className={`w-1.5 h-1.5 rounded-full ${sentimentDot}`} />
                          {sentimentLabel}
                        </span>
                      </div>
                      {article.summary && (
                        <p className="text-xs text-slate-400 mt-2 line-clamp-2 leading-relaxed">{article.summary}</p>
                      )}
                    </div>
                    <ExternalLink className="w-3.5 h-3.5 text-slate-600 shrink-0 mt-0.5" />
                  </div>
                </a>
              )
            })
          )}
        </div>
      )}

      {/* ── Tab: Analyst ── */}
      {activeTab === 'analyst' && (
        <div className="flex flex-col gap-5">

          {/* Recommendation trend */}
          {latestRec ? (
            <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Analyst Consensus</p>
                <span className={`text-sm font-bold ${analystColor(analystLabel(latestRec))}`}>
                  {analystLabel(latestRec)}
                </span>
              </div>

              {/* Horizontal bar chart */}
              {(() => {
                const bars = [
                  { label: 'Strong Buy', count: latestRec.strongBuy ?? 0, color: 'bg-[#22c55e]' },
                  { label: 'Buy',        count: latestRec.buy ?? 0,       color: 'bg-[#22c55e]/60' },
                  { label: 'Hold',       count: latestRec.hold ?? 0,      color: 'bg-slate-600' },
                  { label: 'Sell',       count: latestRec.sell ?? 0,      color: 'bg-[#ef4444]/60' },
                  { label: 'Strong Sell',count: latestRec.strongSell ?? 0, color: 'bg-[#ef4444]' },
                ]
                const total = bars.reduce((s, b) => s + b.count, 0)
                return (
                  <div className="flex flex-col gap-2">
                    {bars.map(({ label, count, color }) => (
                      <div key={label} className="flex items-center gap-3">
                        <span className="text-xs text-slate-500 w-24 shrink-0">{label}</span>
                        <div className="flex-1 bg-white/5 rounded-full h-2.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${color}`}
                            style={{ width: total > 0 ? `${(count / total) * 100}%` : '0%', transition: 'width 0.3s' }}
                          />
                        </div>
                        <span className="text-xs text-slate-400 w-6 text-right tabular">{count}</span>
                      </div>
                    ))}
                    {latestRec.period && (
                      <p className="text-xs text-slate-600 mt-1">Period: {latestRec.period}</p>
                    )}
                  </div>
                )
              })()}
            </div>
          ) : (
            <div className="bg-white/4 border border-white/10 rounded-2xl p-5">
              <p className="text-sm text-slate-500">No analyst recommendations available</p>
            </div>
          )}

          {/* Analyst signals from DB */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">
              Recent Analyst Signals ({analystSignals.length})
            </p>
            {analystSignals.length === 0 ? (
              <p className="text-sm text-slate-500 py-4">No analyst signals in the last 30 days</p>
            ) : (
              <div className="flex flex-col gap-2">
                {analystSignals.map(s => (
                  <SignalCard key={s.id} signal={s} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tab: Risk ── */}
      {activeTab === 'risk' && (
        <div className="flex flex-col gap-5">

          {/* Risk metrics */}
          <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Risk Metrics</p>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                {
                  label: 'Position Size',
                  value: positionSizePct != null ? fmtPct(positionSizePct, 1) : '—',
                  sub: 'of portfolio',
                  color: positionSizePct != null && positionSizePct > 25
                    ? 'text-[#ef4444]'
                    : positionSizePct != null && positionSizePct > 10
                    ? 'text-[#f59e0b]'
                    : 'text-[#22c55e]',
                },
                {
                  label: 'Unrealized P&L',
                  value: fmtPct(unrealizedPct, 2),
                  sub: 'vs cost basis',
                  color: unrealizedPct >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]',
                },
                {
                  label: 'Beta',
                  value: beta != null ? beta.toFixed(2) : '—',
                  sub: 'vs S&P 500',
                  color: beta != null && beta > 1.5
                    ? 'text-[#ef4444]'
                    : beta != null && beta > 1
                    ? 'text-[#f59e0b]'
                    : 'text-[#22c55e]',
                },
                {
                  label: 'Dist. from 52W High',
                  value: distFromHigh != null ? fmtPct(distFromHigh, 1) : '—',
                  sub: week52High != null ? fmt$(week52High) : '',
                  color: distFromHigh != null && distFromHigh > -5
                    ? 'text-[#22c55e]'
                    : distFromHigh != null && distFromHigh > -20
                    ? 'text-[#f59e0b]'
                    : 'text-[#ef4444]',
                },
                {
                  label: 'Dist. from 52W Low',
                  value: distFromLow != null ? fmtPct(distFromLow, 1) : '—',
                  sub: week52Low != null ? fmt$(week52Low) : '',
                  color: distFromLow != null && distFromLow < 10
                    ? 'text-[#ef4444]'
                    : distFromLow != null && distFromLow < 25
                    ? 'text-[#f59e0b]'
                    : 'text-[#22c55e]',
                },
                {
                  label: 'Position Value',
                  value: fmt$(totalValue),
                  sub: `${position.shares} shares`,
                  color: 'text-white',
                },
              ].map(({ label, value, sub, color }) => (
                <div key={label} className="flex flex-col gap-1 bg-white/3 border border-white/8 rounded-xl p-3">
                  <span className="text-xs text-slate-500">{label}</span>
                  <span className={`text-base font-bold tabular ${color}`}>{value}</span>
                  {sub && <span className="text-xs text-slate-600">{sub}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Stop loss & target inputs */}
          <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Scenario Calculator</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-500">Stop Loss Price ($)</label>
                <input
                  value={stopPrice}
                  onChange={e => setStopPrice(e.target.value)}
                  placeholder="e.g. 145.00"
                  type="number"
                  step="0.01"
                  className={inputCls}
                  style={{ fontSize: 16 }}
                />
                {maxLossDollar != null && (
                  <div className="flex flex-col gap-1 mt-1">
                    <span className="text-xs text-slate-500">Max Loss</span>
                    <span className={`text-sm font-bold tabular ${maxLossDollar < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
                      {maxLossDollar >= 0 ? '+' : ''}{fmt$(maxLossDollar)} ({fmtPct(maxLossPct ?? 0, 2)})
                    </span>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-500">Target Price ($)</label>
                <input
                  value={targetPrice}
                  onChange={e => setTargetPrice(e.target.value)}
                  placeholder="e.g. 175.00"
                  type="number"
                  step="0.01"
                  className={inputCls}
                  style={{ fontSize: 16 }}
                />
                {potentialGainDollar != null && (
                  <div className="flex flex-col gap-1 mt-1">
                    <span className="text-xs text-slate-500">Potential Gain</span>
                    <span className={`text-sm font-bold tabular ${potentialGainDollar >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                      {potentialGainDollar >= 0 ? '+' : ''}{fmt$(potentialGainDollar)} ({fmtPct(potentialGainPct ?? 0, 2)})
                    </span>
                  </div>
                )}
              </div>
            </div>
            {rrRatio != null && (
              <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${rrRatio >= 3 ? 'bg-[#22c55e]/10 border-[#22c55e]/30' : rrRatio >= 2 ? 'bg-[#f59e0b]/10 border-[#f59e0b]/30' : 'bg-[#ef4444]/10 border-[#ef4444]/30'}`}>
                <span className="text-xs text-slate-400">R:R Ratio</span>
                <span className={`text-lg font-bold tabular ${rrRatio >= 3 ? 'text-[#22c55e]' : rrRatio >= 2 ? 'text-[#f59e0b]' : 'text-[#ef4444]'}`}>
                  1 : {rrRatio.toFixed(2)}
                </span>
                <span className="text-xs text-slate-500 ml-auto">
                  {rrRatio >= 3 ? 'Excellent' : rrRatio >= 2 ? 'Good' : 'Poor'} setup
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
