'use client'
import { useEffect, useState } from 'react'
import { ExternalLink, Zap, AlertTriangle, TrendingUp, Shield, Clock, Activity } from 'lucide-react'

interface SourceLink {
  title: string
  url: string
  type: 'news' | 'sec_filing' | 'analyst' | 'reddit' | 'other'
}

interface AnalysisResult {
  analysis: string
  ticker: string
  sources: SourceLink[]
}

const SECTION_CONFIG: Record<string, {
  icon: React.ReactNode
  color: string
  bg: string
  border: string
  label: string
}> = {
  "WHAT'S HAPPENING": {
    icon: <Activity className="w-3.5 h-3.5" />,
    color: 'text-sky-400',
    bg: 'bg-sky-500/8',
    border: 'border-sky-500/25',
    label: "What's Happening",
  },
  'KEY LEVELS': {
    icon: <TrendingUp className="w-3.5 h-3.5" />,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/8',
    border: 'border-emerald-500/25',
    label: 'Key Levels',
  },
  'THESIS': {
    icon: <Zap className="w-3.5 h-3.5" />,
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/8',
    border: 'border-yellow-500/25',
    label: 'Thesis',
  },
  'RISKS': {
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
    color: 'text-red-400',
    bg: 'bg-red-500/8',
    border: 'border-red-500/25',
    label: 'Risks',
  },
  'TIMING': {
    icon: <Clock className="w-3.5 h-3.5" />,
    color: 'text-slate-300',
    bg: 'bg-white/4',
    border: 'border-white/10',
    label: 'Timing',
  },
  'BULL CASE': {
    icon: <TrendingUp className="w-3.5 h-3.5" />,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/8',
    border: 'border-emerald-500/25',
    label: 'Bull Case',
  },
  'BEAR CASE': {
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
    color: 'text-red-400',
    bg: 'bg-red-500/8',
    border: 'border-red-500/25',
    label: 'Bear Case',
  },
  'SUMMARY': {
    icon: <Shield className="w-3.5 h-3.5" />,
    color: 'text-slate-300',
    bg: 'bg-white/4',
    border: 'border-white/10',
    label: 'Summary',
  },
}

const SOURCE_TYPE_LABELS: Record<SourceLink['type'], string> = {
  news: 'News',
  sec_filing: 'SEC Filing',
  analyst: 'Analyst',
  reddit: 'StockTwits / Reddit',
  other: 'Source',
}

function parseAnalysis(text: string): Array<{ header: string; body: string }> {
  // Try bold markdown headers: **HEADER**: or **HEADER**
  const boldRegex = /\*\*([\w'\s]+?)\*\*\s*:?\s*/g
  const boldMatches: Array<{ index: number; header: string; fullMatch: string }> = []
  let m
  while ((m = boldRegex.exec(text)) !== null) {
    const h = m[1].trim().toUpperCase()
    // Only treat as section header if it matches known keys or is short (< 5 words)
    if (SECTION_CONFIG[h] || m[1].trim().split(' ').length <= 4) {
      boldMatches.push({ index: m.index, header: h, fullMatch: m[0] })
    }
  }

  // Try numbered sections: "1. HEADER:" or "**1. HEADER**:"
  const numberedRegex = /(?:\*\*)?\d+\.\s+([\w'''\s]+?)(?:\*\*)?\s*:\s*/g
  const numberedMatches: Array<{ index: number; header: string }> = []
  while ((m = numberedRegex.exec(text)) !== null) {
    numberedMatches.push({ index: m.index, header: m[1].trim().toUpperCase() })
  }

  const useMatches = boldMatches.length >= 2 ? boldMatches : numberedMatches.length >= 2 ? numberedMatches : []

  if (useMatches.length === 0) {
    // No sections found — split on double newlines into paragraphs
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    if (paragraphs.length <= 1) return [{ header: '', body: text.trim() }]
    return paragraphs.map(p => ({ header: '', body: p }))
  }

  const sections: Array<{ header: string; body: string }> = []
  for (let i = 0; i < useMatches.length; i++) {
    const match = useMatches[i]
    const contentStart = match.index + ('fullMatch' in match ? (match as any).fullMatch.length : 0)
    const contentEnd = i + 1 < useMatches.length ? useMatches[i + 1].index : text.length
    const body = text.slice(contentStart, contentEnd).replace(/\*\*/g, '').trim()
    sections.push({ header: match.header, body })
  }

  return sections
}

function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded bg-white/6 animate-pulse"
          style={{ width: i === lines - 1 ? '55%' : `${95 - i * 5}%` }}
        />
      ))}
    </div>
  )
}

export default function AnalysisPanel({ signalId }: { signalId: string }) {
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    async function fetchAnalysis() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/signal-analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signal_id: signalId }),
          signal: controller.signal,
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        const data: AnalysisResult = await res.json()
        setResult(data)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        setError(e instanceof Error ? e.message : 'Failed to load analysis')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    fetchAnalysis()
    return () => controller.abort()
  }, [signalId])

  const groupedSources: Partial<Record<SourceLink['type'], SourceLink[]>> = {}
  if (result?.sources) {
    for (const s of result.sources) {
      if (!groupedSources[s.type]) groupedSources[s.type] = []
      groupedSources[s.type]!.push(s)
    }
  }
  const hasSources = result?.sources && result.sources.length > 0
  const sections = result ? parseAnalysis(result.analysis) : []
  const hasSections = sections.some(s => s.header)

  return (
    <>
      {/* Deep Analysis */}
      <div className="border border-white/[0.07] rounded-xl overflow-hidden">
        {/* Header bar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.07] bg-white/[0.02]">
          <Zap className="w-3.5 h-3.5 text-sky-400" />
          <span className="text-sm font-semibold text-white">Deep Analysis</span>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {loading && (
            <div className="flex flex-col gap-5">
              {[4, 3, 3, 3, 2].map((lines, i) => (
                <div key={i} className="flex flex-col gap-3">
                  <div className="h-3 w-28 rounded bg-white/10 animate-pulse" />
                  <SkeletonBlock lines={lines} />
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-red-500/10 border border-red-500/25 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span className="text-sm text-red-400">{error}</span>
            </div>
          )}

          {result && !loading && (
            hasSections ? (
              /* Sectioned layout */
              <div className="grid gap-3 sm:grid-cols-2">
                {sections.map((section, i) => {
                  const cfg = section.header ? SECTION_CONFIG[section.header] : null
                  if (!section.header) {
                    return (
                      <p key={i} className="sm:col-span-2 text-sm text-slate-300 leading-relaxed">
                        {section.body}
                      </p>
                    )
                  }
                  return (
                    <div
                      key={i}
                      className={`rounded-lg border p-3.5 flex flex-col gap-2 ${cfg?.bg ?? 'bg-white/3'} ${cfg?.border ?? 'border-white/10'}`}
                    >
                      {/* Section label */}
                      <div className={`flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest ${cfg?.color ?? 'text-slate-400'}`}>
                        {cfg?.icon}
                        {cfg?.label ?? section.header}
                      </div>
                      {/* Body */}
                      <p className="text-sm text-slate-300 leading-relaxed">{section.body}</p>
                    </div>
                  )
                })}
              </div>
            ) : (
              /* Unsectioned — render as paragraphs, never a wall of text */
              <div className="flex flex-col gap-4">
                {sections.map((s, i) => (
                  <p key={i} className="text-sm text-slate-300 leading-relaxed">{s.body}</p>
                ))}
              </div>
            )
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-white/[0.06] flex items-center gap-1.5 bg-white/[0.01]">
          <span className="text-[10px] text-slate-600">Powered by</span>
          <span className="text-[10px] text-sky-500 font-semibold">Groq AI</span>
          <span className="text-[10px] text-slate-600">· llama-3.3-70b-versatile</span>
        </div>
      </div>

      {/* Sources */}
      {hasSources && (
        <div className="border border-white/[0.07] rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.07] bg-white/[0.02]">
            <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-sm font-semibold text-white">Sources</span>
          </div>
          <div className="p-4 flex flex-col gap-4">
            {(Object.entries(groupedSources) as [SourceLink['type'], SourceLink[]][]).map(([type, links]) => (
              <div key={type} className="flex flex-col gap-1.5">
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">
                  {SOURCE_TYPE_LABELS[type]}
                </p>
                {links.map((link, i) => (
                  <a
                    key={i}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-sky-400 hover:text-white group"
                    style={{ transition: 'color 0.1s' }}
                  >
                    <ExternalLink className="w-3 h-3 shrink-0 opacity-50 group-hover:opacity-100" />
                    <span className="truncate">{link.title}</span>
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
