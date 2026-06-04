'use client'

import { useState } from 'react'
import { Plus, Trash2, Bell, Loader2, Upload, X, CheckCircle, AlertCircle } from 'lucide-react'

type WatchlistItem = {
  id: string
  ticker: string
  name: string | null
  sector: string | null
  notes: string | null
  alert_threshold_pct: number | null
  added_at: string
}

const input = 'px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/60'

type BulkResult = {
  added: string[]
  existed: string[]
  failed: string[]
}

export default function WatchlistClient({ watchlist: initial }: { watchlist: WatchlistItem[] }) {
  const [watchlist, setWatchlist] = useState(initial)
  const [ticker, setTicker] = useState('')
  const [notes, setNotes] = useState('')
  const [threshold, setThreshold] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Bulk add state
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)

  const add = async () => {
    if (!ticker.trim()) return
    setAdding(true)
    setError(null)
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: ticker.toUpperCase().trim(), notes, alert_threshold_pct: threshold ? parseFloat(threshold) : null }),
    })
    const data = await res.json()
    if (res.ok) {
      setWatchlist(w => [data, ...w])
      setTicker(''); setNotes(''); setThreshold('')
    } else {
      setError(data.error ?? 'Failed to add')
    }
    setAdding(false)
  }

  const remove = async (id: string) => {
    await fetch(`/api/watchlist?id=${id}`, { method: 'DELETE' })
    setWatchlist(w => w.filter(x => x.id !== id))
  }

  const runBulkAdd = async () => {
    const raw = bulkText.trim()
    if (!raw) return
    const tickers = raw
      .split(/[\s,]+/)
      .map(t => t.toUpperCase().trim())
      .filter(t => /^[A-Z]{1,5}$/.test(t))
    if (!tickers.length) return

    setBulkRunning(true)
    setBulkResult(null)
    setBulkProgress({ current: 0, total: tickers.length })

    const result: BulkResult = { added: [], existed: [], failed: [] }
    for (let i = 0; i < tickers.length; i++) {
      const t = tickers[i]
      setBulkProgress({ current: i + 1, total: tickers.length })
      try {
        const res = await fetch('/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: t }),
        })
        const data = await res.json()
        if (res.status === 409 || data?.error?.toLowerCase().includes('already')) {
          result.existed.push(t)
        } else if (res.ok) {
          result.added.push(t)
          setWatchlist(w => [data, ...w])
        } else {
          result.failed.push(t)
        }
      } catch {
        result.failed.push(t)
      }
    }

    setBulkResult(result)
    setBulkProgress(null)
    setBulkRunning(false)
    setBulkText('')
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Bulk Add Modal */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) { setBulkOpen(false); setBulkResult(null) } }}>
          <div className="bg-[#0d1520] border border-white/15 rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 w-full sm:max-w-md flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-white">Bulk Add Tickers</h2>
              <button onClick={() => { setBulkOpen(false); setBulkResult(null) }} className="text-slate-500 hover:text-white" style={{ transition: 'color 0.15s' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500">Paste comma or space-separated tickers. e.g. AAPL, NVDA, TSLA, AMD</p>
            <textarea
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
              placeholder="AAPL, NVDA, TSLA, AMD, MSFT"
              rows={4}
              disabled={bulkRunning}
              className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/60 resize-none font-mono uppercase disabled:opacity-50"
              style={{ fontSize: 16 }}
            />
            {bulkProgress && (
              <div className="flex items-center gap-3">
                <div className="flex-1 bg-white/5 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="h-full bg-[#0ea5e9] rounded-full"
                    style={{ width: `${(bulkProgress.current / bulkProgress.total) * 100}%`, transition: 'width 0.2s' }}
                  />
                </div>
                <span className="text-xs text-slate-400 shrink-0">{bulkProgress.current}/{bulkProgress.total}</span>
              </div>
            )}
            {bulkResult && (
              <div className="flex flex-col gap-1.5 text-xs">
                {bulkResult.added.length > 0 && (
                  <div className="flex items-start gap-2 text-green-400">
                    <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span><span className="font-bold">{bulkResult.added.length} added:</span> {bulkResult.added.join(', ')}</span>
                  </div>
                )}
                {bulkResult.existed.length > 0 && (
                  <div className="flex items-start gap-2 text-yellow-400">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span><span className="font-bold">{bulkResult.existed.length} already on watchlist:</span> {bulkResult.existed.join(', ')}</span>
                  </div>
                )}
                {bulkResult.failed.length > 0 && (
                  <div className="flex items-start gap-2 text-red-400">
                    <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span><span className="font-bold">{bulkResult.failed.length} failed:</span> {bulkResult.failed.join(', ')}</span>
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => { setBulkOpen(false); setBulkResult(null) }}
                className="px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white border border-white/10 rounded-xl hover:bg-white/5"
                style={{ transition: 'color 0.15s, background 0.15s' }}
              >
                {bulkResult ? 'Done' : 'Cancel'}
              </button>
              {!bulkResult && (
                <button
                  onClick={runBulkAdd}
                  disabled={bulkRunning || !bulkText.trim()}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-black bg-[#0ea5e9] rounded-xl disabled:opacity-40 hover:bg-[#38bdf8] active:scale-[0.98]"
                  style={{ transition: 'background 0.15s, transform 0.1s' }}
                >
                  {bulkRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  {bulkRunning ? 'Adding...' : 'Import'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Watchlist</h1>
          <p className="text-sm text-slate-500 mt-0.5">{watchlist.length} ticker{watchlist.length !== 1 ? 's' : ''} tracked</p>
        </div>
        <button
          onClick={() => setBulkOpen(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-300 border border-white/10 rounded-xl hover:bg-white/5 hover:text-white"
          style={{ transition: 'color 0.15s, background 0.15s' }}
        >
          <Upload className="w-4 h-4" />
          Bulk Add
        </button>
      </div>

      {/* Add ticker */}
      <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
        <p className="text-sm font-semibold text-white">Add Ticker</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && add()}
            placeholder="AAPL"
            className={`${input} font-mono font-bold uppercase`}
            style={{ fontSize: 16 }}
          />
          <input
            value={threshold}
            onChange={e => setThreshold(e.target.value)}
            placeholder="Alert threshold % (e.g. 5)"
            className={input}
            type="number"
            style={{ fontSize: 16 }}
          />
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            className={input}
            style={{ fontSize: 16 }}
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          onClick={add}
          disabled={adding || !ticker.trim()}
          className="self-start flex items-center gap-2 px-4 py-2 text-sm font-bold text-black bg-[#0ea5e9] rounded-xl disabled:opacity-40 hover:bg-[#38bdf8] active:scale-[0.98]"
          style={{ transition: 'background 0.15s, transform 0.1s' }}
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {adding ? 'Adding...' : 'Add to Watchlist'}
        </button>
      </div>

      {/* Watchlist */}
      <div className="flex flex-col gap-2">
        {watchlist.length === 0 && (
          <div className="text-center py-16 text-slate-500 text-sm">No tickers yet — add one above to start tracking signals</div>
        )}
        {watchlist.map(item => (
          <div key={item.id} className="flex items-center gap-3 sm:gap-4 px-3 sm:px-5 py-4 bg-white/4 border border-white/10 rounded-2xl hover:border-white/20" style={{ transition: 'border-color 0.15s' }}>
            <div className="w-10 h-10 rounded-xl bg-[#0ea5e9]/10 border border-[#0ea5e9]/20 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-[#0ea5e9] font-mono">{item.ticker.slice(0, 4)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white font-mono">{item.ticker}</p>
              <div className="flex items-center gap-3 mt-0.5">
                {item.sector && <span className="text-xs text-slate-500">{item.sector}</span>}
                {item.alert_threshold_pct && (
                  <span className="flex items-center gap-1 text-xs text-yellow-400">
                    <Bell className="w-3 h-3" /> Alert at {item.alert_threshold_pct}%
                  </span>
                )}
                {item.notes && <span className="text-xs text-slate-500 truncate">{item.notes}</span>}
              </div>
            </div>
            <span className="text-xs text-slate-600 shrink-0">{new Date(item.added_at).toLocaleDateString()}</span>
            <button onClick={() => remove(item.id)} className="p-2 text-slate-600 hover:text-red-400 shrink-0" style={{ transition: 'color 0.15s' }}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
