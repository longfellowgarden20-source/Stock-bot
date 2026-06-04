'use client'

import { useState, useRef } from 'react'
import { Search, Loader2, ChevronDown, ChevronUp, ExternalLink, TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react'

type TopPost = {
  title: string
  score: number
  comments: number
  subreddit: string
  url: string
}

type SentimentResult = {
  ticker: string
  verdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'MIXED'
  score: number
  summary: string
  watch: string
  post_count: number
  top_posts: TopPost[]
  generated_at: string
  error?: string
}

const VERDICT_CONFIG = {
  BULLISH: {
    label: 'BULLISH',
    bg: 'bg-green-500/15',
    border: 'border-green-500/30',
    text: 'text-green-400',
    icon: TrendingUp,
  },
  BEARISH: {
    label: 'BEARISH',
    bg: 'bg-red-500/15',
    border: 'border-red-500/30',
    text: 'text-red-400',
    icon: TrendingDown,
  },
  NEUTRAL: {
    label: 'NEUTRAL',
    bg: 'bg-slate-500/15',
    border: 'border-slate-500/30',
    text: 'text-slate-400',
    icon: Minus,
  },
  MIXED: {
    label: 'MIXED',
    bg: 'bg-yellow-500/15',
    border: 'border-yellow-500/30',
    text: 'text-yellow-400',
    icon: Minus,
  },
} as const

function ScoreBar({ score }: { score: number }) {
  const pct = ((score - 1) / 9) * 100
  const color =
    score >= 7 ? '#22c55e'
    : score <= 3 ? '#ef4444'
    : score >= 5 ? '#f59e0b'
    : '#ef4444'

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500 w-3 shrink-0 text-right">1</span>
      <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: color,
            opacity: 1,
          }}
        />
      </div>
      <span className="text-xs text-slate-500 w-3 shrink-0">10</span>
      <span className="text-xs font-bold tabular-nums" style={{ color }}>{score}/10</span>
    </div>
  )
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

export default function TickerSentiment() {
  const [ticker, setTicker] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SentimentResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const analyze = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const t = ticker.trim().toUpperCase()
    if (!t) return

    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/reddit-sentiment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: t }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }

      const data = (await res.json()) as SentimentResult
      setResult(data)
      setCollapsed(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sentiment')
    } finally {
      setLoading(false)
    }
  }

  const verdict = result?.verdict ?? 'NEUTRAL'
  const cfg = VERDICT_CONFIG[verdict] ?? VERDICT_CONFIG.NEUTRAL
  const Icon = cfg.icon

  return (
    <div className="bg-white/4 border border-white/10 rounded-2xl overflow-hidden">
      {/* Panel header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/4"
        style={{ transition: 'background 0.15s' }}
        aria-expanded={!collapsed}
        aria-label="Toggle Reddit Sentiment panel"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Reddit Sentiment</span>
          {result && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${cfg.bg} ${cfg.border} border ${cfg.text}`}>
              ${result.ticker}
            </span>
          )}
        </div>
        {collapsed
          ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
          : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
        }
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 flex flex-col gap-3">
          {/* Input */}
          <form onSubmit={analyze} className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-500 pointer-events-none">$</span>
              <input
                ref={inputRef}
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="NVDA"
                maxLength={10}
                className="w-full pl-6 pr-3 py-2 bg-white/6 border border-white/12 rounded-xl text-sm font-mono font-bold text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/60"
                style={{ transition: 'border-color 0.15s', fontSize: '16px' }}
                aria-label="Ticker symbol"
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              disabled={loading || !ticker.trim()}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 text-[#0ea5e9] rounded-xl hover:bg-[#0ea5e9]/25 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ transition: 'background 0.15s' }}
              aria-label="Analyze ticker"
            >
              {loading
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Search className="w-3.5 h-3.5" />
              }
              {loading ? 'Scanning…' : 'Analyze'}
            </button>
          </form>

          {/* Error state */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/25 rounded-xl">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}

          {/* Result card */}
          {result && !loading && (
            <div className="flex flex-col gap-3">
              {/* Verdict + score */}
              <div className={`flex items-center justify-between px-3 py-2.5 rounded-xl border ${cfg.bg} ${cfg.border}`}>
                <div className="flex items-center gap-2">
                  <Icon className={`w-4 h-4 ${cfg.text}`} />
                  <span className={`text-sm font-bold ${cfg.text}`}>{cfg.label}</span>
                </div>
                <span className="text-xs text-slate-400">{result.post_count} post{result.post_count !== 1 ? 's' : ''}</span>
              </div>

              {/* Score bar */}
              <ScoreBar score={result.score} />

              {/* Summary */}
              {result.summary && (
                <p className="text-xs text-slate-300 leading-relaxed">{result.summary}</p>
              )}

              {/* Watch callout */}
              {result.watch && (
                <div className="flex items-start gap-2 p-2.5 bg-[#f59e0b]/8 border border-[#f59e0b]/20 rounded-xl">
                  <span className="text-[#f59e0b] text-xs font-bold shrink-0">Watch:</span>
                  <span className="text-xs text-amber-200/80 leading-relaxed">{result.watch}</span>
                </div>
              )}

              {/* Top posts */}
              {result.top_posts.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Top mentions</p>
                  {result.top_posts.slice(0, 3).map((post, i) => (
                    <a
                      key={i}
                      href={post.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-2 p-2 rounded-lg bg-white/3 border border-white/8 hover:bg-white/6 hover:border-white/14 group"
                      style={{ transition: 'background 0.15s, border-color 0.15s' }}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-slate-300 leading-snug line-clamp-2 group-hover:text-white" style={{ transition: 'color 0.15s' }}>
                          {post.title}
                        </p>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          r/{post.subreddit} · ↑{post.score.toLocaleString()} · {post.comments} comments
                        </p>
                      </div>
                      <ExternalLink className="w-3 h-3 text-slate-600 shrink-0 mt-0.5 group-hover:text-slate-400" style={{ transition: 'color 0.15s' }} />
                    </a>
                  ))}
                </div>
              )}

              {/* Timestamp */}
              <p className="text-[10px] text-slate-600 text-right">
                Last checked: {timeAgo(result.generated_at)}
              </p>
            </div>
          )}

          {/* Empty prompt (no result yet) */}
          {!result && !loading && !error && (
            <p className="text-xs text-slate-600 text-center py-2">
              Enter a ticker to scan Reddit for sentiment
            </p>
          )}
        </div>
      )}
    </div>
  )
}
