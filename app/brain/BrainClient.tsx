'use client'

import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, RefreshCw, Loader2, CheckCircle2, XCircle, ChevronDown, ChevronUp, X } from 'lucide-react'

type Lesson = {
  id: string; ticker: string; date: string; bias: string | null
  actual_bias: string | null; in_range: boolean | null; lesson: string | null
  confidence_pct: number | null; key_factors: Record<string, unknown> | null
}
type Critique = {
  id: string; date: string; lesson: string | null
  confidence_pct: number | null; key_factors: Record<string, unknown> | null
}
type Outlook = {
  id: string; date: string; direction: string
  analysis: string | null; spy_change: number | null; vix: number | null
}
type BrainNote = {
  id: string; content: string; ticker: string | null; category: string; created_at: string
}
type BrainData = {
  lessons: Lesson[]; critiques: Critique[]; outlooks: Outlook[]
  watchlist_notes: { ticker: string; notes: string }[]
  brain_notes: BrainNote[]
}

const CATEGORIES = [
  { value: 'general', label: 'General Rule' },
  { value: 'ticker', label: 'Ticker Note' },
  { value: 'market', label: 'Market Condition' },
  { value: 'avoid', label: 'Avoid This' },
  { value: 'pattern', label: 'Pattern' },
]

// Brain regions — each maps to a data type
const BRAIN_REGIONS = [
  {
    id: 'lessons',
    label: 'Trade Memory',
    sublabel: 'Ticker lessons',
    color: '#0ea5e9',
    glow: 'rgba(14,165,233,0.4)',
    // SVG path for left temporal lobe area
    path: 'M 160 180 C 120 160 90 140 80 170 C 70 200 85 240 110 260 C 135 280 165 275 180 255 C 195 235 195 205 180 190 Z',
    cx: 130, cy: 220,
  },
  {
    id: 'critiques',
    label: 'Self Review',
    sublabel: 'Daily critiques',
    color: '#a855f7',
    glow: 'rgba(168,85,247,0.4)',
    // Prefrontal / frontal lobe
    path: 'M 200 100 C 175 80 155 85 145 105 C 135 125 140 155 160 168 C 180 181 205 178 220 162 C 235 146 235 118 220 105 Z',
    cx: 190, cy: 138,
  },
  {
    id: 'outlooks',
    label: 'Market Sense',
    sublabel: 'Morning outlooks',
    color: '#f59e0b',
    glow: 'rgba(245,158,11,0.4)',
    // Right parietal area
    path: 'M 290 130 C 310 110 335 115 345 140 C 355 165 345 195 325 208 C 305 221 280 215 268 195 C 256 175 260 148 278 135 Z',
    cx: 308, cy: 170,
  },
  {
    id: 'feed',
    label: 'Your Rules',
    sublabel: 'Fed by you',
    color: '#10b981',
    glow: 'rgba(16,185,129,0.4)',
    // Right temporal lobe
    path: 'M 300 210 C 320 195 345 200 355 225 C 365 250 350 285 325 295 C 300 305 275 292 265 270 C 255 248 268 222 288 213 Z',
    cx: 312, cy: 252,
  },
  {
    id: 'watchlist',
    label: 'Ticker Notes',
    sublabel: 'Watchlist intel',
    color: '#ef4444',
    glow: 'rgba(239,68,68,0.4)',
    // Bottom / cerebellum area
    path: 'M 195 285 C 175 270 155 275 148 298 C 141 321 155 348 180 355 C 205 362 232 350 238 326 C 244 302 228 278 210 277 Z',
    cx: 196, cy: 317,
  },
]

// The main brain outline SVG path
const BRAIN_OUTLINE = `M 220 60
  C 190 45 160 50 140 65
  C 110 50 80 60 70 90
  C 50 85 35 105 40 130
  C 25 145 20 170 30 195
  C 20 215 22 240 38 258
  C 42 280 55 298 75 308
  C 85 335 110 355 140 360
  C 155 375 175 380 200 378
  C 225 380 248 372 262 358
  C 290 355 315 338 325 312
  C 348 302 365 280 368 255
  C 382 238 385 210 375 188
  C 385 162 378 135 362 118
  C 358 90 340 72 315 65
  C 295 50 260 45 240 58 Z`

const BRAIN_STEM = `M 185 375 C 182 390 183 408 188 420 C 193 432 207 432 212 420 C 217 408 218 390 215 375 Z`

function PulseRing({ cx, cy, color, active }: { cx: number; cy: number; color: string; active: boolean }) {
  if (!active) return null
  return (
    <>
      <circle cx={cx} cy={cy} r="28" fill="none" stroke={color} strokeWidth="1.5" opacity="0.6">
        <animate attributeName="r" values="22;38;22" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.6;0;0.6" dur="2s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx} cy={cy} r="18" fill="none" stroke={color} strokeWidth="1" opacity="0.4">
        <animate attributeName="r" values="16;26;16" dur="2s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0;0.4" dur="2s" begin="0.5s" repeatCount="indefinite" />
      </circle>
    </>
  )
}

function NeuronDots({ data }: { data: BrainData | null }) {
  // Draw tiny dots representing data density
  if (!data) return null
  const dots: { x: number; y: number; color: string; delay: number }[] = []
  const rand = (seed: number, min: number, max: number) => min + ((seed * 7919) % (max - min))

  BRAIN_REGIONS.forEach((r, ri) => {
    const count = ri === 0 ? data.lessons.length :
      ri === 1 ? data.critiques.length :
      ri === 2 ? data.outlooks.length :
      ri === 3 ? data.brain_notes.length :
      data.watchlist_notes.length
    const capped = Math.min(count, 12)
    for (let i = 0; i < capped; i++) {
      dots.push({
        x: r.cx + rand(ri * 100 + i * 13, -25, 25),
        y: r.cy + rand(ri * 200 + i * 17, -20, 20),
        color: r.color,
        delay: (ri * 0.3 + i * 0.15),
      })
    }
  })

  return (
    <>
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r="2.5" fill={d.color} opacity="0.7">
          <animate attributeName="opacity" values="0.3;0.9;0.3" dur={`${2 + (i % 4) * 0.5}s`} begin={`${d.delay}s`} repeatCount="indefinite" />
        </circle>
      ))}
    </>
  )
}

function RegionPanel({ regionId, data, onClose, onAdd, onDelete, saving }: {
  regionId: string
  data: BrainData
  onClose: () => void
  onAdd: (content: string, ticker: string, category: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  saving: boolean
}) {
  const region = BRAIN_REGIONS.find(r => r.id === regionId)!
  const [noteContent, setNoteContent] = useState('')
  const [noteTicker, setNoteTicker] = useState('')
  const [noteCategory, setNoteCategory] = useState('general')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const items = regionId === 'lessons' ? data.lessons :
    regionId === 'critiques' ? data.critiques :
    regionId === 'outlooks' ? data.outlooks :
    regionId === 'feed' ? data.brain_notes :
    data.watchlist_notes

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl overflow-hidden"
        style={{ background: '#0d1220', border: `1px solid ${region.color}30` }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.07]" style={{ background: `${region.glow}10` }}>
          <div className="w-3 h-3 rounded-full" style={{ background: region.color, boxShadow: `0 0 8px ${region.color}` }} />
          <div>
            <p className="text-sm font-bold text-white">{region.label}</p>
            <p className="text-[11px] text-slate-500">{region.sublabel}</p>
          </div>
          <span className="ml-auto text-xs font-bold tabular-nums" style={{ color: region.color }}>{items.length}</span>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white ml-2">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">

          {/* Feed region — special add UI */}
          {regionId === 'feed' && (
            <div className="p-4 border-b border-white/[0.06]">
              <div className="flex gap-2 mb-2 flex-wrap">
                <input
                  value={noteTicker}
                  onChange={e => setNoteTicker(e.target.value.toUpperCase())}
                  placeholder="Ticker"
                  maxLength={5}
                  className="px-2.5 py-1.5 bg-white/[0.05] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono font-bold text-xs w-24"
                />
                <select
                  value={noteCategory}
                  onChange={e => setNoteCategory(e.target.value)}
                  className="px-2.5 py-1.5 bg-white/[0.05] border border-white/[0.08] rounded-lg text-slate-300 text-xs focus:outline-none cursor-pointer"
                  style={{ fontSize: '12px' }}
                >
                  {CATEGORIES.map(c => <option key={c.value} value={c.value} className="bg-[#0d1220]">{c.label}</option>)}
                </select>
              </div>
              <textarea
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
                placeholder={`Tell Groq something it should know...\n"Never short PLTR before earnings"\n"Dark pool signals above 8 are very reliable"`}
                rows={3}
                className="w-full px-3 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 text-xs resize-none focus:outline-none focus:border-emerald-500/50 leading-relaxed"
              />
              <button
                onClick={async () => { await onAdd(noteContent, noteTicker, noteCategory); setNoteContent(''); setNoteTicker('') }}
                disabled={!noteContent.trim() || saving}
                className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                style={{ background: 'rgba(16,185,129,0.2)', border: '1px solid rgba(16,185,129,0.3)' }}
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Feed to Groq
              </button>
            </div>
          )}

          {/* Items list */}
          <div className="flex flex-col divide-y divide-white/[0.04]">
            {items.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-slate-500">
                {regionId === 'feed' ? 'No notes yet — write one above' : 'Nothing here yet'}
              </div>
            )}

            {regionId === 'lessons' && (data.lessons as Lesson[]).map(l => {
              const correct = l.in_range && l.bias === l.actual_bias
              const isSandbox = l.key_factors?.source === 'sandbox'
              return (
                <div key={l.id} className="px-4 py-3 cursor-pointer hover:bg-white/[0.02]" onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-bold text-xs text-white font-mono">{l.ticker}</span>
                    <span className="text-[10px] text-slate-600">{l.date}</span>
                    {isSandbox && <span className="text-[10px] px-1 py-0.5 rounded border border-purple-500/20 text-purple-400">sandbox</span>}
                    {correct !== null && (correct ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <XCircle className="w-3 h-3 text-red-400" />)}
                  </div>
                  <p className={`text-xs text-slate-300 leading-relaxed ${expandedId === l.id ? '' : 'line-clamp-2'}`}>{l.lesson}</p>
                </div>
              )
            })}

            {regionId === 'critiques' && (data.critiques as Critique[]).map(c => {
              const kf = c.key_factors as Record<string, unknown> | null
              const wins = Number(kf?.wins ?? 0); const losses = Number(kf?.losses ?? 0)
              const pnl = Number(kf?.gross_pnl ?? 0)
              const wr = wins + losses > 0 ? wins / (wins + losses) * 100 : 0
              return (
                <div key={c.id} className="px-4 py-3 cursor-pointer hover:bg-white/[0.02]" onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-white">{c.date}</span>
                    <span className={`text-xs font-semibold tabular-nums ${wr >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>{wins}W/{losses}L</span>
                    <span className={`text-xs tabular-nums ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}</span>
                  </div>
                  <p className={`text-xs text-slate-300 leading-relaxed ${expandedId === c.id ? '' : 'line-clamp-2'}`}>{c.lesson}</p>
                </div>
              )
            })}

            {regionId === 'outlooks' && (data.outlooks as Outlook[]).map(o => (
              <div key={o.id} className="px-4 py-3 cursor-pointer hover:bg-white/[0.02]" onClick={() => setExpandedId(expandedId === o.id ? null : o.id)}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                    o.direction === 'bullish' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' :
                    o.direction === 'bearish' ? 'text-red-400 border-red-500/25 bg-red-500/8' :
                    'text-slate-400 border-white/10'
                  }`}>{o.direction}</span>
                  <span className="text-xs text-white">{o.date}</span>
                  {o.spy_change != null && <span className={`text-xs tabular-nums ${o.spy_change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>SPY {o.spy_change >= 0 ? '+' : ''}{o.spy_change.toFixed(2)}%</span>}
                  {o.vix != null && <span className="text-xs text-slate-500">VIX {o.vix.toFixed(1)}</span>}
                </div>
                <p className={`text-xs text-slate-300 leading-relaxed ${expandedId === o.id ? '' : 'line-clamp-2'}`}>{o.analysis}</p>
              </div>
            ))}

            {regionId === 'feed' && (data.brain_notes as BrainNote[]).map(note => (
              <div key={note.id} className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.02]">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {note.ticker && <span className="text-[10px] font-bold text-emerald-400 font-mono">{note.ticker}</span>}
                    <span className={`text-[10px] px-1 py-0.5 rounded border ${
                      note.category === 'avoid' ? 'border-red-500/20 text-red-400' :
                      note.category === 'pattern' ? 'border-yellow-500/20 text-yellow-400' :
                      'border-white/10 text-slate-500'
                    }`}>{CATEGORIES.find(c => c.value === note.category)?.label}</span>
                    <span className="text-[10px] text-slate-600 ml-auto">{note.created_at.split('T')[0]}</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">{note.content}</p>
                </div>
                <button onClick={() => onDelete(note.id)} className="p-1.5 text-slate-600 hover:text-red-400 shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}

            {regionId === 'watchlist' && data.watchlist_notes.map((n, i) => (
              <div key={i} className="px-4 py-3">
                <span className="text-xs font-bold text-red-400 font-mono">{n.ticker}</span>
                <p className="text-xs text-slate-300 leading-relaxed mt-1">{n.notes}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function BrainClient() {
  const [data, setData] = useState<BrainData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeRegion, setActiveRegion] = useState<string | null>(null)
  const [hoveredRegion, setHoveredRegion] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/brain')
      setData(await r.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function addNote(content: string, ticker: string, category: string) {
    if (!content.trim()) return
    setSaving(true)
    try {
      await fetch('/api/brain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, ticker: ticker || null, category }),
      })
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function deleteNote(id: string) {
    await fetch('/api/brain', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    await load()
  }

  const counts: Record<string, number> = data ? {
    lessons: data.lessons.length,
    critiques: data.critiques.length,
    outlooks: data.outlooks.length,
    feed: data.brain_notes.length,
    watchlist: data.watchlist_notes.length,
  } : {}

  const totalMemories = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            Groq Brain
            {loading && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {totalMemories} memories stored — click a region to explore or feed new information
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 hover:text-white border border-white/[0.08] rounded-lg hover:bg-white/[0.04]"
          style={{ transition: 'color 0.1s' }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Brain SVG */}
      <div className="relative flex justify-center">
        <svg
          viewBox="0 0 440 440"
          className="w-full max-w-[480px]"
          style={{ filter: 'drop-shadow(0 0 30px rgba(14,165,233,0.08))' }}
        >
          <defs>
            {BRAIN_REGIONS.map(r => (
              <radialGradient key={r.id} id={`grd-${r.id}`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={r.color} stopOpacity={hoveredRegion === r.id || activeRegion === r.id ? "0.35" : "0.12"} />
                <stop offset="100%" stopColor={r.color} stopOpacity="0.03" />
              </radialGradient>
            ))}
            <radialGradient id="brainGrd" cx="50%" cy="45%" r="55%">
              <stop offset="0%" stopColor="#0d1a2e" />
              <stop offset="100%" stopColor="#060c14" />
            </radialGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Brain stem */}
          <path d={BRAIN_STEM} fill="#0a1020" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />

          {/* Brain body */}
          <path d={BRAIN_OUTLINE} fill="url(#brainGrd)" stroke="rgba(14,165,233,0.25)" strokeWidth="1.5" />

          {/* Internal structure lines — sulci */}
          <path d="M 200 120 C 210 145 215 170 210 195" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5" />
          <path d="M 240 110 C 255 135 258 165 250 190" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5" />
          <path d="M 155 155 C 148 175 150 200 160 220" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5" />
          <path d="M 300 175 C 315 190 318 215 308 235" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5" />
          <path d="M 175 240 C 190 255 205 265 220 260" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5" />
          <path d="M 250 245 C 265 258 272 272 265 285" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5" />
          <path d="M 120 200 C 112 220 115 245 128 262" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />

          {/* Region fills — clickable */}
          {BRAIN_REGIONS.map(r => (
            <path
              key={r.id}
              d={r.path}
              fill={`url(#grd-${r.id})`}
              stroke={r.color}
              strokeWidth={hoveredRegion === r.id || activeRegion === r.id ? "2" : "1"}
              strokeOpacity={hoveredRegion === r.id || activeRegion === r.id ? "0.8" : "0.3"}
              style={{ cursor: 'pointer', transition: 'stroke-width 0.15s, stroke-opacity 0.15s' }}
              onMouseEnter={() => setHoveredRegion(r.id)}
              onMouseLeave={() => setHoveredRegion(null)}
              onClick={() => setActiveRegion(r.id)}
            />
          ))}

          {/* Neuron dots */}
          {data && <NeuronDots data={data} />}

          {/* Pulse rings on hover/active */}
          {BRAIN_REGIONS.map(r => (
            <PulseRing key={r.id} cx={r.cx} cy={r.cy} color={r.color} active={hoveredRegion === r.id || activeRegion === r.id} />
          ))}

          {/* Region labels */}
          {BRAIN_REGIONS.map(r => {
            const count = counts[r.id] ?? 0
            const isActive = hoveredRegion === r.id || activeRegion === r.id
            return (
              <g key={r.id} style={{ cursor: 'pointer', pointerEvents: 'none' }}>
                <text
                  x={r.cx}
                  y={r.cy - 6}
                  textAnchor="middle"
                  fontSize="9"
                  fontWeight="700"
                  fill={r.color}
                  opacity={isActive ? 1 : 0.7}
                  style={{ fontFamily: 'var(--font-geist-sans)', letterSpacing: '0.05em', textTransform: 'uppercase' }}
                >
                  {r.label}
                </text>
                <text
                  x={r.cx}
                  y={r.cy + 8}
                  textAnchor="middle"
                  fontSize="14"
                  fontWeight="800"
                  fill={r.color}
                  opacity={isActive ? 1 : 0.6}
                  filter="url(#glow)"
                >
                  {count}
                </text>
              </g>
            )
          })}

          {/* Center label */}
          <text x="218" y="215" textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.2)" style={{ fontFamily: 'var(--font-geist-sans)', letterSpacing: '0.1em' }}>
            GROQ
          </text>
          <text x="218" y="227" textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.12)" style={{ fontFamily: 'var(--font-geist-sans)', letterSpacing: '0.1em' }}>
            NEURAL CORE
          </text>
        </svg>

        {/* Hover tooltip */}
        {hoveredRegion && !activeRegion && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none">
            <div className="px-3 py-1.5 rounded-lg text-xs font-medium text-white border border-white/10 whitespace-nowrap"
              style={{ background: 'rgba(13,18,32,0.95)', backdropFilter: 'blur(8px)' }}>
              {BRAIN_REGIONS.find(r => r.id === hoveredRegion)?.label} — click to open
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-4">
        {BRAIN_REGIONS.map(r => (
          <button
            key={r.id}
            onClick={() => setActiveRegion(r.id)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border hover:opacity-100 opacity-70"
            style={{ borderColor: `${r.color}25`, background: `${r.color}08`, transition: 'opacity 0.1s' }}
          >
            <div className="w-2 h-2 rounded-full" style={{ background: r.color, boxShadow: `0 0 6px ${r.color}` }} />
            <span className="text-xs font-medium" style={{ color: r.color }}>{r.label}</span>
            <span className="text-[10px] font-bold tabular-nums" style={{ color: r.color }}>{counts[r.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Region panel modal */}
      {activeRegion && data && (
        <RegionPanel
          regionId={activeRegion}
          data={data}
          onClose={() => setActiveRegion(null)}
          onAdd={addNote}
          onDelete={deleteNote}
          saving={saving}
        />
      )}
    </div>
  )
}
