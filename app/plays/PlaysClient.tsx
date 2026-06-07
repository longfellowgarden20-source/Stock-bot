'use client'

import { useState, useCallback } from 'react'
import { Crosshair, TrendingUp, TrendingDown, Loader2, AlertTriangle, Zap, Target, Shield, Clock, BarChart2, Brain, ChevronDown, ChevronUp, Activity, Copy, Check, History, X } from 'lucide-react'

type AnalysisResult = {
  analysis: string
  ticker: string
  price: number | null
  change_pct: number | null
  signal_count: number
  news_count: number
}

const SECTION_CONFIG: Record<string, { icon: React.ReactNode; color: string; bg: string; border: string; label: string }> = {
  'RECOMMENDED DIRECTION': { icon: <Zap className="w-3.5 h-3.5" />,          color: 'text-yellow-300',  bg: 'bg-yellow-500/12', border: 'border-yellow-500/30', label: 'Recommended Direction' },
  'BULL CASE':             { icon: <TrendingUp className="w-3.5 h-3.5" />,    color: 'text-emerald-400', bg: 'bg-emerald-500/8', border: 'border-emerald-500/20', label: 'Bull Case' },
  'BEAR CASE':             { icon: <TrendingDown className="w-3.5 h-3.5" />,  color: 'text-red-400',     bg: 'bg-red-500/8',     border: 'border-red-500/20',     label: 'Bear Case' },
  "WHAT'S HAPPENING":      { icon: <Activity className="w-3.5 h-3.5" />,      color: 'text-sky-400',     bg: 'bg-sky-500/8',     border: 'border-sky-500/20',     label: "What's Happening" },
  'ENTRY':                 { icon: <Crosshair className="w-3.5 h-3.5" />,     color: 'text-white',       bg: 'bg-white/4',       border: 'border-white/10',       label: 'Entry' },
  'STOP LOSS':             { icon: <Shield className="w-3.5 h-3.5" />,        color: 'text-red-400',     bg: 'bg-red-500/8',     border: 'border-red-500/20',     label: 'Stop Loss' },
  'TARGET':                { icon: <Target className="w-3.5 h-3.5" />,        color: 'text-emerald-400', bg: 'bg-emerald-500/8', border: 'border-emerald-500/20', label: 'Target' },
  'RISK/REWARD':           { icon: <BarChart2 className="w-3.5 h-3.5" />,     color: 'text-yellow-400',  bg: 'bg-yellow-500/8',  border: 'border-yellow-500/20',  label: 'Risk / Reward' },
  'THESIS':                { icon: <Zap className="w-3.5 h-3.5" />,           color: 'text-yellow-400',  bg: 'bg-yellow-500/8',  border: 'border-yellow-500/20',  label: 'Thesis' },
  'RISKS':                 { icon: <AlertTriangle className="w-3.5 h-3.5" />, color: 'text-red-400',     bg: 'bg-red-500/8',     border: 'border-red-500/20',     label: 'Risks' },
  'TIMING':                { icon: <Clock className="w-3.5 h-3.5" />,         color: 'text-slate-300',   bg: 'bg-white/3',       border: 'border-white/8',        label: 'Timing' },
  'CONVICTION':            { icon: <Brain className="w-3.5 h-3.5" />,         color: 'text-purple-400',  bg: 'bg-purple-500/8',  border: 'border-purple-500/20',  label: 'Conviction' },
}

function parseAnalysis(text: string): Array<{ header: string; body: string }> {
  // Match **HEADER**: or **HEADER** patterns
  const regex = /\*\*([\w'/\s]+?)\*\*\s*:/g
  const matches: Array<{ index: number; header: string; len: number }> = []
  let m
  while ((m = regex.exec(text)) !== null) {
    matches.push({ index: m.index, header: m[1].trim().toUpperCase(), len: m[0].length })
  }
  if (matches.length < 2) {
    // Split on double newlines as fallback
    return text.split(/\n{2,}/).filter(Boolean).map(p => ({ header: '', body: p.replace(/\*\*/g, '').trim() }))
  }
  return matches.map((match, i) => {
    const start = match.index + match.len
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    const body = text.slice(start, end).replace(/\*\*/g, '').trim()
    return { header: match.header, body }
  })
}

const TIMEFRAMES = ['day trade', 'swing (2-5 days)', 'swing (1-2 weeks)', 'position (1+ month)']

export default function PlaysClient() {
  const [ticker, setTicker] = useState('')
  const [direction, setDirection] = useState<'long' | 'short'>('long')
  const [thesis, setThesis] = useState('')
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[1])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [expandedSection, setExpandedSection] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [savedAnalyses, setSavedAnalyses] = useState<Array<{ ticker: string; direction: string; analysis: string; price: number | null; ts: number }>>(() => {
    try { return JSON.parse(localStorage.getItem('plays.history') ?? '[]') } catch { return [] }
  })
  const [showHistory, setShowHistory] = useState(false)

  const sections = result ? parseAnalysis(result.analysis) : []

  // Extract Groq's recommended direction from the analysis
  const recSection = sections.find(s => s.header === 'RECOMMENDED DIRECTION')
  const recBody = recSection?.body?.toUpperCase() ?? ''
  const groqDirection: 'long' | 'short' | null = recBody.includes('SHORT') && !recBody.includes('NOT SHORT')
    ? 'short'
    : recBody.includes('LONG') && !recBody.includes('NOT LONG')
    ? 'long'
    : null
  const directionConflict = groqDirection && groqDirection !== direction

  async function analyze() {
    if (!ticker.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const r = await fetch('/api/plays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker.trim(), direction, thesis, timeframe }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setResult(data)
      // Auto-save to history
      const entry = { ticker: data.ticker, direction, analysis: data.analysis, price: data.price, ts: Date.now() }
      setSavedAnalyses(prev => {
        const next = [entry, ...prev].slice(0, 20)
        try { localStorage.setItem('plays.history', JSON.stringify(next)) } catch { /* quota */ }
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to analyze')
    } finally {
      setLoading(false)
    }
  }

  const copyTrade = useCallback(() => {
    if (!result) return
    const entrySection = sections.find(s => s.header === 'ENTRY')?.body ?? ''
    const stopSection = sections.find(s => s.header === 'STOP LOSS')?.body ?? ''
    const targetSection = sections.find(s => s.header === 'TARGET')?.body ?? ''
    const text = `${result.ticker} ${direction.toUpperCase()} @ $${result.price?.toFixed(2) ?? '?'}\nEntry: ${entrySection}\nStop: ${stopSection}\nTarget: ${targetSection}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [result, sections, direction])

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Crosshair className="w-5 h-5 text-sky-400 shrink-0" />
        <div>
          <h1 className="text-lg font-bold text-white">Play Analyzer</h1>
          <p className="text-xs text-slate-500">Propose a trade — Groq pulls signals, news, and price data to give you a full breakdown</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {result && (
            <button
              onClick={copyTrade}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold border rounded-lg text-slate-400 border-white/[0.08] hover:text-white hover:border-white/20"
              style={{ transition: 'color 0.1s, border-color 0.1s' }}
              title="Copy entry/stop/target"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          )}
          <button
            onClick={() => setShowHistory(h => !h)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold border rounded-lg ${showHistory ? 'text-sky-400 border-sky-500/30 bg-sky-500/10' : 'text-slate-400 border-white/[0.08] hover:text-white'}`}
            style={{ transition: 'all 0.1s' }}
          >
            <History className="w-3.5 h-3.5" />
            History {savedAnalyses.length > 0 && `(${savedAnalyses.length})`}
          </button>
        </div>
      </div>

      {/* Input form */}
      <div className="border border-white/[0.07] rounded-xl p-4 flex flex-col gap-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
        {/* Ticker + direction row */}
        <div className="flex gap-3 flex-wrap">
          <div className="flex flex-col gap-1.5 flex-1 min-w-[120px]">
            <label className="text-[11px] text-slate-500 uppercase tracking-wider">Ticker</label>
            <input
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && analyze()}
              placeholder="e.g. PLTR"
              className="px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50 font-mono font-bold text-sm uppercase"
              style={{ transition: 'border-color 0.1s' }}
              maxLength={5}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-slate-500 uppercase tracking-wider">Direction</label>
            <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
              <button
                onClick={() => setDirection('long')}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-bold ${direction === 'long' ? 'bg-emerald-500/15 text-emerald-400' : 'text-slate-500 hover:text-slate-300 bg-white/[0.02]'}`}
                style={{ transition: 'background 0.1s, color 0.1s' }}
              >
                <TrendingUp className="w-3.5 h-3.5" /> LONG
              </button>
              <button
                onClick={() => setDirection('short')}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-bold border-l border-white/[0.08] ${direction === 'short' ? 'bg-red-500/15 text-red-400' : 'text-slate-500 hover:text-slate-300 bg-white/[0.02]'}`}
                style={{ transition: 'background 0.1s, color 0.1s' }}
              >
                <TrendingDown className="w-3.5 h-3.5" /> SHORT
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5 flex-1 min-w-[160px]">
            <label className="text-[11px] text-slate-500 uppercase tracking-wider">Timeframe</label>
            <select
              value={timeframe}
              onChange={e => setTimeframe(e.target.value)}
              className="px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-slate-300 focus:outline-none focus:border-sky-500/50 cursor-pointer text-xs"
              style={{ fontSize: '13px' }}
            >
              {TIMEFRAMES.map(t => (
                <option key={t} value={t} className="bg-[#0d1220]">{t}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Optional thesis */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] text-slate-500 uppercase tracking-wider">Your thesis <span className="normal-case text-slate-600">(optional — tell Groq why you like this play)</span></label>
          <textarea
            value={thesis}
            onChange={e => setThesis(e.target.value)}
            placeholder="e.g. Earnings next week, strong options flow today, think it breaks $50 resistance..."
            rows={2}
            className="px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50 text-sm resize-none"
            style={{ transition: 'border-color 0.1s' }}
          />
        </div>

        {/* Submit */}
        <button
          onClick={analyze}
          disabled={!ticker.trim() || loading}
          className="flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
          style={{
            background: loading ? 'rgba(14,165,233,0.15)' : 'rgba(14,165,233,0.2)',
            border: '1px solid rgba(14,165,233,0.3)',
            transition: 'opacity 0.1s, background 0.1s',
          }}
        >
          {loading
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing {ticker}…</>
            : <><Crosshair className="w-4 h-4" /> Analyze Play</>}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {/* History panel */}
      {showHistory && (
        <div className="border border-white/[0.07] rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
            <History className="w-4 h-4 text-slate-400" />
            <span className="text-sm font-bold text-white">Recent Analyses</span>
            <button onClick={() => setShowHistory(false)} className="ml-auto text-slate-500 hover:text-white"><X className="w-3.5 h-3.5" /></button>
          </div>
          {savedAnalyses.length === 0 ? (
            <p className="text-xs text-slate-500 p-4">No history yet — run an analysis first.</p>
          ) : (
            <div className="flex flex-col divide-y divide-white/[0.05]">
              {savedAnalyses.map((a, i) => (
                <button
                  key={i}
                  onClick={() => { setTicker(a.ticker); setDirection(a.direction as 'long' | 'short'); setShowHistory(false) }}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.03] text-left"
                  style={{ transition: 'background 0.1s' }}
                >
                  <span className="font-bold font-mono text-white text-sm">{a.ticker}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${a.direction === 'long' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : 'text-red-400 border-red-500/25 bg-red-500/8'}`}>{a.direction.toUpperCase()}</span>
                  {a.price && <span className="text-xs text-slate-500 tabular-nums">${a.price.toFixed(2)}</span>}
                  <span className="text-[10px] text-slate-600 ml-auto">{new Date(a.ts).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="flex flex-col gap-4">
          {/* Ticker summary bar */}
          <div className="flex flex-col gap-2 px-4 py-3 border border-white/[0.07] rounded-xl" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <div className="flex items-center gap-3">
              <span className="font-bold text-lg text-white font-mono">{result.ticker}</span>
              {result.price != null && (
                <span className="text-sm text-white font-semibold tabular-nums">${Number(result.price).toFixed(2)}</span>
              )}
              {result.change_pct != null && (
                <span className={`text-sm font-bold tabular-nums ${result.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {result.change_pct >= 0 ? '+' : ''}{Number(result.change_pct).toFixed(2)}%
                </span>
              )}
              {/* Show Groq's recommended direction */}
              {groqDirection ? (
                <span className={`text-xs px-2 py-0.5 rounded border font-bold ml-1 ${groqDirection === 'long' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : 'text-red-400 border-red-500/25 bg-red-500/8'}`}>
                  {groqDirection.toUpperCase()}
                </span>
              ) : (
                <span className={`text-xs px-2 py-0.5 rounded border font-bold ml-1 ${direction === 'long' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : 'text-red-400 border-red-500/25 bg-red-500/8'}`}>
                  {direction.toUpperCase()}
                </span>
              )}
              <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
                <span>{result.signal_count} signals</span>
                <span>{result.news_count} news</span>
              </div>
            </div>
            {/* Direction conflict warning */}
            {directionConflict && groqDirection && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/25">
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
                <span className="text-xs text-yellow-300 font-medium">
                  You picked {direction.toUpperCase()} but Groq recommends {groqDirection.toUpperCase()} based on current signals — see analysis below
                </span>
              </div>
            )}
          </div>

          {/* Analysis sections */}
          <div className="flex flex-col gap-2">
            {sections.map((section, i) => {
              const cfg = section.header ? SECTION_CONFIG[section.header] : null
              const isExpanded = expandedSection === (section.header || `p${i}`)
              const key = section.header || `p${i}`

              if (!section.header) {
                return (
                  <p key={i} className="text-sm text-slate-300 leading-relaxed px-1">{section.body}</p>
                )
              }

              return (
                <div
                  key={i}
                  className={`border rounded-xl overflow-hidden cursor-pointer ${cfg?.border ?? 'border-white/[0.07]'}`}
                  style={{ background: cfg ? undefined : 'rgba(255,255,255,0.02)', transition: 'border-color 0.1s' }}
                  onClick={() => setExpandedSection(isExpanded ? null : key)}
                >
                  {/* Section header */}
                  <div className={`flex items-center gap-2.5 px-4 py-3 ${cfg?.bg ?? 'bg-white/[0.02]'}`}>
                    <span className={cfg?.color ?? 'text-slate-400'}>{cfg?.icon}</span>
                    <span className={`text-xs font-bold uppercase tracking-widest ${cfg?.color ?? 'text-slate-400'}`}>
                      {cfg?.label ?? section.header}
                    </span>
                    <div className="ml-auto">
                      {isExpanded
                        ? <ChevronUp className="w-3.5 h-3.5 text-slate-600" />
                        : <ChevronDown className="w-3.5 h-3.5 text-slate-600" />}
                    </div>
                  </div>

                  {/* Section body — always visible for key sections, collapsible for others */}
                  {(isExpanded || ['RECOMMENDED DIRECTION', 'BULL CASE', 'BEAR CASE', 'ENTRY', 'STOP LOSS', 'TARGET', 'CONVICTION'].includes(section.header)) && (
                    <div className="px-4 py-3 border-t border-white/[0.05]">
                      <p className="text-sm text-slate-200 leading-relaxed">{section.body}</p>
                    </div>
                  )}

                  {/* Preview line for collapsed non-key sections */}
                  {!isExpanded && !['RECOMMENDED DIRECTION', 'BULL CASE', 'BEAR CASE', 'ENTRY', 'STOP LOSS', 'TARGET', 'CONVICTION'].includes(section.header) && (
                    <div className="px-4 py-2 border-t border-white/[0.04]">
                      <p className="text-xs text-slate-500 line-clamp-1">{section.body}</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Disclaimer */}
          <p className="text-[11px] text-slate-600 text-center">
            AI analysis only — not financial advice. Always do your own research.
          </p>
        </div>
      )}
    </div>
  )
}
