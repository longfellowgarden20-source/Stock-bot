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

const SECTION_CONFIG: Record<string, { icon: React.ReactNode; color: string; border: string }> = {
  "WHAT'S HAPPENING": {
    icon: <Activity className="w-3.5 h-3.5" />,
    color: 'text-[#0ea5e9]',
    border: 'border-[#0ea5e9]/40',
  },
  'KEY LEVELS': {
    icon: <TrendingUp className="w-3.5 h-3.5" />,
    color: 'text-[#22c55e]',
    border: 'border-[#22c55e]/40',
  },
  'THESIS': {
    icon: <Zap className="w-3.5 h-3.5" />,
    color: 'text-[#f59e0b]',
    border: 'border-[#f59e0b]/40',
  },
  'RISKS': {
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
    color: 'text-[#ef4444]',
    border: 'border-[#ef4444]/40',
  },
  'TIMING': {
    icon: <Clock className="w-3.5 h-3.5" />,
    color: 'text-slate-300',
    border: 'border-slate-500/40',
  },
}

const SOURCE_TYPE_LABELS: Record<SourceLink['type'], string> = {
  news: 'News',
  sec_filing: 'SEC Filing',
  analyst: 'Analyst',
  reddit: 'Reddit',
  other: 'Source',
}

function parseAnalysis(text: string): Array<{ header: string; body: string }> {
  // Match numbered sections like "1. WHAT'S HAPPENING:" or "1. TIMING:"
  const sectionRegex = /\d+\.\s+([\w'''\s]+?):\s*/g
  const sections: Array<{ header: string; body: string }> = []

  let match
  const matches: Array<{ index: number; header: string }> = []
  while ((match = sectionRegex.exec(text)) !== null) {
    matches.push({ index: match.index, header: match[1].trim().toUpperCase() })
  }

  if (matches.length === 0) {
    return [{ header: '', body: text }]
  }

  for (let i = 0; i < matches.length; i++) {
    const start = text.indexOf(':', text.indexOf(matches[i].header)) + 1
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    const body = text.slice(start, end).trim()
    sections.push({ header: matches[i].header, body })
  }

  return sections
}

function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded-full bg-white/8 animate-pulse"
          style={{ width: i === lines - 1 ? '60%' : '100%', opacity: 1 - i * 0.1 }}
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
    let cancelled = false
    async function fetchAnalysis() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/signal-analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signal_id: signalId }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        const data: AnalysisResult = await res.json()
        if (!cancelled) setResult(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load analysis')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchAnalysis()
    return () => { cancelled = true }
  }, [signalId])

  // Group sources by type
  const groupedSources: Partial<Record<SourceLink['type'], SourceLink[]>> = {}
  if (result?.sources) {
    for (const s of result.sources) {
      if (!groupedSources[s.type]) groupedSources[s.type] = []
      groupedSources[s.type]!.push(s)
    }
  }
  const hasSourcess = result?.sources && result.sources.length > 0

  return (
    <>
      {/* Deep Analysis Card */}
      <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-[#0ea5e9]" />
          <p className="text-sm font-bold text-white">Deep Analysis</p>
        </div>

        {loading && (
          <div className="flex flex-col gap-5">
            {[4, 3, 3, 3, 2].map((lines, i) => (
              <div key={i} className="flex flex-col gap-3">
                <div className="h-3 w-32 rounded-full bg-white/10 animate-pulse" />
                <SkeletonBlock lines={lines} />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-xs text-red-400">{error}</span>
          </div>
        )}

        {result && !loading && (
          <div className="flex flex-col gap-4">
            {parseAnalysis(result.analysis).map((section, i) => {
              const cfg = section.header ? SECTION_CONFIG[section.header] : null
              if (!section.header) {
                return (
                  <p key={i} className="text-sm text-slate-300 leading-relaxed">
                    {section.body}
                  </p>
                )
              }
              return (
                <div
                  key={i}
                  className={`pl-3 border-l-2 ${cfg?.border ?? 'border-slate-500/40'}`}
                >
                  <div className={`flex items-center gap-1.5 mb-1 text-xs font-bold uppercase tracking-wide ${cfg?.color ?? 'text-slate-400'}`}>
                    {cfg?.icon}
                    {section.header}
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed">{section.body}</p>
                </div>
              )
            })}
          </div>
        )}

        <div className="pt-1 border-t border-white/6 flex items-center gap-1.5">
          <span className="text-[10px] text-slate-600 font-mono">Powered by</span>
          <span className="text-[10px] text-[#0ea5e9] font-bold font-mono">Groq AI</span>
          <span className="text-[10px] text-slate-600 font-mono">· llama-3.3-70b-versatile</span>
        </div>
      </div>

      {/* Source Links Card */}
      {hasSourcess && (
        <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <ExternalLink className="w-4 h-4 text-slate-400" />
            <p className="text-sm font-bold text-white">Sources</p>
          </div>
          {(Object.entries(groupedSources) as [SourceLink['type'], SourceLink[]][]).map(([type, links]) => (
            <div key={type} className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                {SOURCE_TYPE_LABELS[type]}
              </p>
              {links.map((link, i) => (
                <a
                  key={i}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-[#0ea5e9] hover:text-white group"
                  style={{ transitionProperty: 'color', transitionDuration: '0.15s' }}
                >
                  <ExternalLink className="w-3 h-3 shrink-0 opacity-60 group-hover:opacity-100" />
                  <span className="truncate">{link.title}</span>
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
