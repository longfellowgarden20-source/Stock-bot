'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Plus, Bookmark, Loader2 } from 'lucide-react'
import { useToast } from './Toaster'

export default function QuickAddTicker({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded?: () => void }) {
  const [ticker, setTicker] = useState('')
  const [threshold, setThreshold] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()

  useEffect(() => {
    if (open) {
      setTicker('')
      setThreshold('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = ticker.trim().toUpperCase()
    if (!t || !/^[A-Z]{1,6}$/.test(t)) {
      toast('Invalid ticker — letters only, up to 6 chars', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: t,
          alert_threshold_pct: threshold ? parseFloat(threshold) : null,
        }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        toast(err.error || `Failed to add ${t}`, 'error')
        setBusy(false)
        return
      }
      toast(`Added ${t} to watchlist`, 'success')
      onAdded?.()
      onClose()
    } catch {
      toast('Network error', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4 pt-20 sm:pt-4" onClick={onClose} role="dialog" aria-modal="true">
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="bg-[#0c1211] border border-white/10 rounded-2xl p-5 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Bookmark className="w-4 h-4 text-[#14b8a6]" />
            <h2 className="text-base font-bold text-white">Add ticker</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close" style={{ transition: 'color 0.15s, background 0.15s' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide" htmlFor="qa-ticker">Ticker</label>
            <input
              id="qa-ticker"
              ref={inputRef}
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="AAPL"
              maxLength={6}
              className="mt-1 w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white font-mono font-bold tracking-wider placeholder:text-slate-600 placeholder:font-normal focus:outline-none focus:border-[#14b8a6]/60"
              style={{ transition: 'border-color 0.15s', fontSize: '16px' }}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide" htmlFor="qa-threshold">
              Alert threshold % <span className="text-slate-600 normal-case font-normal">(optional)</span>
            </label>
            <input
              id="qa-threshold"
              type="number"
              step="0.1"
              min="0"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder="5.0"
              className="mt-1 w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:border-[#14b8a6]/60"
              style={{ transition: 'border-color 0.15s', fontSize: '16px' }}
            />
            <p className="text-xs text-slate-600 mt-1">Fire a signal when price moves more than this % from open</p>
          </div>

          <button
            type="submit"
            disabled={busy || !ticker}
            className="mt-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#14b8a6] hover:bg-[#0d9488] text-white text-sm font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ transition: 'background 0.15s' }}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {busy ? 'Adding…' : 'Add to watchlist'}
          </button>
        </div>
      </form>
    </div>
  )
}
