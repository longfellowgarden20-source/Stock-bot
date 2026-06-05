'use client'

import { useState, useEffect } from 'react'
import { Brain, Plus, Trash2, RefreshCw, Loader2, CheckCircle2, XCircle, TrendingUp, TrendingDown, Calendar, Zap, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react'

type Lesson = {
  id: string
  ticker: string
  date: string
  bias: string | null
  actual_bias: string | null
  in_range: boolean | null
  lesson: string | null
  confidence_pct: number | null
  key_factors: Record<string, unknown> | null
}

type Critique = {
  id: string
  date: string
  lesson: string | null
  confidence_pct: number | null
  key_factors: Record<string, unknown> | null
}

type Outlook = {
  id: string
  date: string
  direction: string
  analysis: string | null
  spy_change: number | null
  vix: number | null
}

type BrainNote = {
  id: string
  content: string
  ticker: string | null
  category: string
  created_at: string
}

type BrainData = {
  lessons: Lesson[]
  critiques: Critique[]
  outlooks: Outlook[]
  watchlist_notes: { ticker: string; notes: string }[]
  brain_notes: BrainNote[]
}

const CATEGORIES = [
  { value: 'general', label: 'General Rule' },
  { value: 'ticker', label: 'Ticker Note' },
  { value: 'market', label: 'Market Condition' },
  { value: 'avoid', label: 'Avoid This' },
  { value: 'pattern', label: 'Pattern I Noticed' },
]

function dirColor(d: string | null) {
  if (d === 'long' || d === 'bullish') return 'text-emerald-400'
  if (d === 'short' || d === 'bearish') return 'text-red-400'
  return 'text-slate-400'
}

function LessonRow({ lesson }: { lesson: Lesson }) {
  const [expanded, setExpanded] = useState(false)
  const correct = lesson.in_range && lesson.bias === lesson.actual_bias
  const isSandbox = lesson.key_factors?.source === 'sandbox'

  return (
    <div
      className="border-b border-white/[0.04] cursor-pointer hover:bg-white/[0.02]"
      onClick={() => setExpanded(e => !e)}
    >
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-sm text-white font-mono w-14 shrink-0">{lesson.ticker}</span>
        <span className="text-[10px] text-slate-600">{lesson.date}</span>
        {isSandbox && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-purple-500/20 text-purple-400 bg-purple-500/8">sandbox</span>
        )}
        <span className={`text-[10px] font-semibold uppercase ${dirColor(lesson.bias)}`}>{lesson.bias}</span>
        {lesson.actual_bias && lesson.bias !== lesson.actual_bias && (
          <>
            <span className="text-slate-600 text-[10px]">→ actual</span>
            <span className={`text-[10px] font-semibold uppercase ${dirColor(lesson.actual_bias)}`}>{lesson.actual_bias}</span>
          </>
        )}
        {correct !== null && (
          correct
            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            : <XCircle className="w-3.5 h-3.5 text-red-400" />
        )}
        <p className="text-xs text-slate-400 flex-1 min-w-0 truncate">{lesson.lesson}</p>
        <div className="ml-auto shrink-0">
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-600" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-600" />}
        </div>
      </div>
      {expanded && lesson.lesson && (
        <div className="px-4 pb-3">
          <p className="text-xs text-slate-300 leading-relaxed bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
            {lesson.lesson}
          </p>
        </div>
      )}
    </div>
  )
}

function CritiqueCard({ critique }: { critique: Critique }) {
  const [expanded, setExpanded] = useState(false)
  const kf = critique.key_factors as Record<string, unknown> | null
  const wins = Number(kf?.wins ?? 0)
  const losses = Number(kf?.losses ?? 0)
  const pnl = Number(kf?.gross_pnl ?? 0)
  const wr = wins + losses > 0 ? wins / (wins + losses) * 100 : 0

  return (
    <div className="border border-white/[0.07] rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <button className="w-full flex items-center gap-3 px-4 py-3 text-left" onClick={() => setExpanded(e => !e)}>
        <Brain className="w-4 h-4 text-purple-400 shrink-0" />
        <span className="text-xs font-bold text-white">{critique.date}</span>
        <span className={`text-xs font-semibold tabular-nums ${wr >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
          {wins}W/{losses}L ({wr.toFixed(0)}%)
        </span>
        <span className={`text-xs font-semibold tabular-nums ml-1 ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          ${pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
        </span>
        <div className="ml-auto">
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-600" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-600" />}
        </div>
      </button>
      {expanded && critique.lesson && (
        <div className="px-4 pb-4 border-t border-white/[0.05]">
          <div className="mt-3 text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
            {critique.lesson}
          </div>
        </div>
      )}
    </div>
  )
}

export default function BrainClient() {
  const [data, setData] = useState<BrainData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'feed' | 'lessons' | 'critiques' | 'outlooks'>('feed')
  const [noteContent, setNoteContent] = useState('')
  const [noteTicker, setNoteTicker] = useState('')
  const [noteCategory, setNoteCategory] = useState('general')
  const [saving, setSaving] = useState(false)
  const [tickerFilter, setTickerFilter] = useState('')

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

  async function addNote() {
    if (!noteContent.trim()) return
    setSaving(true)
    try {
      await fetch('/api/brain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent, ticker: noteTicker || null, category: noteCategory }),
      })
      setNoteContent('')
      setNoteTicker('')
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

  const filteredLessons = (data?.lessons ?? []).filter(l =>
    !tickerFilter || l.ticker.toUpperCase().includes(tickerFilter.toUpperCase())
  )

  const tabs = [
    { id: 'feed' as const, label: 'Feed Groq', icon: <MessageSquare className="w-3.5 h-3.5" /> },
    { id: 'lessons' as const, label: `Lessons (${data?.lessons.length ?? 0})`, icon: <Zap className="w-3.5 h-3.5" /> },
    { id: 'critiques' as const, label: `Self-Critiques (${data?.critiques.length ?? 0})`, icon: <Brain className="w-3.5 h-3.5" /> },
    { id: 'outlooks' as const, label: `Outlooks (${data?.outlooks.length ?? 0})`, icon: <Calendar className="w-3.5 h-3.5" /> },
  ]

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5 text-purple-400 shrink-0" />
          <div>
            <h1 className="text-lg font-bold text-white">Groq Brain</h1>
            <p className="text-xs text-slate-500">View what Groq has learned — and teach it new things</p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 hover:text-white border border-white/[0.08] rounded-lg hover:bg-white/[0.04]"
          style={{ transition: 'color 0.1s' }}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {/* Stats bar */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Ticker Lessons', value: data.lessons.length, color: 'text-sky-400' },
            { label: 'Self-Critiques', value: data.critiques.length, color: 'text-purple-400' },
            { label: 'Market Outlooks', value: data.outlooks.length, color: 'text-yellow-400' },
            { label: 'Your Notes', value: data.brain_notes.length, color: 'text-emerald-400' },
          ].map(s => (
            <div key={s.label} className="border border-white/[0.07] rounded-xl p-3 flex flex-col gap-0.5" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">{s.label}</p>
              <p className={`text-2xl font-bold tabular-nums ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto scrollbar-none border-b border-white/[0.07]">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 -mb-px shrink-0 ${activeTab === tab.id ? 'border-sky-400 text-sky-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
            style={{ transition: 'color 0.1s' }}
          >
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>

      {/* FEED TAB — user writes notes to Groq */}
      {activeTab === 'feed' && (
        <div className="flex flex-col gap-4">
          <div className="border border-white/[0.07] rounded-xl p-4 flex flex-col gap-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-xs font-semibold text-white">Write a note to Groq</p>
            <p className="text-xs text-slate-500">
              Groq reads these before every trade decision. Use this to share observations, rules, or context it doesn't have.
            </p>

            <div className="flex gap-2 flex-wrap">
              <input
                value={noteTicker}
                onChange={e => setNoteTicker(e.target.value.toUpperCase())}
                placeholder="Ticker (optional)"
                maxLength={5}
                className="px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50 font-mono font-bold text-sm w-32"
                style={{ transition: 'border-color 0.1s' }}
              />
              <select
                value={noteCategory}
                onChange={e => setNoteCategory(e.target.value)}
                className="px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-slate-300 focus:outline-none focus:border-sky-500/50 text-xs cursor-pointer"
                style={{ fontSize: '13px' }}
              >
                {CATEGORIES.map(c => (
                  <option key={c.value} value={c.value} className="bg-[#0d1220]">{c.label}</option>
                ))}
              </select>
            </div>

            <textarea
              value={noteContent}
              onChange={e => setNoteContent(e.target.value)}
              placeholder={`Example: "PLTR always dumps 3-5% after earnings even when it beats — don't hold through earnings"\n"Never short tech on Mondays — tends to gap up"\n"When VIX > 25 and SPY is down, dark pool signals are more reliable than usual"`}
              rows={4}
              className="px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50 text-sm resize-none leading-relaxed"
              style={{ transition: 'border-color 0.1s' }}
            />

            <button
              onClick={addNote}
              disabled={!noteContent.trim() || saving}
              className="flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: 'rgba(14,165,233,0.2)', border: '1px solid rgba(14,165,233,0.3)', transition: 'opacity 0.1s' }}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Feed to Groq'}
            </button>
          </div>

          {/* Existing notes */}
          {(data?.brain_notes ?? []).length > 0 && (
            <div className="border border-white/[0.07] rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.07] bg-white/[0.02]">
                <p className="text-xs font-semibold text-white">Your notes ({data!.brain_notes.length})</p>
                <p className="text-[11px] text-slate-500 mt-0.5">Groq reads all of these before every trade decision</p>
              </div>
              <div className="flex flex-col">
                {data!.brain_notes.map(note => (
                  <div key={note.id} className="flex items-start gap-3 px-4 py-3 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {note.ticker && (
                          <span className="text-[10px] font-bold text-sky-400 font-mono">{note.ticker}</span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          note.category === 'avoid' ? 'border-red-500/20 text-red-400 bg-red-500/8' :
                          note.category === 'pattern' ? 'border-yellow-500/20 text-yellow-400 bg-yellow-500/8' :
                          note.category === 'market' ? 'border-sky-500/20 text-sky-400 bg-sky-500/8' :
                          'border-white/10 text-slate-400'
                        }`}>
                          {CATEGORIES.find(c => c.value === note.category)?.label ?? note.category}
                        </span>
                        <span className="text-[10px] text-slate-600 ml-auto">{note.created_at.split('T')[0]}</span>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">{note.content}</p>
                    </div>
                    <button
                      onClick={() => deleteNote(note.id)}
                      className="shrink-0 p-1.5 text-slate-600 hover:text-red-400 rounded"
                      style={{ transition: 'color 0.1s' }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(data?.brain_notes ?? []).length === 0 && !loading && (
            <div className="border border-white/[0.07] rounded-xl p-8 text-center flex flex-col items-center gap-2">
              <MessageSquare className="w-8 h-8 text-slate-700" />
              <p className="text-sm text-slate-400">No notes yet</p>
              <p className="text-xs text-slate-600">Write something above — Groq will read it before every trade.</p>
            </div>
          )}
        </div>
      )}

      {/* LESSONS TAB */}
      {activeTab === 'lessons' && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              value={tickerFilter}
              onChange={e => setTickerFilter(e.target.value.toUpperCase())}
              placeholder="Filter by ticker…"
              className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50 text-xs font-mono w-40"
              style={{ transition: 'border-color 0.1s' }}
            />
            <span className="text-xs text-slate-600 self-center">{filteredLessons.length} lessons</span>
          </div>

          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-600" /></div>
          ) : filteredLessons.length === 0 ? (
            <div className="border border-white/[0.07] rounded-xl p-8 text-center">
              <p className="text-sm text-slate-400">No lessons yet</p>
              <p className="text-xs text-slate-600 mt-1">Lessons appear after sandbox trades close.</p>
            </div>
          ) : (
            <div className="border border-white/[0.07] rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.07] bg-white/[0.02] grid grid-cols-[56px_80px_auto_20px] gap-3 text-[10px] text-slate-500 uppercase tracking-wider">
                <span>Ticker</span><span>Date</span><span>Lesson</span><span />
              </div>
              {filteredLessons.map(l => <LessonRow key={l.id} lesson={l} />)}
            </div>
          )}
        </div>
      )}

      {/* CRITIQUES TAB */}
      {activeTab === 'critiques' && (
        <div className="flex flex-col gap-3">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-600" /></div>
          ) : (data?.critiques ?? []).length === 0 ? (
            <div className="border border-white/[0.07] rounded-xl p-8 text-center">
              <p className="text-sm text-slate-400">No self-critiques yet</p>
              <p className="text-xs text-slate-600 mt-1">Groq reviews its trades every day at 5pm ET and writes a critique.</p>
            </div>
          ) : (
            (data?.critiques ?? []).map(c => <CritiqueCard key={c.id} critique={c} />)
          )}
        </div>
      )}

      {/* OUTLOOKS TAB */}
      {activeTab === 'outlooks' && (
        <div className="flex flex-col gap-2">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-600" /></div>
          ) : (data?.outlooks ?? []).length === 0 ? (
            <div className="border border-white/[0.07] rounded-xl p-8 text-center">
              <p className="text-sm text-slate-400">No morning outlooks yet</p>
              <p className="text-xs text-slate-600 mt-1">Outlooks are generated at 8am ET on weekdays.</p>
            </div>
          ) : (
            (data?.outlooks ?? []).map(o => {
              const [exp, setExp] = useState(false)
              return (
                <div key={o.id} className="border border-white/[0.07] rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)' }}>
                  <button className="w-full flex items-center gap-3 px-4 py-3 text-left" onClick={() => setExp(e => !e)}>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase ${
                      o.direction === 'bullish' ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/8' :
                      o.direction === 'bearish' ? 'text-red-400 border-red-500/25 bg-red-500/8' :
                      'text-slate-400 border-white/10'
                    }`}>{o.direction}</span>
                    <span className="text-xs font-semibold text-white">{o.date}</span>
                    {o.spy_change != null && (
                      <span className={`text-xs tabular-nums ${o.spy_change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        SPY {o.spy_change >= 0 ? '+' : ''}{o.spy_change.toFixed(2)}%
                      </span>
                    )}
                    {o.vix != null && (
                      <span className="text-xs text-slate-500">VIX {o.vix.toFixed(1)}</span>
                    )}
                    <div className="ml-auto">
                      {exp ? <ChevronUp className="w-3.5 h-3.5 text-slate-600" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-600" />}
                    </div>
                  </button>
                  {exp && o.analysis && (
                    <div className="px-4 pb-4 border-t border-white/[0.05]">
                      <p className="text-xs text-slate-300 leading-relaxed mt-3 whitespace-pre-wrap">{o.analysis}</p>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
