'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, RefreshCw, Loader2, CheckCircle2, XCircle, X } from 'lucide-react'

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

// Each region corresponds to a <path> in the brain SVG below
const REGIONS = [
  { id: 'lessons',   label: 'Trade Memory',   sub: 'Ticker lessons',    color: '#2dd4bf', textX: 168, textY: 118 },
  { id: 'critiques', label: 'Self Review',     sub: 'Daily critiques',   color: '#c084fc', textX: 310, textY: 118 },
  { id: 'outlooks',  label: 'Market Sense',    sub: 'Morning outlooks',  color: '#fbbf24', textX: 120, textY: 230 },
  { id: 'feed',      label: 'Your Rules',      sub: 'Fed by you',        color: '#34d399', textX: 355, textY: 230 },
  { id: 'watchlist', label: 'Ticker Intel',    sub: 'Watchlist notes',   color: '#f87171', textX: 240, textY: 310 },
]

function RegionPanel({ regionId, data, onClose, onAdd, onDelete, saving }: {
  regionId: string; data: BrainData
  onClose: () => void
  onAdd: (c: string, t: string, cat: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  saving: boolean
}) {
  const region = REGIONS.find(r => r.id === regionId)!
  const [noteContent, setNoteContent] = useState('')
  const [noteTicker, setNoteTicker] = useState('')
  const [noteCategory, setNoteCategory] = useState('general')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const items: unknown[] =
    regionId === 'lessons' ? data.lessons :
    regionId === 'critiques' ? data.critiques :
    regionId === 'outlooks' ? data.outlooks :
    regionId === 'feed' ? data.brain_notes :
    data.watchlist_notes

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3 sm:p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg max-h-[82vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl"
        style={{ background: '#0c1211', border: `1px solid ${region.color}35` }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]"
          style={{ background: `linear-gradient(135deg, ${region.color}12, transparent)` }}>
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: region.color, boxShadow: `0 0 10px ${region.color}` }} />
          <div className="flex-1">
            <p className="text-sm font-bold text-white">{region.label}</p>
            <p className="text-[11px] text-slate-500">{region.sub}</p>
          </div>
          <span className="text-lg font-bold tabular-nums" style={{ color: region.color }}>{items.length}</span>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white ml-1 rounded-lg hover:bg-white/5">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Feed input */}
          {regionId === 'feed' && (
            <div className="p-4 border-b border-white/[0.06] flex flex-col gap-2.5">
              <div className="flex gap-2">
                <input value={noteTicker} onChange={e => setNoteTicker(e.target.value.toUpperCase())}
                  placeholder="Ticker" maxLength={5}
                  className="px-2.5 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 font-mono font-bold text-xs w-24 focus:outline-none focus:border-emerald-500/40" />
                <select value={noteCategory} onChange={e => setNoteCategory(e.target.value)}
                  className="flex-1 px-2.5 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-slate-300 text-xs focus:outline-none cursor-pointer" style={{ fontSize: '12px' }}>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value} className="bg-[#0c1211]">{c.label}</option>)}
                </select>
              </div>
              <textarea value={noteContent} onChange={e => setNoteContent(e.target.value)} rows={3}
                placeholder={`Tell Groq something it should know...\n"Never short PLTR before earnings"\n"Dark pool signals above sev 8 are very reliable"`}
                className="w-full px-3 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 text-xs resize-none focus:outline-none focus:border-emerald-500/40 leading-relaxed" />
              <button onClick={async () => { await onAdd(noteContent, noteTicker, noteCategory); setNoteContent(''); setNoteTicker('') }}
                disabled={!noteContent.trim() || saving}
                className="flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                style={{ background: 'rgba(52,211,153,0.18)', border: '1px solid rgba(52,211,153,0.3)' }}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Feed to Groq
              </button>
            </div>
          )}

          {/* Empty state */}
          {items.length === 0 && (
            <div className="py-12 text-center text-sm text-slate-500">
              {regionId === 'feed' ? 'No rules yet — write one above' : 'Nothing stored here yet'}
            </div>
          )}

          {/* Lessons */}
          {regionId === 'lessons' && (data.lessons as Lesson[]).map(l => {
            const ok = l.in_range && l.bias === l.actual_bias
            return (
              <div key={l.id} className="px-4 py-3 border-b border-white/[0.04] cursor-pointer hover:bg-white/[0.025]"
                onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-bold text-xs text-white font-mono">{l.ticker}</span>
                  <span className="text-[10px] text-slate-600">{l.date}</span>
                  {l.key_factors?.source === 'sandbox' && <span className="text-[10px] px-1 py-0.5 rounded border border-purple-500/25 text-purple-400 bg-purple-500/8">sandbox</span>}
                  {ok !== null && (ok ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <XCircle className="w-3 h-3 text-red-400" />)}
                </div>
                <p className={`text-xs text-slate-300 leading-relaxed ${expandedId === l.id ? '' : 'line-clamp-2'}`}>{l.lesson}</p>
              </div>
            )
          })}

          {/* Critiques */}
          {regionId === 'critiques' && (data.critiques as Critique[]).map(c => {
            const kf = c.key_factors as Record<string, unknown> | null
            const w = Number(kf?.wins ?? 0); const l2 = Number(kf?.losses ?? 0)
            const pnl = Number(kf?.gross_pnl ?? 0)
            const wr = w + l2 > 0 ? w / (w + l2) * 100 : 0
            return (
              <div key={c.id} className="px-4 py-3 border-b border-white/[0.04] cursor-pointer hover:bg-white/[0.025]"
                onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs font-bold text-white">{c.date}</span>
                  <span className={`text-xs font-semibold tabular-nums ${wr >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>{w}W/{l2}L</span>
                  <span className={`text-xs tabular-nums ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}</span>
                </div>
                <p className={`text-xs text-slate-300 leading-relaxed ${expandedId === c.id ? '' : 'line-clamp-2'}`}>{c.lesson}</p>
              </div>
            )
          })}

          {/* Outlooks */}
          {regionId === 'outlooks' && (data.outlooks as Outlook[]).map(o => (
            <div key={o.id} className="px-4 py-3 border-b border-white/[0.04] cursor-pointer hover:bg-white/[0.025]"
              onClick={() => setExpandedId(expandedId === o.id ? null : o.id)}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${o.direction === 'bullish' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' : o.direction === 'bearish' ? 'text-red-400 border-red-500/25 bg-red-500/8' : 'text-slate-400 border-white/10'}`}>{o.direction}</span>
                <span className="text-xs text-white">{o.date}</span>
                {o.spy_change != null && <span className={`text-xs tabular-nums ${o.spy_change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>SPY {o.spy_change >= 0 ? '+' : ''}{o.spy_change.toFixed(2)}%</span>}
                {o.vix != null && <span className="text-xs text-slate-500">VIX {o.vix.toFixed(1)}</span>}
              </div>
              <p className={`text-xs text-slate-300 leading-relaxed ${expandedId === o.id ? '' : 'line-clamp-2'}`}>{o.analysis}</p>
            </div>
          ))}

          {/* Your rules */}
          {regionId === 'feed' && (data.brain_notes as BrainNote[]).map(note => (
            <div key={note.id} className="flex items-start gap-3 px-4 py-3 border-b border-white/[0.04] hover:bg-white/[0.025]">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  {note.ticker && <span className="text-[10px] font-bold text-emerald-400 font-mono">{note.ticker}</span>}
                  <span className={`text-[10px] px-1 py-0.5 rounded border ${note.category === 'avoid' ? 'border-red-500/20 text-red-400' : note.category === 'pattern' ? 'border-yellow-500/20 text-yellow-400' : 'border-white/10 text-slate-500'}`}>
                    {CATEGORIES.find(c => c.value === note.category)?.label}
                  </span>
                  <span className="text-[10px] text-slate-600 ml-auto">{note.created_at.split('T')[0]}</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">{note.content}</p>
              </div>
              <button onClick={() => onDelete(note.id)} className="p-1.5 text-slate-600 hover:text-red-400 shrink-0 rounded">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          {/* Watchlist */}
          {regionId === 'watchlist' && data.watchlist_notes.map((n, i) => (
            <div key={i} className="px-4 py-3 border-b border-white/[0.04]">
              <span className="text-xs font-bold text-red-400 font-mono">{n.ticker}</span>
              <p className="text-xs text-slate-300 leading-relaxed mt-1">{n.notes}</p>
            </div>
          ))}
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
    try { setData(await (await fetch('/api/brain')).json()) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function addNote(content: string, ticker: string, category: string) {
    if (!content.trim()) return
    setSaving(true)
    try {
      await fetch('/api/brain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, ticker: ticker || null, category }) })
      await load()
    } finally { setSaving(false) }
  }

  async function deleteNote(id: string) {
    await fetch('/api/brain', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    await load()
  }

  const counts: Record<string, number> = data ? {
    lessons: data.lessons.length, critiques: data.critiques.length,
    outlooks: data.outlooks.length, feed: data.brain_notes.length,
    watchlist: data.watchlist_notes.length,
  } : {}

  const totalMemories = Object.values(counts).reduce((a, b) => a + b, 0)

  // Generate neuron dots based on data density
  const neuronDots: { x: number; y: number; color: string; dur: number; delay: number }[] = []
  if (data) {
    REGIONS.forEach((r, ri) => {
      const count = Math.min(counts[r.id] ?? 0, 15)
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2
        const dist = 18 + (i % 3) * 10
        neuronDots.push({
          x: r.textX + Math.cos(angle) * dist,
          y: r.textY + Math.sin(angle) * dist,
          color: r.color,
          dur: 1.8 + (i % 5) * 0.4,
          delay: ri * 0.2 + i * 0.12,
        })
      }
    })
  }

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white">Groq Brain</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {loading ? 'Loading…' : `${totalMemories} memories — click any region to explore`}
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 hover:text-white border border-white/[0.08] rounded-lg hover:bg-white/[0.04]">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Brain SVG — anatomically accurate top-down view */}
      <div className="flex justify-center select-none">
        <svg viewBox="0 0 480 360" className="w-full max-w-[560px]" style={{ filter: 'drop-shadow(0 8px 40px rgba(14,165,233,0.15))' }}>
          <defs>
            <radialGradient id="bgGrad" cx="50%" cy="45%" r="55%">
              <stop offset="0%" stopColor="#131c19" />
              <stop offset="100%" stopColor="#080c0b" />
            </radialGradient>
            <radialGradient id="glowL" cx="35%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#1e3a52" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#080c0b" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="glowR" cx="65%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#1e3a52" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#080c0b" stopOpacity="0" />
            </radialGradient>
            <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="regionGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            {REGIONS.map(r => (
              <radialGradient key={r.id} id={`fill-${r.id}`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={r.color} stopOpacity={hoveredRegion === r.id || activeRegion === r.id ? "0.28" : "0.1"} />
                <stop offset="100%" stopColor={r.color} stopOpacity="0.02" />
              </radialGradient>
            ))}
          </defs>

          {/* ── LEFT HEMISPHERE ── */}
          <g>
            {/* Main left hemisphere body */}
            <path d="
              M 238 28
              C 210 22 182 26 160 38
              C 136 28 108 32 90 50
              C 68 44 48 60 42 82
              C 22 88 10 110 14 136
              C 4 156 4 182 14 202
              C 6 224 10 250 24 268
              C 32 292 52 310 76 320
              C 96 334 122 340 148 338
              C 168 344 188 346 208 344
              C 220 344 232 342 238 338
              L 238 28 Z
            " fill="url(#bgGrad)" stroke="rgba(45, 212, 191,0.18)" strokeWidth="1.5" />

            {/* Left gyri — the folds that make it look like a brain */}
            <path d="M 238 65 C 210 58 185 62 168 72 C 150 58 128 62 112 76" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M 238 98 C 208 92 182 96 162 110 C 140 96 116 102 98 118" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 238 132 C 210 128 185 133 166 148 C 146 134 120 140 104 158" fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 238 168 C 212 163 188 168 170 182 C 150 170 125 175 110 192" fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 236 205 C 210 200 185 205 168 218 C 148 206 124 212 108 228" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 232 242 C 208 237 183 242 166 255 C 147 245 123 250 108 265" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 225 278 C 202 275 178 280 162 292 C 145 283 123 287 110 300" fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="1.5" strokeLinecap="round" />
            {/* Vertical sulci */}
            <path d="M 135 44 C 130 80 128 120 132 160 C 130 200 132 240 136 278" fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M 175 36 C 170 75 168 118 172 162 C 170 205 172 248 174 285" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1.5" strokeLinecap="round" />
          </g>

          {/* ── RIGHT HEMISPHERE ── */}
          <g>
            <path d="
              M 242 28
              C 270 22 298 26 320 38
              C 344 28 372 32 390 50
              C 412 44 432 60 438 82
              C 458 88 470 110 466 136
              C 476 156 476 182 466 202
              C 474 224 470 250 456 268
              C 448 292 428 310 404 320
              C 384 334 358 340 332 338
              C 312 344 292 346 272 344
              C 260 344 248 342 242 338
              L 242 28 Z
            " fill="url(#bgGrad)" stroke="rgba(45, 212, 191,0.18)" strokeWidth="1.5" />

            {/* Right gyri */}
            <path d="M 242 65 C 270 58 295 62 312 72 C 330 58 352 62 368 76" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M 242 98 C 272 92 298 96 318 110 C 340 96 364 102 382 118" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 242 132 C 270 128 295 133 314 148 C 334 134 360 140 376 158" fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 242 168 C 268 163 292 168 310 182 C 330 170 355 175 370 192" fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 244 205 C 270 200 295 205 312 218 C 332 206 356 212 372 228" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 248 242 C 272 237 297 242 314 255 C 333 245 357 250 372 265" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 255 278 C 278 275 302 280 318 292 C 335 283 357 287 370 300" fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M 345 44 C 350 80 352 120 348 160 C 350 200 348 240 344 278" fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M 305 36 C 310 75 312 118 308 162 C 310 205 308 248 306 285" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1.5" strokeLinecap="round" />
          </g>

          {/* ── CORPUS CALLOSUM (center division) ── */}
          <path d="M 240 22 L 240 342" stroke="rgba(45, 212, 191,0.22)" strokeWidth="1.5" strokeDasharray="4 3" />
          <ellipse cx="240" cy="182" rx="12" ry="60" fill="rgba(14,165,233,0.04)" stroke="rgba(14,165,233,0.1)" strokeWidth="1" />

          {/* ── BRAIN STEM ── */}
          <path d="M 218 338 C 214 348 213 358 216 365 C 219 372 221 372 224 365 C 226 358 226 348 224 338 Z
                   M 224 338 C 228 348 230 358 228 365 C 226 372 224 372 222 365 C 222 358 222 348 224 338 Z"
            fill="#0c1211" stroke="rgba(45, 212, 191,0.15)" strokeWidth="1" />

          {/* ── CLICKABLE REGION OVERLAYS ── */}
          {/* Trade Memory — left frontal */}
          <ellipse cx="152" cy="105" rx="72" ry="68"
            fill={`url(#fill-lessons)`}
            stroke={REGIONS[0].color} strokeWidth={hoveredRegion === 'lessons' || activeRegion === 'lessons' ? "1.8" : "0.8"} strokeOpacity={hoveredRegion === 'lessons' || activeRegion === 'lessons' ? "0.8" : "0.3"}
            style={{ cursor: 'pointer', transition: 'all 0.15s' }}
            onMouseEnter={() => setHoveredRegion('lessons')} onMouseLeave={() => setHoveredRegion(null)}
            onClick={() => setActiveRegion('lessons')} />

          {/* Self Review — right frontal */}
          <ellipse cx="328" cy="105" rx="72" ry="68"
            fill={`url(#fill-critiques)`}
            stroke={REGIONS[1].color} strokeWidth={hoveredRegion === 'critiques' || activeRegion === 'critiques' ? "1.8" : "0.8"} strokeOpacity={hoveredRegion === 'critiques' || activeRegion === 'critiques' ? "0.8" : "0.3"}
            style={{ cursor: 'pointer', transition: 'all 0.15s' }}
            onMouseEnter={() => setHoveredRegion('critiques')} onMouseLeave={() => setHoveredRegion(null)}
            onClick={() => setActiveRegion('critiques')} />

          {/* Market Sense — left temporal/parietal */}
          <ellipse cx="105" cy="228" rx="68" ry="72"
            fill={`url(#fill-outlooks)`}
            stroke={REGIONS[2].color} strokeWidth={hoveredRegion === 'outlooks' || activeRegion === 'outlooks' ? "1.8" : "0.8"} strokeOpacity={hoveredRegion === 'outlooks' || activeRegion === 'outlooks' ? "0.8" : "0.3"}
            style={{ cursor: 'pointer', transition: 'all 0.15s' }}
            onMouseEnter={() => setHoveredRegion('outlooks')} onMouseLeave={() => setHoveredRegion(null)}
            onClick={() => setActiveRegion('outlooks')} />

          {/* Your Rules — right temporal/parietal */}
          <ellipse cx="375" cy="228" rx="68" ry="72"
            fill={`url(#fill-feed)`}
            stroke={REGIONS[3].color} strokeWidth={hoveredRegion === 'feed' || activeRegion === 'feed' ? "1.8" : "0.8"} strokeOpacity={hoveredRegion === 'feed' || activeRegion === 'feed' ? "0.8" : "0.3"}
            style={{ cursor: 'pointer', transition: 'all 0.15s' }}
            onMouseEnter={() => setHoveredRegion('feed')} onMouseLeave={() => setHoveredRegion(null)}
            onClick={() => setActiveRegion('feed')} />

          {/* Ticker Intel — occipital */}
          <ellipse cx="240" cy="298" rx="82" ry="52"
            fill={`url(#fill-watchlist)`}
            stroke={REGIONS[4].color} strokeWidth={hoveredRegion === 'watchlist' || activeRegion === 'watchlist' ? "1.8" : "0.8"} strokeOpacity={hoveredRegion === 'watchlist' || activeRegion === 'watchlist' ? "0.8" : "0.3"}
            style={{ cursor: 'pointer', transition: 'all 0.15s' }}
            onMouseEnter={() => setHoveredRegion('watchlist')} onMouseLeave={() => setHoveredRegion(null)}
            onClick={() => setActiveRegion('watchlist')} />

          {/* ── PULSE RINGS on hover ── */}
          {REGIONS.map((r, i) => {
            const cx = [152, 328, 105, 375, 240][i]
            const cy = [105, 105, 228, 228, 298][i]
            if (hoveredRegion !== r.id && activeRegion !== r.id) return null
            return (
              <g key={r.id}>
                <circle cx={cx} cy={cy} r="45" fill="none" stroke={r.color} strokeWidth="1" opacity="0.5">
                  <animate attributeName="r" values="38;60;38" dur="1.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.5;0;0.5" dur="1.8s" repeatCount="indefinite" />
                </circle>
              </g>
            )
          })}

          {/* ── NEURON DOTS ── */}
          {neuronDots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r="2" fill={d.color} opacity="0">
              <animate attributeName="opacity" values="0;0.8;0" dur={`${d.dur}s`} begin={`${d.delay}s`} repeatCount="indefinite" />
            </circle>
          ))}

          {/* ── REGION LABELS ── */}
          {REGIONS.map((r, i) => {
            const isActive = hoveredRegion === r.id || activeRegion === r.id
            const count = counts[r.id] ?? 0
            return (
              <g key={r.id} style={{ pointerEvents: 'none' }}>
                <text x={r.textX} y={r.textY - 10} textAnchor="middle" fontSize="8.5" fontWeight="700"
                  fill={r.color} opacity={isActive ? 1 : 0.65}
                  style={{ fontFamily: 'var(--font-geist-sans)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {r.label}
                </text>
                <text x={r.textX} y={r.textY + 8} textAnchor="middle" fontSize="20" fontWeight="800"
                  fill={r.color} opacity={isActive ? 1 : 0.55} filter="url(#softGlow)">
                  {count}
                </text>
                <text x={r.textX} y={r.textY + 22} textAnchor="middle" fontSize="7.5" fill={r.color} opacity={isActive ? 0.7 : 0.35}
                  style={{ fontFamily: 'var(--font-geist-sans)' }}>
                  {r.sub}
                </text>
              </g>
            )
          })}

          {/* Center label */}
          <text x="240" y="192" textAnchor="middle" fontSize="7" fill="rgba(45, 212, 191,0.25)"
            style={{ fontFamily: 'var(--font-geist-sans)', letterSpacing: '0.12em' }}>
            GROQ NEURAL CORE
          </text>

          {/* Outer glow rim */}
          <path d="
            M 238 28 C 210 22 182 26 160 38 C 136 28 108 32 90 50 C 68 44 48 60 42 82
            C 22 88 10 110 14 136 C 4 156 4 182 14 202 C 6 224 10 250 24 268
            C 32 292 52 310 76 320 C 96 334 122 340 148 338 C 168 344 188 346 208 344
            C 220 344 232 342 238 338 L 238 28 Z
            M 242 28 C 270 22 298 26 320 38 C 344 28 372 32 390 50 C 412 44 432 60 438 82
            C 458 88 470 110 466 136 C 476 156 476 182 466 202 C 474 224 470 250 456 268
            C 448 292 428 310 404 320 C 384 334 358 340 332 338 C 312 344 292 346 272 344
            C 260 344 248 342 242 338 L 242 28 Z
          " fill="none" stroke="rgba(14,165,233,0.12)" strokeWidth="3" />
        </svg>
      </div>

      {/* Legend row */}
      <div className="flex flex-wrap justify-center gap-2">
        {REGIONS.map(r => (
          <button key={r.id} onClick={() => setActiveRegion(r.id)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium"
            style={{
              borderColor: hoveredRegion === r.id ? `${r.color}60` : `${r.color}20`,
              color: r.color, background: `${r.color}08`,
              transition: 'border-color 0.15s, background 0.15s',
            }}
            onMouseEnter={() => setHoveredRegion(r.id)}
            onMouseLeave={() => setHoveredRegion(null)}
          >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: r.color }} />
            {r.label}
            <span className="font-bold tabular-nums">{counts[r.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Region panel */}
      {activeRegion && data && (
        <RegionPanel regionId={activeRegion} data={data} onClose={() => setActiveRegion(null)}
          onAdd={addNote} onDelete={deleteNote} saving={saving} />
      )}
    </div>
  )
}
