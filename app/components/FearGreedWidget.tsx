'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Loader2, ChevronDown, ChevronUp } from 'lucide-react'

type FearGreedData = {
  score: number
  label: string
  vix: number | null
  components: {
    base: number
    vix: number
    convergence: number
    severity: number
    convergence_count: number
    avg_severity: number
  }
  updated_at: string
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000 / 60)
  if (diff < 1) return 'just now'
  if (diff === 1) return '1 min ago'
  return `${diff} min ago`
}

function getLabelColor(label: string): string {
  if (label === 'Extreme Fear') return '#ef4444'
  if (label === 'Fear') return '#f97316'
  if (label === 'Neutral') return '#f59e0b'
  if (label === 'Greed') return '#22c55e'
  if (label === 'Extreme Greed') return '#16a34a'
  return '#94a3b8'
}

function Gauge({ score }: { score: number }) {
  // Semicircle: 180 degrees, from left (180deg) to right (0deg) on top half
  const radius = 56
  const cx = 72
  const cy = 72
  const startAngle = Math.PI // left
  const endAngle = 0         // right (full arc)
  const arcLength = Math.PI  // 180 degrees

  // Background arc path (full semicircle)
  const bgStart = {
    x: cx + radius * Math.cos(startAngle),
    y: cy + radius * Math.sin(startAngle),
  }
  const bgEnd = {
    x: cx + radius * Math.cos(endAngle),
    y: cy + radius * Math.sin(endAngle),
  }
  const bgPath = `M ${bgStart.x} ${bgStart.y} A ${radius} ${radius} 0 0 1 ${bgEnd.x} ${bgEnd.y}`

  // Value arc: 0-100 maps to 180deg-0deg
  const valueFraction = score / 100
  const valueAngle = startAngle - valueFraction * arcLength
  const valueEnd = {
    x: cx + radius * Math.cos(valueAngle),
    y: cy + radius * Math.sin(valueAngle),
  }
  const largeArc = valueFraction > 0.5 ? 1 : 0
  const valuePath = valueFraction > 0
    ? `M ${bgStart.x} ${bgStart.y} A ${radius} ${radius} 0 ${largeArc} 1 ${valueEnd.x} ${valueEnd.y}`
    : ''

  // Needle
  const needleAngle = startAngle - valueFraction * arcLength
  const needleLength = 42
  const needleTip = {
    x: cx + needleLength * Math.cos(needleAngle),
    y: cy + needleLength * Math.sin(needleAngle),
  }

  // Gauge color based on score
  let gaugeColor = '#ef4444'
  if (score > 80) gaugeColor = '#16a34a'
  else if (score > 60) gaugeColor = '#22c55e'
  else if (score > 40) gaugeColor = '#f59e0b'
  else if (score > 20) gaugeColor = '#f97316'

  // Zone color bands along the arc — 5 segments
  const zoneBands = [
    { from: 0.0, to: 0.2, color: '#ef4444' },
    { from: 0.2, to: 0.4, color: '#f97316' },
    { from: 0.4, to: 0.6, color: '#f59e0b' },
    { from: 0.6, to: 0.8, color: '#22c55e' },
    { from: 0.8, to: 1.0, color: '#16a34a' },
  ]

  return (
    <svg width="144" height="80" viewBox="0 0 144 80" className="overflow-visible" aria-hidden>
      {/* Zone bands */}
      {zoneBands.map(({ from, to, color }, i) => {
        const a1 = startAngle - from * arcLength
        const a2 = startAngle - to * arcLength
        const p1 = { x: cx + radius * Math.cos(a1), y: cy + radius * Math.sin(a1) }
        const p2 = { x: cx + radius * Math.cos(a2), y: cy + radius * Math.sin(a2) }
        const la = (to - from) > 0.5 ? 1 : 0
        return (
          <path
            key={i}
            d={`M ${p1.x} ${p1.y} A ${radius} ${radius} 0 ${la} 1 ${p2.x} ${p2.y}`}
            fill="none"
            stroke={color}
            strokeWidth={8}
            strokeOpacity={0.15}
          />
        )
      })}

      {/* Background arc */}
      <path d={bgPath} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={8} />

      {/* Value arc */}
      {valuePath && (
        <path d={valuePath} fill="none" stroke={gaugeColor} strokeWidth={8} strokeLinecap="round" />
      )}

      {/* Needle */}
      <line
        x1={cx}
        y1={cy}
        x2={needleTip.x}
        y2={needleTip.y}
        stroke="white"
        strokeWidth={2}
        strokeLinecap="round"
        strokeOpacity={0.9}
      />
      <circle cx={cx} cy={cy} r={4} fill={gaugeColor} />

      {/* Zone labels */}
      <text x="14" y="76" fontSize="7" fill="#ef4444" fillOpacity={0.7} textAnchor="middle">Fear</text>
      <text x="72" y="12" fontSize="7" fill="#f59e0b" fillOpacity={0.7} textAnchor="middle">Neutral</text>
      <text x="130" y="76" fontSize="7" fill="#22c55e" fillOpacity={0.7} textAnchor="middle">Greed</text>
    </svg>
  )
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <div className="flex justify-center">
        <div className="w-36 h-20 bg-white/5 rounded-lg animate-pulse" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="w-12 h-8 bg-white/5 rounded animate-pulse" />
        <div className="w-20 h-4 bg-white/5 rounded animate-pulse" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="h-12 bg-white/5 rounded-xl animate-pulse" />
        <div className="h-12 bg-white/5 rounded-xl animate-pulse" />
      </div>
    </div>
  )
}

export default function FearGreedWidget() {
  const [data, setData] = useState<FearGreedData | null>(null)
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch('/api/fear-greed')
      if (r.ok) setData(await r.json())
    } catch { /* network */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [fetchData])

  const labelColor = data ? getLabelColor(data.label) : '#94a3b8'

  return (
    <div className="bg-white/4 border border-white/10 rounded-2xl overflow-hidden mb-3">
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/4"
        style={{ transition: 'background 0.15s' }}
        aria-expanded={!collapsed}
        aria-label="Toggle Fear & Greed panel"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Fear & Greed</span>
          {data && (
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border"
              style={{
                color: labelColor,
                borderColor: `${labelColor}40`,
                background: `${labelColor}18`,
              }}
            >
              {data.score}
            </span>
          )}
        </div>
        {collapsed
          ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
          : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
        }
      </button>

      {!collapsed && (
        loading ? <Skeleton /> : data ? (
          <div className="px-4 pb-4 flex flex-col gap-3">
            {/* Gauge */}
            <div className="flex justify-center pt-1">
              <Gauge score={data.score} />
            </div>

            {/* Score + label */}
            <div className="flex flex-col items-center gap-1 -mt-1">
              <p className="text-3xl font-bold tabular-nums" style={{ color: labelColor }}>
                {data.score}
              </p>
              <p className="text-sm font-bold" style={{ color: labelColor }}>
                {data.label}
              </p>
            </div>

            {/* Breakdown */}
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1 p-2.5 bg-white/4 border border-white/8 rounded-xl">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">VIX</p>
                <p className="text-sm font-bold text-white tabular-nums">
                  {data.vix != null ? data.vix.toFixed(1) : '—'}
                </p>
                <p className={`text-[10px] font-semibold ${data.components.vix >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                  {data.components.vix >= 0 ? '+' : ''}{data.components.vix} pts
                </p>
              </div>
              <div className="flex flex-col gap-1 p-2.5 bg-white/4 border border-white/8 rounded-xl">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Signals 24h</p>
                <p className="text-sm font-bold text-white tabular-nums">
                  {data.components.convergence_count} conv.
                </p>
                <p className="text-[10px] text-slate-500">
                  avg sev {data.components.avg_severity}
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-slate-600">Updated {timeAgo(data.updated_at)}</p>
              <button
                onClick={e => { e.stopPropagation(); setLoading(true); fetchData() }}
                className="p-1 text-slate-600 hover:text-slate-400 rounded-md"
                style={{ transition: 'color 0.15s' }}
                aria-label="Refresh Fear & Greed"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
          </div>
        ) : (
          <div className="px-4 pb-4 text-center">
            <p className="text-xs text-slate-600 py-3">Unable to compute Fear & Greed index</p>
            <button
              onClick={() => { setLoading(true); fetchData() }}
              className="flex items-center gap-1.5 mx-auto px-3 py-1.5 text-xs text-slate-400 hover:text-white border border-white/10 rounded-lg hover:bg-white/5"
              style={{ transition: 'color 0.15s, background 0.15s' }}
            >
              <Loader2 className="w-3 h-3" /> Retry
            </button>
          </div>
        )
      )}
    </div>
  )
}
