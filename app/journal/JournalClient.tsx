'use client'

import { useState, useMemo, useCallback, useRef } from 'react'
import {
  BookOpen, TrendingUp, TrendingDown, Brain, Calendar,
  Plus, Loader2, CheckCircle, ChevronLeft, ChevronRight,
  BarChart2, Sparkles, AlertTriangle, Star, Upload, X, FileText, RefreshCw,
  Target, Zap, ChevronDown, ChevronUp,
} from 'lucide-react'
import type { ParsedRow } from '@/app/api/trades/import/route'

// ─── Prediction Types ─────────────────────────────────────────────────────────

export type EodPrediction = {
  id: string
  ticker: string
  date: string
  open_price: number | null
  predicted_low: number | null
  predicted_high: number | null
  bias: 'bullish' | 'bearish' | 'neutral'
  confidence_pct: number | null
  key_factors: string[] | null
  invalidation_level: number | null
  analysis: string | null
  actual_close: number | null
  error_pct: number | null
  created_at: string
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type Trade = {
  id: string
  date: string
  ticker: string
  direction: 'long' | 'short'
  entry_price: number
  exit_price: number | null
  shares: number
  pnl: number | null
  pattern: string | null
  grade: string | null
  grade_accurate: boolean | null
  writeup: string | null
  mistakes: string[] | null
  best_ops: string | null
  created_at: string
}

export type CoachingNote = {
  id: string
  generated_at: string
  period: string
  note: string
  tendencies: Record<string, number> | null
  trade_count: number | null
  win_rate: number | null
}

export type PredictionLesson = {
  id: string
  ticker: string
  date: string
  bias: string | null
  actual_bias: string | null
  in_range: boolean | null
  predicted_low: number | null
  predicted_high: number | null
  actual_close: number | null
  confidence_pct: number | null
  lesson: string | null
  key_factors: string[] | null
}

export type BriefSignal = {
  id: string
  ticker: string
  title: string
  body: string
  created_at: string
  raw_data: {
    tickers?: string[]
    mention_counts?: Record<string, number>
    date?: string
  } | null
}

const GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C', 'D', 'F']
const MISTAKE_OPTIONS = [
  'No man\'s land',
  'Oversize',
  'Chased entry',
  'Ignored stop',
  'Wrong execution',
  'FOMO',
  'Revenge trade',
  'Cut winner early',
]
const MOOD_OPTIONS = ['focused', 'confident', 'neutral', 'distracted', 'anxious'] as const

const TAB_NAMES = ['Today\'s Entry', 'Performance', 'Tendencies', 'Calendar', 'Predictions', 'Briefs'] as const
type TabName = typeof TAB_NAMES[number]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pnlColor(pnl: number | null) {
  if (pnl == null) return 'text-slate-400'
  if (pnl > 0) return 'text-[#22c55e]'
  if (pnl < 0) return 'text-[#ef4444]'
  return 'text-slate-400'
}

function formatPnl(pnl: number | null) {
  if (pnl == null) return '—'
  return (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2)
}

function gradeColor(grade: string | null) {
  if (!grade) return 'text-slate-500'
  if (grade.startsWith('A')) return 'text-[#22c55e]'
  if (grade.startsWith('B')) return 'text-[#0ea5e9]'
  if (grade === 'C') return 'text-[#f59e0b]'
  return 'text-[#ef4444]'
}

function toET(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-white/3 border border-white/8 rounded-2xl p-4 flex flex-col gap-1">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${accent ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

// ─── CSV Parser ──────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

const IMPORT_CODES = new Set(['Buy', 'Sell', 'BTO', 'STO', 'BTC', 'STC'])

type PreviewRow = {
  date: string
  ticker: string
  direction: 'long' | 'short' | 'open-long' | 'open-short'
  entry: number
  exit: number | null
  pnl: number | null
  status: 'Matched' | 'Open'
}

function parseRobinhoodCsv(text: string): { rows: ParsedRow[]; skipped: number; error: string | null } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return { rows: [], skipped: 0, error: 'CSV is empty or has no data rows.' }

  // Find header row
  const headerIdx = lines.findIndex((l) => l.toLowerCase().includes('activity date') || l.toLowerCase().includes('instrument'))
  if (headerIdx === -1) return { rows: [], skipped: 0, error: 'Could not find CSV header row. Expected "Activity Date, Instrument, Trans Code, Quantity, Price, Amount".' }

  const headers = parseCsvLine(lines[headerIdx]).map((h) => h.toLowerCase().replace(/\s+/g, '_'))

  const colIdx = {
    activityDate: headers.findIndex((h) => h.includes('activity_date') || h.includes('activity date')),
    instrument: headers.findIndex((h) => h.includes('instrument')),
    transCode: headers.findIndex((h) => h.includes('trans_code') || h.includes('trans code')),
    quantity: headers.findIndex((h) => h.includes('quantity')),
    price: headers.findIndex((h) => h.includes('price')),
    amount: headers.findIndex((h) => h.includes('amount')),
  }

  if (colIdx.activityDate === -1 || colIdx.instrument === -1 || colIdx.transCode === -1) {
    return { rows: [], skipped: 0, error: 'Missing required columns. Expected Activity Date, Instrument, Trans Code, Quantity, Price, Amount.' }
  }

  const rows: ParsedRow[] = []
  let skipped = 0
  const seen = new Set<string>()

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i])
    if (cells.length < 3) continue
    const transCode = cells[colIdx.transCode] ?? ''
    if (!IMPORT_CODES.has(transCode)) continue

    const instrument = cells[colIdx.instrument]?.toUpperCase().trim() ?? ''
    if (!instrument) { skipped++; continue }

    const quantity = parseFloat((cells[colIdx.quantity] ?? '0').replace(/,/g, ''))
    const price = parseFloat((cells[colIdx.price] ?? '0').replace(/[$,]/g, ''))
    const amount = parseFloat((cells[colIdx.amount] ?? '0').replace(/[$,]/g, ''))

    if (isNaN(quantity) || isNaN(price)) { skipped++; continue }

    // Deduplicate by composite key
    const dedupKey = `${cells[colIdx.activityDate]}|${instrument}|${transCode}|${quantity}|${price}`
    if (seen.has(dedupKey)) { skipped++; continue }
    seen.add(dedupKey)

    rows.push({
      activityDate: cells[colIdx.activityDate] ?? '',
      instrument,
      transCode,
      quantity: Math.abs(quantity),
      price: Math.abs(price),
      amount,
    })
  }

  if (rows.length === 0) return { rows: [], skipped, error: 'No importable rows found. Only Buy, Sell, BTO, STO, BTC, STC are imported.' }
  return { rows, skipped, error: null }
}

function fifoPreview(rows: ParsedRow[]): PreviewRow[] {
  const byTicker: Record<string, ParsedRow[]> = {}
  for (const row of rows) {
    const key = row.instrument.toUpperCase()
    if (!byTicker[key]) byTicker[key] = []
    byTicker[key].push(row)
  }

  const result: PreviewRow[] = []

  function parseDateStr(mmddyyyy: string): string {
    const parts = mmddyyyy.trim().split('/')
    if (parts.length !== 3) return mmddyyyy
    const [mm, dd, yyyy] = parts
    const y = yyyy.length === 2 ? `20${yyyy}` : yyyy
    if (!mm || !dd || !y || isNaN(Number(mm)) || isNaN(Number(dd)) || isNaN(Number(y))) return mmddyyyy
    return `${y}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  }

  for (const [ticker, tickerRows] of Object.entries(byTicker)) {
    const sorted = [...tickerRows].sort((a, b) =>
      new Date(parseDateStr(a.activityDate)).getTime() - new Date(parseDateStr(b.activityDate)).getTime()
    )

    const longBuys = sorted.filter((r) => r.transCode === 'Buy' || r.transCode === 'BTO').map((r) => ({ ...r, remaining: r.quantity }))
    const longSells = sorted.filter((r) => r.transCode === 'Sell' || r.transCode === 'STC').map((r) => ({ ...r, remaining: r.quantity }))
    const shortEntries = sorted.filter((r) => r.transCode === 'STO').map((r) => ({ ...r, remaining: r.quantity }))
    const shortExits = sorted.filter((r) => r.transCode === 'BTC').map((r) => ({ ...r, remaining: r.quantity }))

    // Match longs
    let bi = 0, si = 0
    while (bi < longBuys.length && si < longSells.length) {
      const buy = longBuys[bi], sell = longSells[si]
      const qty = Math.min(buy.remaining, sell.remaining)
      const pnl = Math.round(((sell.price - buy.price) * qty) * 100) / 100
      result.push({ date: parseDateStr(buy.activityDate), ticker, direction: 'long', entry: buy.price, exit: sell.price, pnl, status: 'Matched' })
      buy.remaining -= qty; sell.remaining -= qty
      if (buy.remaining <= 0) bi++
      if (sell.remaining <= 0) si++
    }
    while (bi < longBuys.length) {
      const buy = longBuys[bi]
      if (buy.remaining > 0) result.push({ date: parseDateStr(buy.activityDate), ticker, direction: 'open-long', entry: buy.price, exit: null, pnl: null, status: 'Open' })
      bi++
    }

    // Match shorts
    let sei = 0, sxi = 0
    while (sei < shortEntries.length && sxi < shortExits.length) {
      const entry = shortEntries[sei], exit = shortExits[sxi]
      const qty = Math.min(entry.remaining, exit.remaining)
      const pnl = Math.round(((entry.price - exit.price) * qty) * 100) / 100
      result.push({ date: parseDateStr(entry.activityDate), ticker, direction: 'short', entry: entry.price, exit: exit.price, pnl, status: 'Matched' })
      entry.remaining -= qty; exit.remaining -= qty
      if (entry.remaining <= 0) sei++
      if (exit.remaining <= 0) sxi++
    }
    while (sei < shortEntries.length) {
      const entry = shortEntries[sei]
      if (entry.remaining > 0) result.push({ date: parseDateStr(entry.activityDate), ticker, direction: 'open-short', entry: entry.price, exit: null, pnl: null, status: 'Open' })
      sei++
    }
  }

  return result.sort((a, b) => a.date.localeCompare(b.date))
}

// ─── Import Modal ─────────────────────────────────────────────────────────────

function RobinhoodImportModal({ onClose, onImported }: {
  onClose: () => void
  onImported: (trades: Trade[]) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const [parsedRows, setParsedRows] = useState<ParsedRow[] | null>(null)
  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; open: number; skipped: number } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [clientSkipped, setClientSkipped] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
      setParseError('Please select a .csv file.')
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const { rows, skipped: cs, error } = parseRobinhoodCsv(text)
      if (error) { setParseError(error); setParsedRows(null); setPreview(null); return }
      setParseError(null)
      setClientSkipped(cs)
      setParsedRows(rows)
      setPreview(fifoPreview(rows))
    }
    reader.readAsText(file)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  async function handleImport() {
    if (!parsedRows) return
    setImporting(true)
    setImportError(null)
    try {
      const res = await fetch('/api/trades/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: parsedRows }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Import failed')
      setImportResult({ imported: data.imported, open: data.open, skipped: (data.skipped ?? 0) + clientSkipped })
      onImported(data.trades ?? [])
    } catch (err) {
      setImportError(String(err))
    } finally {
      setImporting(false)
    }
  }

  const matchedCount = preview?.filter((r) => r.status === 'Matched').length ?? 0
  const openCount = preview?.filter((r) => r.status === 'Open').length ?? 0

  const inputCls = 'w-full bg-[#0d1424] border border-white/10 rounded-xl px-3 py-2 text-base sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/50 focus:ring-1 focus:ring-[#0ea5e9]/20'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-[#0d1420] border border-white/10 rounded-t-2xl sm:rounded-2xl p-4 sm:p-6 w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col gap-4 sm:gap-5 sm:mx-4">
        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 flex items-center justify-center">
              <FileText className="w-4 h-4 text-[#0ea5e9]" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Import from Robinhood</h2>
              <p className="text-xs text-slate-500">CSV trade history importer</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-500 hover:text-white hover:bg-white/8"
            style={{ transition: 'background 0.15s, color 0.15s' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!importResult ? (
          <>
            {/* Instructions */}
            <div className="bg-[#0ea5e9]/5 border border-[#0ea5e9]/15 rounded-xl p-3 text-xs text-slate-400 leading-relaxed">
              Download your trade history from Robinhood: <span className="text-white font-medium">Account → Statements → Export CSV</span>. The importer will match buys to sells using FIFO and calculate P&L automatically.
            </div>

            {/* Drop zone */}
            {!preview && (
              <div
                className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center gap-3 cursor-pointer ${dragOver ? 'border-[#0ea5e9]/60 bg-[#0ea5e9]/5' : 'border-white/10 hover:border-white/20 hover:bg-white/2'}`}
                style={{ transition: 'border-color 0.15s, background 0.15s' }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className={`w-8 h-8 ${dragOver ? 'text-[#0ea5e9]' : 'text-slate-600'}`} />
                <div className="text-center">
                  <p className="text-sm text-slate-300">Drop your CSV here or <span className="text-[#0ea5e9]">click to browse</span></p>
                  <p className="text-xs text-slate-600 mt-1">Supports Robinhood CSV export format</p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={handleInputChange}
                />
              </div>
            )}

            {parseError && (
              <div className="bg-[#ef4444]/8 border border-[#ef4444]/20 rounded-xl p-3 text-xs text-[#ef4444]">
                {parseError}
              </div>
            )}

            {/* Preview table */}
            {preview && preview.length > 0 && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Preview — {matchedCount} matched, {openCount} open
                  </h3>
                  <button
                    type="button"
                    onClick={() => { setParsedRows(null); setPreview(null); setParseError(null) }}
                    className="text-xs text-slate-500 hover:text-white flex items-center gap-1"
                    style={{ transition: 'color 0.15s' }}
                  >
                    <RefreshCw className="w-3 h-3" /> Choose different file
                  </button>
                </div>
                <div className="overflow-x-auto rounded-xl border border-white/8">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/8 bg-white/2">
                        {['Date', 'Ticker', 'Direction', 'Entry', 'Exit', 'P&L', 'Status'].map((h) => (
                          <th key={h} className="px-3 py-2 text-left text-slate-500 font-medium whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => {
                        const rowBg = row.status === 'Open'
                          ? 'bg-white/0'
                          : (row.pnl ?? 0) > 0
                            ? 'bg-[#22c55e]/5'
                            : (row.pnl ?? 0) < 0
                              ? 'bg-[#ef4444]/5'
                              : 'bg-white/0'
                        const isLong = row.direction === 'long' || row.direction === 'open-long'
                        return (
                          <tr key={i} className={`border-b border-white/5 last:border-0 ${rowBg}`}>
                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{row.date}</td>
                            <td className="px-3 py-2 font-bold text-white">{row.ticker}</td>
                            <td className="px-3 py-2">
                              {isLong
                                ? <span className="text-[#22c55e]">▲ Long</span>
                                : <span className="text-[#ef4444]">▼ Short</span>}
                            </td>
                            <td className="px-3 py-2 text-slate-400 tabular-nums">${row.entry.toFixed(2)}</td>
                            <td className="px-3 py-2 text-slate-400 tabular-nums">{row.exit != null ? `$${row.exit.toFixed(2)}` : '—'}</td>
                            <td className={`px-3 py-2 font-bold tabular-nums ${row.pnl == null ? 'text-slate-600' : row.pnl > 0 ? 'text-[#22c55e]' : row.pnl < 0 ? 'text-[#ef4444]' : 'text-slate-400'}`}>
                              {row.pnl == null ? '—' : (row.pnl >= 0 ? '+' : '') + '$' + Math.abs(row.pnl).toFixed(2)}
                            </td>
                            <td className="px-3 py-2">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${row.status === 'Matched' ? 'bg-[#0ea5e9]/10 border-[#0ea5e9]/20 text-[#0ea5e9]' : 'bg-white/5 border-white/10 text-slate-500'}`}>
                                {row.status}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {importError && (
                  <div className="bg-[#ef4444]/8 border border-[#ef4444]/20 rounded-xl p-3 text-xs text-[#ef4444]">
                    {importError}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleImport}
                  disabled={importing}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 text-[#0ea5e9] hover:bg-[#0ea5e9]/25 disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ transition: 'background 0.15s' }}
                >
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  {importing ? 'Importing…' : `Import ${matchedCount + openCount} trades`}
                </button>
              </div>
            )}
          </>
        ) : (
          /* Success state */
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="w-14 h-14 rounded-2xl bg-[#22c55e]/15 border border-[#22c55e]/30 flex items-center justify-center">
              <CheckCircle className="w-7 h-7 text-[#22c55e]" />
            </div>
            <div className="text-center">
              <p className="text-base font-bold text-white">Import complete</p>
              <p className="text-sm text-slate-400 mt-1">
                Imported <span className="text-white font-semibold">{importResult.imported}</span> closed trade{importResult.imported !== 1 ? 's' : ''}
                {importResult.open > 0 && <>, <span className="text-white font-semibold">{importResult.open}</span> open position{importResult.open !== 1 ? 's' : ''}</>}
                {importResult.skipped > 0 && <>, <span className="text-slate-500">{importResult.skipped}</span> skipped</>}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-2 rounded-xl text-sm font-semibold bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 text-[#0ea5e9] hover:bg-[#0ea5e9]/25"
              style={{ transition: 'background 0.15s' }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tab 1: Today's Entry ────────────────────────────────────────────────────

function TodayEntry({ trades, onTradeAdded }: { trades: Trade[]; onTradeAdded: (t: Trade) => void }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  const [showImport, setShowImport] = useState(false)
  const [ticker, setTicker] = useState('')
  const [direction, setDirection] = useState<'long' | 'short'>('long')
  const [entryPrice, setEntryPrice] = useState('')
  const [exitPrice, setExitPrice] = useState('')
  const [shares, setShares] = useState('')
  const [pattern, setPattern] = useState('')
  const [grade, setGrade] = useState('')
  const [gradeAccurate, setGradeAccurate] = useState<boolean | null>(null)
  const [writeup, setWriteup] = useState('')
  const [selectedMistakes, setSelectedMistakes] = useState<string[]>([])
  const [bestOps, setBestOps] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const todayTrades = useMemo(() => trades.filter((t) => t.date === today), [trades, today])

  function toggleMistake(m: string) {
    setSelectedMistakes((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ticker || !entryPrice || !shares) { setError('Ticker, entry price, and shares are required.'); return }
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: today,
          ticker: ticker.toUpperCase(),
          direction,
          entry_price: parseFloat(entryPrice),
          exit_price: exitPrice ? parseFloat(exitPrice) : null,
          shares: parseFloat(shares),
          pattern: pattern || null,
          grade: grade || null,
          grade_accurate: gradeAccurate,
          writeup: writeup || null,
          mistakes: selectedMistakes.length > 0 ? selectedMistakes : null,
          best_ops: bestOps || null,
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Failed'); }
      const newTrade = await res.json() as Trade
      onTradeAdded(newTrade)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
      setTicker(''); setEntryPrice(''); setExitPrice(''); setShares('')
      setPattern(''); setGrade(''); setGradeAccurate(null); setWriteup('')
      setSelectedMistakes([]); setBestOps('')
    } catch (err) {
      setError(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = 'w-full bg-[#0d1424] border border-white/10 rounded-xl px-3 py-2 text-base sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/50 focus:ring-1 focus:ring-[#0ea5e9]/20'

  return (
    <div className="flex flex-col gap-6">
      {showImport && (
        <RobinhoodImportModal
          onClose={() => setShowImport(false)}
          onImported={(newTrades) => {
            for (const t of newTrades) onTradeAdded(t)
          }}
        />
      )}

      {/* Trade Log Form */}
      <div className="bg-white/2 border border-white/8 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Plus className="w-4 h-4 text-[#0ea5e9]" /> Log a Trade
          </h2>
          <div className="flex flex-col items-end gap-0.5">
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white/4 border border-white/10 text-slate-400 hover:text-white hover:bg-white/8 hover:border-white/20"
              style={{ transition: 'background 0.15s, color 0.15s, border-color 0.15s' }}
            >
              <Upload className="w-3.5 h-3.5" />
              Import CSV
            </button>
            <span className="text-[10px] text-slate-600">Supports Robinhood CSV export</span>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Row 1: ticker + direction */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Ticker</label>
              <input
                className={inputCls + ' uppercase'}
                placeholder="AAPL"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Direction</label>
              <div className="flex gap-2">
                {(['long', 'short'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={`flex-1 py-2 rounded-xl text-sm font-medium border ${direction === d
                      ? d === 'long'
                        ? 'bg-[#22c55e]/15 border-[#22c55e]/30 text-[#22c55e]'
                        : 'bg-[#ef4444]/15 border-[#ef4444]/30 text-[#ef4444]'
                      : 'bg-white/3 border-white/10 text-slate-400 hover:text-white hover:bg-white/5'
                      }`}
                    style={{ transition: 'background 0.15s, color 0.15s' }}
                  >
                    {d === 'long' ? '▲' : '▼'} {d}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Row 2: entry, exit, shares */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Entry Price</label>
              <input className={inputCls} type="number" step="0.0001" placeholder="0.00" value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Exit Price</label>
              <input className={inputCls} type="number" step="0.0001" placeholder="0.00 (opt)" value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Shares</label>
              <input className={inputCls} type="number" step="0.01" placeholder="100" value={shares} onChange={(e) => setShares(e.target.value)} />
            </div>
          </div>

          {/* Row 3: pattern + grade + grade accurate */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Pattern</label>
              <input className={inputCls} placeholder="e.g. bull flag" value={pattern} onChange={(e) => setPattern(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Grade</label>
              <select
                className={inputCls + ' bg-[#0d1424]'}
                value={grade}
                onChange={(e) => setGrade(e.target.value)}
              >
                <option value="">— select —</option>
                {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Grade Accurate?</label>
              <div className="flex gap-2 mt-0.5">
                {([true, false] as const).map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    onClick={() => setGradeAccurate(gradeAccurate === v ? null : v)}
                    className={`flex-1 py-2 rounded-xl text-xs font-medium border ${gradeAccurate === v
                      ? v
                        ? 'bg-[#22c55e]/15 border-[#22c55e]/30 text-[#22c55e]'
                        : 'bg-[#ef4444]/15 border-[#ef4444]/30 text-[#ef4444]'
                      : 'bg-white/3 border-white/10 text-slate-500 hover:text-white hover:bg-white/5'
                      }`}
                    style={{ transition: 'background 0.15s, color 0.15s' }}
                  >
                    {v ? 'Yes' : 'No'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Writeup */}
          <div>
            <label className="block text-xs text-slate-500 mb-1">Writeup</label>
            <textarea
              className={inputCls + ' resize-none h-20'}
              placeholder="What happened? Why did you take this trade? How did you execute?"
              value={writeup}
              onChange={(e) => setWriteup(e.target.value)}
            />
          </div>

          {/* Mistakes */}
          <div>
            <label className="block text-xs text-slate-500 mb-2">Mistakes</label>
            <div className="flex flex-wrap gap-2">
              {MISTAKE_OPTIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleMistake(m)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border ${selectedMistakes.includes(m)
                    ? 'bg-[#f59e0b]/15 border-[#f59e0b]/30 text-[#f59e0b]'
                    : 'bg-white/3 border-white/8 text-slate-500 hover:text-white hover:bg-white/5'
                    }`}
                  style={{ transition: 'background 0.15s, color 0.15s' }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Best ops */}
          <div>
            <label className="block text-xs text-slate-500 mb-1">Best Ops of the Day</label>
            <textarea
              className={inputCls + ' resize-none h-16'}
              placeholder="What setups did you see? What was the ideal play?"
              value={bestOps}
              onChange={(e) => setBestOps(e.target.value)}
            />
          </div>

          {error && <p className="text-xs text-[#ef4444]">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 text-[#0ea5e9] hover:bg-[#0ea5e9]/25 disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ transition: 'background 0.15s' }}
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : success ? <CheckCircle className="w-4 h-4 text-[#22c55e]" /> : <Plus className="w-4 h-4" />}
            {submitting ? 'Saving…' : success ? 'Saved!' : 'Log Trade'}
          </button>
        </form>
      </div>

      {/* Today's trades */}
      {todayTrades.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Today&apos;s Trades</h3>
          {todayTrades.map((t) => (
            <TradeRow key={t.id} trade={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function TradeRow({ trade }: { trade: Trade }) {
  const [open, setOpen] = useState(false)
  const dirIcon = trade.direction === 'long'
    ? <TrendingUp className="w-3.5 h-3.5 text-[#22c55e]" />
    : <TrendingDown className="w-3.5 h-3.5 text-[#ef4444]" />

  return (
    <div className="bg-white/2 border border-white/8 rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/3 text-left"
        style={{ transition: 'background 0.15s' }}
      >
        <div className="flex items-center gap-1.5 w-20">
          {dirIcon}
          <span className="font-bold text-sm text-white">{trade.ticker}</span>
        </div>
        <span className="text-xs text-slate-500 w-24">{toET(trade.date)}</span>
        <span className="hidden sm:inline text-xs text-slate-400">in: ${Number(trade.entry_price).toFixed(2)}</span>
        {trade.exit_price && <span className="hidden sm:inline text-xs text-slate-400">out: ${Number(trade.exit_price).toFixed(2)}</span>}
        <span className={`ml-auto text-sm font-bold tabular-nums ${pnlColor(trade.pnl)}`}>{formatPnl(trade.pnl)}</span>
        {trade.grade && <span className={`text-xs font-bold ml-2 ${gradeColor(trade.grade)}`}>{trade.grade}</span>}
        <ChevronRight className={`w-4 h-4 text-slate-600 ml-2 ${open ? 'rotate-90' : ''}`} style={{ transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-2 border-t border-white/5">
          {trade.pattern && <p className="text-xs text-slate-400 mt-2"><span className="text-slate-600">Pattern:</span> {trade.pattern}</p>}
          {trade.writeup && <p className="text-xs text-slate-400"><span className="text-slate-600">Writeup:</span> {trade.writeup}</p>}
          {trade.mistakes && trade.mistakes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {trade.mistakes.map((m) => (
                <span key={m} className="px-2 py-0.5 rounded-full text-xs bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20">{m}</span>
              ))}
            </div>
          )}
          {trade.best_ops && <p className="text-xs text-slate-400"><span className="text-slate-600">Best ops:</span> {trade.best_ops}</p>}
        </div>
      )}
    </div>
  )
}

// ─── Tab 2: Performance ──────────────────────────────────────────────────────

function Performance({ trades }: { trades: Trade[] }) {
  const closed = useMemo(() => trades.filter((t) => t.pnl != null), [trades])
  const winners = useMemo(() => closed.filter((t) => (t.pnl ?? 0) > 0), [closed])
  const winRate = closed.length > 0 ? (winners.length / closed.length) * 100 : 0
  const totalPnl = closed.reduce((acc, t) => acc + (t.pnl ?? 0), 0)
  const avgPnl = closed.length > 0 ? totalPnl / closed.length : 0
  const bestTrade = closed.reduce((best, t) => (t.pnl ?? 0) > (best?.pnl ?? -Infinity) ? t : best, closed[0] ?? null)
  const worstTrade = closed.reduce((worst, t) => (t.pnl ?? 0) < (worst?.pnl ?? Infinity) ? t : worst, closed[0] ?? null)

  // By pattern
  const byPattern = useMemo(() => {
    const map: Record<string, { wins: number; total: number; pnl: number }> = {}
    for (const t of closed) {
      const key = t.pattern || 'No Pattern'
      if (!map[key]) map[key] = { wins: 0, total: 0, pnl: 0 }
      map[key].total++
      map[key].pnl += t.pnl ?? 0
      if ((t.pnl ?? 0) > 0) map[key].wins++
    }
    return Object.entries(map).sort((a, b) => b[1].total - a[1].total)
  }, [closed])

  // By grade bucket
  const byGrade = useMemo(() => {
    const buckets = [
      { label: 'A tier', grades: ['A+', 'A', 'A-'] },
      { label: 'B tier', grades: ['B+', 'B', 'B-'] },
      { label: 'C/D/F', grades: ['C', 'D', 'F'] },
    ]
    return buckets.map(({ label, grades }) => {
      const bucket = closed.filter((t) => t.grade && grades.includes(t.grade))
      const wins = bucket.filter((t) => (t.pnl ?? 0) > 0).length
      const pnl = bucket.reduce((acc, t) => acc + (t.pnl ?? 0), 0)
      const wr = bucket.length > 0 ? (wins / bucket.length) * 100 : 0
      return { label, total: bucket.length, wins, wr, pnl }
    })
  }, [closed])

  // Grade accuracy
  const gradeAccuracyCount = trades.filter((t) => t.grade_accurate === true).length
  const gradedCount = trades.filter((t) => t.grade_accurate != null).length
  const gradeAccuracyPct = gradedCount > 0 ? (gradeAccuracyCount / gradedCount) * 100 : null

  return (
    <div className="flex flex-col gap-6">
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label="Total Trades" value={String(trades.length)} sub={`${closed.length} closed`} />
        <StatCard label="Win Rate" value={closed.length > 0 ? `${winRate.toFixed(1)}%` : '—'} sub={`${winners.length}/${closed.length}`} accent={winRate >= 50 ? 'text-[#22c55e]' : 'text-[#ef4444]'} />
        <StatCard label="Total P&L" value={formatPnl(totalPnl)} accent={pnlColor(totalPnl)} />
        <StatCard label="Avg P&L / Trade" value={closed.length > 0 ? formatPnl(avgPnl) : '—'} accent={pnlColor(avgPnl)} />
        <StatCard label="Best Trade" value={bestTrade ? formatPnl(bestTrade.pnl) : '—'} sub={bestTrade?.ticker ?? ''} accent="text-[#22c55e]" />
        <StatCard label="Worst Trade" value={worstTrade ? formatPnl(worstTrade.pnl) : '—'} sub={worstTrade?.ticker ?? ''} accent="text-[#ef4444]" />
      </div>

      {/* Grade accuracy */}
      {gradeAccuracyPct != null && (
        <div className="bg-white/2 border border-white/8 rounded-2xl p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Star className="w-3.5 h-3.5 text-[#f59e0b]" /> Grade Accuracy
          </h3>
          <div className="flex items-center gap-4">
            <p className="text-3xl font-bold text-white tabular-nums">{gradeAccuracyPct.toFixed(1)}%</p>
            <p className="text-sm text-slate-400">of {gradedCount} self-graded trades marked accurate</p>
          </div>
        </div>
      )}

      {/* By pattern */}
      {byPattern.length > 0 && (
        <div className="bg-white/2 border border-white/8 rounded-2xl p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <BarChart2 className="w-3.5 h-3.5 text-[#0ea5e9]" /> P&L by Pattern
          </h3>
          <div className="flex flex-col gap-2">
            {byPattern.map(([pattern, stats]) => {
              const wr = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0
              return (
                <div key={pattern} className="flex items-center gap-3">
                  <span className="text-sm text-slate-300 w-36 truncate">{pattern}</span>
                  <span className="text-xs text-slate-500 w-12 tabular-nums">{stats.total} trades</span>
                  <span className={`text-xs tabular-nums w-16 ${wr >= 50 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{wr.toFixed(0)}% WR</span>
                  <span className={`text-sm font-bold tabular-nums ml-auto ${pnlColor(stats.pnl)}`}>{formatPnl(stats.pnl)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* By grade tier */}
      <div className="bg-white/2 border border-white/8 rounded-2xl p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Star className="w-3.5 h-3.5 text-[#22c55e]" /> P&L by Grade
        </h3>
        <div className="flex flex-col gap-3">
          {byGrade.map((bucket) => (
            <div key={bucket.label} className="flex items-center gap-3">
              <span className={`text-sm font-semibold w-16 ${bucket.label.startsWith('A') ? 'text-[#22c55e]' : bucket.label.startsWith('B') ? 'text-[#0ea5e9]' : 'text-[#ef4444]'}`}>{bucket.label}</span>
              <span className="text-xs text-slate-500 w-16 tabular-nums">{bucket.total} trades</span>
              {bucket.total > 0 && <span className={`text-xs w-14 tabular-nums ${bucket.wr >= 50 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{bucket.wr.toFixed(0)}% WR</span>}
              {bucket.total > 0 && <span className={`text-sm font-bold tabular-nums ml-auto ${pnlColor(bucket.pnl)}`}>{formatPnl(bucket.pnl)}</span>}
              {bucket.total === 0 && <span className="text-xs text-slate-600 ml-auto">no trades</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Recent trades table */}
      <div className="bg-white/2 border border-white/8 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Recent Trades</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/5">
                {['Date', 'Ticker', 'Dir', 'Entry', 'Exit', 'P&L', 'Grade', 'Pattern'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-slate-600 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 50).map((t) => (
                <tr key={t.id} className="border-b border-white/3 hover:bg-white/2">
                  <td className="px-3 py-2 text-slate-500">{toET(t.date)}</td>
                  <td className="px-3 py-2 font-bold text-white">{t.ticker}</td>
                  <td className="px-3 py-2">
                    {t.direction === 'long'
                      ? <span className="text-[#22c55e]">▲ L</span>
                      : <span className="text-[#ef4444]">▼ S</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-400 tabular-nums">${Number(t.entry_price).toFixed(2)}</td>
                  <td className="px-3 py-2 text-slate-400 tabular-nums">{t.exit_price ? `$${Number(t.exit_price).toFixed(2)}` : '—'}</td>
                  <td className={`px-3 py-2 font-bold tabular-nums ${pnlColor(t.pnl)}`}>{formatPnl(t.pnl)}</td>
                  <td className={`px-3 py-2 font-bold ${gradeColor(t.grade)}`}>{t.grade ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{t.pattern ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trades.length === 0 && (
            <p className="text-center py-8 text-slate-600 text-sm">No trades yet</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Tab 3: Tendencies ───────────────────────────────────────────────────────

function Tendencies({ trades, latestNote, onNoteGenerated }: {
  trades: Trade[]
  latestNote: CoachingNote | null
  onNoteGenerated: (note: CoachingNote) => void
}) {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [localNote, setLocalNote] = useState<CoachingNote | null>(latestNote)

  async function generate() {
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades: trades.filter((t) => t.pnl != null).slice(0, 30) }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Failed'); }
      const note = await res.json() as CoachingNote
      setLocalNote(note)
      onNoteGenerated(note)
    } catch (err) {
      setError(String(err))
    } finally {
      setGenerating(false)
    }
  }

  // Mistake frequency
  const mistakeCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const t of trades) {
      if (Array.isArray(t.mistakes)) {
        for (const m of t.mistakes) {
          map[m] = (map[m] ?? 0) + 1
        }
      }
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1])
  }, [trades])

  const maxMistakeCount = mistakeCounts[0]?.[1] ?? 1

  // Pattern tendency cards
  const patternTendencies = useMemo(() => {
    const map: Record<string, { count: number; wins: number; pnl: number }> = {}
    for (const t of trades) {
      if (!t.pattern) continue
      const key = t.pattern
      if (!map[key]) map[key] = { count: 0, wins: 0, pnl: 0 }
      map[key].count++
      if ((t.pnl ?? 0) > 0) map[key].wins++
      map[key].pnl += t.pnl ?? 0
    }
    return Object.entries(map).sort((a, b) => b[1].count - a[1].count)
  }, [trades])

  return (
    <div className="flex flex-col gap-6">
      {/* AI Coaching Note */}
      <div className="bg-white/2 border border-white/8 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#0ea5e9]" /> AI Performance Coach
          </h2>
          <button
            onClick={generate}
            disabled={generating || trades.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium bg-[#0ea5e9]/10 border border-[#0ea5e9]/20 text-[#0ea5e9] hover:bg-[#0ea5e9]/20 disabled:opacity-50"
            style={{ transition: 'background 0.15s' }}
          >
            {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
            {generating ? 'Analyzing…' : 'Generate New Analysis'}
          </button>
        </div>
        {error && <p className="text-xs text-[#ef4444] mb-3">{error}</p>}
        {localNote ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-slate-600">
              Generated {new Date(localNote.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · {localNote.period} · {localNote.win_rate != null ? `${localNote.win_rate}% WR` : ''}
            </p>
            <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{localNote.note}</p>
          </div>
        ) : (
          <div className="text-center py-8">
            <Brain className="w-8 h-8 text-slate-700 mx-auto mb-2" />
            <p className="text-sm text-slate-600">No analysis yet. Log some trades then generate your first coaching note.</p>
          </div>
        )}
      </div>

      {/* Mistake frequency */}
      {mistakeCounts.length > 0 && (
        <div className="bg-white/2 border border-white/8 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <AlertTriangle className="w-4 h-4 text-[#f59e0b]" /> Mistake Frequency
          </h2>
          <div className="flex flex-col gap-3">
            {mistakeCounts.map(([mistake, count]) => {
              const pct = (count / maxMistakeCount) * 100
              return (
                <div key={mistake} className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-40 truncate">{mistake}</span>
                  <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#f59e0b]/60 rounded-full"
                      style={{ width: `${pct}%`, transition: 'width 0.3s' }}
                    />
                  </div>
                  <span className="text-xs text-[#f59e0b] tabular-nums w-8 text-right">{count}×</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Pattern tendency cards */}
      {patternTendencies.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Pattern Tendencies</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {patternTendencies.map(([pattern, stats]) => {
              const wr = stats.count > 0 ? (stats.wins / stats.count) * 100 : 0
              return (
                <div key={pattern} className="bg-white/2 border border-white/8 rounded-2xl p-4 flex flex-col gap-2">
                  <p className="text-sm font-semibold text-white">{pattern}</p>
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-600">Occurrences</span>
                      <span className="text-lg font-bold text-white">{stats.count}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-600">Win Rate</span>
                      <span className={`text-lg font-bold ${wr >= 50 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{wr.toFixed(0)}%</span>
                    </div>
                    <div className="flex flex-col ml-auto">
                      <span className="text-xs text-slate-600">Total P&L</span>
                      <span className={`text-lg font-bold tabular-nums ${pnlColor(stats.pnl)}`}>{formatPnl(stats.pnl)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {trades.length === 0 && (
        <div className="text-center py-12 text-slate-600 text-sm">
          Log trades to see your tendencies.
        </div>
      )}
    </div>
  )
}

// ─── Tab 4: Calendar ─────────────────────────────────────────────────────────

function CalendarTab({ trades }: { trades: Trade[] }) {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // Build map: date string → { pnl: number, trades: Trade[] }
  const dayMap = useMemo(() => {
    const map: Record<string, { pnl: number; trades: Trade[] }> = {}
    for (const t of trades) {
      const key = t.date
      if (!map[key]) map[key] = { pnl: 0, trades: [] }
      map[key].trades.push(t)
      if (t.pnl != null) map[key].pnl += t.pnl
    }
    return map
  }, [trades])

  const firstDayOfMonth = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const startingDayOfWeek = firstDayOfMonth.getDay() // 0=Sun

  const prevMonth = useCallback(() => {
    setMonth((m) => { if (m === 0) { setYear((y) => y - 1); return 11 } return m - 1 })
    setSelectedDay(null)
  }, [])
  const nextMonth = useCallback(() => {
    setMonth((m) => { if (m === 11) { setYear((y) => y + 1); return 0 } return m + 1 })
    setSelectedDay(null)
  }, [])

  const monthName = new Date(year, month, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })

  const dayKeys = Array.from({ length: daysInMonth }, (_, i) => {
    const d = i + 1
    const mm = String(month + 1).padStart(2, '0')
    const dd = String(d).padStart(2, '0')
    return `${year}-${mm}-${dd}`
  })

  const selectedTrades = selectedDay ? (dayMap[selectedDay]?.trades ?? []) : []

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-white/2 border border-white/8 rounded-2xl p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <button onClick={prevMonth} className="p-1.5 rounded-xl hover:bg-white/8 text-slate-400 hover:text-white" style={{ transition: 'background 0.15s, color 0.15s' }}>
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h2 className="text-sm font-bold text-white">{monthName}</h2>
          <button onClick={nextMonth} className="p-1.5 rounded-xl hover:bg-white/8 text-slate-400 hover:text-white" style={{ transition: 'background 0.15s, color 0.15s' }}>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Day of week headers */}
        <div className="grid grid-cols-7 mb-1">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="text-center text-xs text-slate-600 py-1">{d}</div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {/* Empty cells for days before month starts */}
          {Array.from({ length: startingDayOfWeek }).map((_, i) => (
            <div key={`empty-${i}`} />
          ))}
          {dayKeys.map((key, i) => {
            const dayNum = i + 1
            const data = dayMap[key]
            const isToday = key === today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
            const isSelected = key === selectedDay
            let bgClass = 'bg-white/2 border-white/5'
            if (data) {
              bgClass = data.pnl > 0 ? 'bg-[#22c55e]/15 border-[#22c55e]/20' : data.pnl < 0 ? 'bg-[#ef4444]/15 border-[#ef4444]/20' : 'bg-slate-500/15 border-slate-500/20'
            }
            if (isSelected) bgClass = 'bg-[#0ea5e9]/20 border-[#0ea5e9]/40'
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedDay(key === selectedDay ? null : key)}
                className={`relative aspect-square flex flex-col items-center justify-center rounded-xl border text-xs font-medium ${bgClass} ${isToday ? 'ring-1 ring-[#0ea5e9]/40' : ''} ${data ? 'cursor-pointer hover:opacity-80' : 'cursor-default opacity-60'}`}
                style={{ transition: 'opacity 0.15s' }}
              >
                <span className={isToday ? 'text-[#0ea5e9]' : data ? 'text-white' : 'text-slate-600'}>{dayNum}</span>
                {data && (
                  <span className={`text-[9px] tabular-nums ${data.pnl > 0 ? 'text-[#22c55e]' : data.pnl < 0 ? 'text-[#ef4444]' : 'text-slate-400'}`}>
                    {data.pnl > 0 ? '+' : ''}{data.pnl.toFixed(0)}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-4 justify-center">
          <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-[#22c55e]/30 border border-[#22c55e]/30" /><span className="text-xs text-slate-500">Profitable</span></div>
          <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-[#ef4444]/30 border border-[#ef4444]/30" /><span className="text-xs text-slate-500">Loss</span></div>
          <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-white/5 border border-white/10" /><span className="text-xs text-slate-500">No trades</span></div>
        </div>
      </div>

      {/* Selected day panel */}
      {selectedDay && (
        <div className="bg-white/2 border border-white/8 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">
            {new Date(selectedDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </h3>
          {selectedTrades.length === 0 ? (
            <p className="text-sm text-slate-600">No trades on this day.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {selectedTrades.map((t) => <TradeRow key={t.id} trade={t} />)}
              <div className="mt-2 flex items-center justify-between pt-2 border-t border-white/5">
                <span className="text-xs text-slate-500">{selectedTrades.length} trade{selectedTrades.length !== 1 ? 's' : ''}</span>
                <span className={`text-sm font-bold tabular-nums ${pnlColor(dayMap[selectedDay]?.pnl ?? null)}`}>
                  {formatPnl(dayMap[selectedDay]?.pnl ?? null)} day P&L
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Morning Briefs ───────────────────────────────────────────────────────────

function MorningBriefs({ briefs }: { briefs: BriefSignal[] }) {
  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }) + ' ET'
    } catch { return iso }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#0ea5e9]" /> Reddit Intelligence Briefs
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Groq synthesis of Reddit sentiment — runs every 2 hours during market hours.
        </p>
      </div>

      {briefs.length === 0 ? (
        <div className="bg-white/2 border border-white/8 rounded-2xl p-8 text-center flex flex-col items-center gap-3">
          <Sparkles className="w-8 h-8 text-slate-700" />
          <div>
            <p className="text-sm text-slate-400 font-medium">No briefs yet today</p>
            <p className="text-xs text-slate-600 mt-1">Briefs run every 2 hours during market hours (6am–8pm ET).</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {briefs.map((b) => {
            const tickers = b.raw_data?.tickers ?? []
            const counts = b.raw_data?.mention_counts ?? {}
            return (
              <div key={b.id} className="bg-white/2 border border-white/8 rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-[#0ea5e9]" />
                    <span className="text-sm font-semibold text-white">{b.title}</span>
                  </div>
                  <span className="text-xs text-slate-500">{formatTime(b.created_at)}</span>
                </div>

                {tickers.length > 0 && (
                  <div className="px-4 py-2 flex flex-wrap gap-2 border-b border-white/5">
                    {tickers.slice(0, 10).map((t) => (
                      <span key={t} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-[#0ea5e9]/10 border border-[#0ea5e9]/20 text-[#0ea5e9]">
                        {t}
                        {counts[t] != null && (
                          <span className="text-slate-500 font-normal">{counts[t]}×</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                <div className="px-4 py-3">
                  <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{b.body}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Prediction Brief ─────────────────────────────────────────────────────────

function biasColor(bias: string) {
  if (bias === 'bullish') return 'text-[#22c55e]'
  if (bias === 'bearish') return 'text-[#ef4444]'
  return 'text-[#f59e0b]'
}

function biasBg(bias: string) {
  if (bias === 'bullish') return 'bg-[#22c55e]/10 border-[#22c55e]/20'
  if (bias === 'bearish') return 'bg-[#ef4444]/10 border-[#ef4444]/20'
  return 'bg-[#f59e0b]/10 border-[#f59e0b]/20'
}

function biasArrow(bias: string) {
  if (bias === 'bullish') return '▲'
  if (bias === 'bearish') return '▼'
  return '→'
}

function PredictionCard({ pred }: { pred: EodPrediction }) {
  const [expanded, setExpanded] = useState(false)
  const hit = pred.actual_close != null && pred.predicted_low != null && pred.predicted_high != null
    ? pred.actual_close >= pred.predicted_low && pred.actual_close <= pred.predicted_high
    : null

  return (
    <div className={`border rounded-2xl overflow-hidden ${biasBg(pred.bias)}`}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5"
        style={{ transition: 'background 0.15s' }}
      >
        <span className={`text-lg font-bold ${biasColor(pred.bias)}`}>{biasArrow(pred.bias)}</span>
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-white font-mono">{pred.ticker}</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${biasBg(pred.bias)} ${biasColor(pred.bias)}`}>
              {pred.bias} {pred.confidence_pct != null ? `${pred.confidence_pct}%` : ''}
            </span>
            {hit != null && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${hit ? 'bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20' : 'bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20'}`}>
                {hit ? '✓ In range' : '✗ Missed'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {pred.predicted_low != null && pred.predicted_high != null && (
              <span className="text-xs text-slate-400 tabular-nums">
                Range: ${pred.predicted_low.toFixed(2)}–${pred.predicted_high.toFixed(2)}
              </span>
            )}
            {pred.open_price != null && (
              <span className="text-xs text-slate-600 tabular-nums">open ${pred.open_price.toFixed(2)}</span>
            )}
            {pred.actual_close != null && (
              <span className={`text-xs font-semibold tabular-nums ml-auto ${hit ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                actual ${pred.actual_close.toFixed(2)}
              </span>
            )}
          </div>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-white/5">
          {pred.analysis && (
            <p className="text-sm text-slate-300 leading-relaxed pt-3">{pred.analysis}</p>
          )}
          {pred.key_factors && pred.key_factors.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-slate-600 uppercase tracking-wider font-medium">Key Factors</p>
              <ul className="flex flex-col gap-1">
                {pred.key_factors.map((f, i) => (
                  <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5">
                    <span className={`mt-0.5 ${biasColor(pred.bias)}`}>•</span>{f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pred.invalidation_level != null && (
            <p className="text-xs text-slate-500">
              <span className="text-slate-600">Invalidation:</span> ${pred.invalidation_level.toFixed(2)} — bias flips if price crosses this level
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function LessonCard({ lesson }: { lesson: PredictionLesson }) {
  const correct = lesson.in_range && lesson.bias === lesson.actual_bias
  const biasCorrect = lesson.bias === lesson.actual_bias
  return (
    <div className={`border rounded-2xl p-4 flex flex-col gap-2 ${correct ? 'border-[#22c55e]/20 bg-[#22c55e]/5' : 'border-[#ef4444]/20 bg-[#ef4444]/5'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-bold text-sm text-white font-mono">{lesson.ticker}</span>
        <span className="text-xs text-slate-500">{lesson.date}</span>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${correct ? 'bg-[#22c55e]/10 border-[#22c55e]/20 text-[#22c55e]' : 'bg-[#ef4444]/10 border-[#ef4444]/20 text-[#ef4444]'}`}>
          {correct ? '✓ Correct' : '✗ Wrong'}
        </span>
        <span className="text-xs text-slate-500 ml-auto">
          predicted <span className={biasCorrect ? 'text-[#22c55e]' : 'text-[#ef4444]'}>{lesson.bias}</span>
          {' → '}actual <span className="text-white">{lesson.actual_bias}</span>
        </span>
      </div>
      {lesson.predicted_low != null && lesson.actual_close != null && (
        <p className="text-xs text-slate-500 tabular-nums">
          Range ${lesson.predicted_low?.toFixed(2)}–${lesson.predicted_high?.toFixed(2)} · Actual ${lesson.actual_close.toFixed(2)}
          {lesson.in_range ? <span className="text-[#22c55e] ml-1">in range</span> : <span className="text-[#ef4444] ml-1">missed range</span>}
        </p>
      )}
      {lesson.lesson && lesson.lesson !== 'Correct prediction — bias and range both accurate.' && (
        <p className="text-xs text-slate-300 leading-relaxed border-t border-white/5 pt-2 mt-1">{lesson.lesson}</p>
      )}
    </div>
  )
}

function PredictionBrief({ predictions, lessons, today }: { predictions: EodPrediction[]; lessons: PredictionLesson[]; today: string }) {
  const todayPreds = predictions.filter(p => p.date === today)
  const pastPreds = predictions.filter(p => p.date !== today && p.actual_close != null)

  const accuracy = useMemo(() => {
    const hits = pastPreds.filter(p =>
      p.predicted_low != null && p.predicted_high != null && p.actual_close != null &&
      p.actual_close >= p.predicted_low && p.actual_close <= p.predicted_high
    )
    return pastPreds.length > 0 ? (hits.length / pastPreds.length) * 100 : null
  }, [pastPreds])

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Target className="w-4 h-4 text-[#0ea5e9]" /> EOD Price Predictions
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Groq synthesis of signals → directional bias + price range at open. Updated each market day.
          </p>
        </div>
        {accuracy != null && (
          <div className="text-right">
            <p className="text-xs text-slate-600">7-day accuracy</p>
            <p className={`text-lg font-bold tabular-nums ${accuracy >= 60 ? 'text-[#22c55e]' : accuracy >= 40 ? 'text-[#f59e0b]' : 'text-[#ef4444]'}`}>
              {accuracy.toFixed(0)}%
            </p>
          </div>
        )}
      </div>

      {/* Today's predictions */}
      {todayPreds.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
            <Zap className="w-3 h-3 text-[#0ea5e9]" /> Today&apos;s Calls
          </h3>
          {todayPreds.map(p => <PredictionCard key={p.id} pred={p} />)}
        </div>
      ) : (
        <div className="bg-white/2 border border-white/8 rounded-2xl p-8 text-center flex flex-col items-center gap-3">
          <Target className="w-8 h-8 text-slate-700" />
          <div>
            <p className="text-sm text-slate-400 font-medium">No predictions for today yet</p>
            <p className="text-xs text-slate-600 mt-1">
              The prediction worker runs at market open (9:15–10am ET) for your portfolio tickers.
              Make sure your tickers are in the portfolio page.
            </p>
          </div>
        </div>
      )}

      {/* Past predictions with actuals */}
      {pastPreds.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Recent Results</h3>
          {pastPreds.slice(0, 10).map(p => <PredictionCard key={p.id} pred={p} />)}
        </div>
      )}

      {/* Lessons — Groq's self-critiques */}
      {lessons.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <Brain className="w-3 h-3 text-purple-400" /> Groq Learning Log
            </h3>
            <span className="text-xs text-slate-600">
              {lessons.filter(l => l.in_range && l.bias === l.actual_bias).length}/{lessons.length} correct in last 7d
            </span>
          </div>
          <p className="text-xs text-slate-600">Groq reviews each prediction at market close and writes a self-critique when wrong. These lessons are automatically injected into tomorrow&apos;s predictions.</p>
          {lessons.slice(0, 15).map(l => <LessonCard key={l.id} lesson={l} />)}
        </div>
      )}

      <div className="bg-white/2 border border-white/8 rounded-2xl p-4 text-xs text-slate-500 leading-relaxed">
        <span className="text-slate-400 font-medium">Learning loop: </span>
        At market open, Groq predicts close price using signals + its own past mistakes for this ticker.
        After 4pm ET, actual prices fill in, Groq reviews what it got wrong, and writes a lesson.
        Each morning the new lessons feed back into the next prediction — improving over time.
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function JournalClient({
  initialTrades,
  latestCoachingNote,
  predictions,
  briefs,
  lessons,
  today,
}: {
  initialTrades: Trade[]
  latestCoachingNote: CoachingNote | null
  predictions: EodPrediction[]
  briefs: BriefSignal[]
  lessons: PredictionLesson[]
  today: string
}) {
  const [activeTab, setActiveTab] = useState<TabName>('Today\'s Entry')
  const [trades, setTrades] = useState<Trade[]>(initialTrades)
  const [coachNote, setCoachNote] = useState<CoachingNote | null>(latestCoachingNote)

  const handleTradeAdded = useCallback((t: Trade) => {
    setTrades((prev) => [t, ...prev])
  }, [])

  const handleNoteGenerated = useCallback((note: CoachingNote) => {
    setCoachNote(note)
  }, [])

  const TAB_ICONS: Record<TabName, React.ReactNode> = {
    'Today\'s Entry': <BookOpen className="w-4 h-4" />,
    'Performance': <BarChart2 className="w-4 h-4" />,
    'Tendencies': <Brain className="w-4 h-4" />,
    'Calendar': <Calendar className="w-4 h-4" />,
    'Predictions': <Target className="w-4 h-4" />,
    'Briefs': <Sparkles className="w-4 h-4" />,
  }

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 flex items-center justify-center shrink-0">
          <BookOpen className="w-4 h-4 text-[#0ea5e9]" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">Trade Journal</h1>
          <p className="text-xs text-slate-500">Log trades, track performance, get AI coaching</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/3 border border-white/8 rounded-2xl p-1">
        {TAB_NAMES.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-xs font-medium ${activeTab === tab
              ? 'bg-[#0ea5e9]/15 text-[#0ea5e9] border border-[#0ea5e9]/20'
              : 'text-slate-500 hover:text-white hover:bg-white/5'
              }`}
            style={{ transition: 'background 0.15s, color 0.15s' }}
          >
            <span className="hidden sm:flex">{TAB_ICONS[tab]}</span>
            <span className="hidden sm:inline">{tab}</span>
            <span className="sm:hidden">{TAB_ICONS[tab]}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'Today\'s Entry' && (
        <TodayEntry trades={trades} onTradeAdded={handleTradeAdded} />
      )}
      {activeTab === 'Performance' && (
        <Performance trades={trades} />
      )}
      {activeTab === 'Tendencies' && (
        <Tendencies trades={trades} latestNote={coachNote} onNoteGenerated={handleNoteGenerated} />
      )}
      {activeTab === 'Calendar' && (
        <CalendarTab trades={trades} />
      )}
      {activeTab === 'Predictions' && (
        <PredictionBrief predictions={predictions} lessons={lessons} today={today} />
      )}
      {activeTab === 'Briefs' && (
        <MorningBriefs briefs={briefs} />
      )}
    </div>
  )
}
