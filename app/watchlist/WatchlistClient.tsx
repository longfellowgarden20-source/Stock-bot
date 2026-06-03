'use client'

import { useState } from 'react'
import { Plus, Trash2, Bell, Loader2 } from 'lucide-react'

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

export default function WatchlistClient({ watchlist: initial }: { watchlist: WatchlistItem[] }) {
  const [watchlist, setWatchlist] = useState(initial)
  const [ticker, setTicker] = useState('')
  const [notes, setNotes] = useState('')
  const [threshold, setThreshold] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Watchlist</h1>
        <p className="text-sm text-slate-500 mt-0.5">{watchlist.length} ticker{watchlist.length !== 1 ? 's' : ''} tracked</p>
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
          <div key={item.id} className="flex items-center gap-4 px-5 py-4 bg-white/4 border border-white/10 rounded-2xl hover:border-white/20" style={{ transition: 'border-color 0.15s' }}>
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
            <button onClick={() => remove(item.id)} className="text-slate-600 hover:text-red-400 shrink-0" style={{ transition: 'color 0.15s' }}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
