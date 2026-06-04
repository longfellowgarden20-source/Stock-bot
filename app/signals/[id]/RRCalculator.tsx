'use client'

import { useState, useMemo } from 'react'
import { Target } from 'lucide-react'

const input = 'px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-600 focus:outline-none focus:border-[#0ea5e9]/60'

export default function RRCalculator() {
  const [entry, setEntry] = useState('')
  const [target, setTarget] = useState('')
  const [stop, setStop] = useState('')

  const result = useMemo(() => {
    const e = parseFloat(entry)
    const t = parseFloat(target)
    const s = parseFloat(stop)
    if (!e || !t || !s || e <= 0 || t <= 0 || s <= 0) return null
    if (e === s) return null
    const isLong = t > e
    const isShort = t < e
    // Detect invalid setup: stop on wrong side of entry
    const invalidSetup = (isLong && s >= e) || (isShort && s <= e)
    if (invalidSetup) return { invalid: true, ratio: 0, reward: 0, risk: 0 }
    const reward = Math.abs(t - e)
    const risk = Math.abs(e - s)
    if (risk === 0) return null
    const ratio = reward / risk
    return { ratio, reward, risk, invalid: false }
  }, [entry, target, stop])

  const badge = result && !result.invalid
    ? result.ratio >= 2
      ? { label: `${result.ratio.toFixed(2)}:1`, cls: 'bg-green-500/20 text-green-400 border-green-500/30' }
      : result.ratio >= 1
      ? { label: `${result.ratio.toFixed(2)}:1`, cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' }
      : { label: `${result.ratio.toFixed(2)}:1`, cls: 'bg-red-500/20 text-red-400 border-red-500/30' }
    : null

  return (
    <div className="bg-white/4 border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 text-slate-400" />
        <p className="text-sm font-bold text-white">Risk / Reward Calculator</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Entry ($)</label>
          <input
            value={entry}
            onChange={e => setEntry(e.target.value)}
            placeholder="150.00"
            type="number"
            step="0.01"
            className={input}
            style={{ fontSize: 16 }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Target ($)</label>
          <input
            value={target}
            onChange={e => setTarget(e.target.value)}
            placeholder="165.00"
            type="number"
            step="0.01"
            className={input}
            style={{ fontSize: 16 }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Stop ($)</label>
          <input
            value={stop}
            onChange={e => setStop(e.target.value)}
            placeholder="145.00"
            type="number"
            step="0.01"
            className={input}
            style={{ fontSize: 16 }}
          />
        </div>
      </div>
      {result?.invalid ? (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl">
          <span className="text-xs text-red-400 font-semibold">Invalid setup — stop loss is on the wrong side of entry</span>
        </div>
      ) : badge ? (
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`px-4 py-1.5 rounded-full text-sm font-bold border ${badge.cls}`}>
            R:R {badge.label}
          </span>
          <span className="text-xs text-slate-500">
            Reward ${result!.reward.toFixed(2)} · Risk ${result!.risk.toFixed(2)}
          </span>
          {result!.ratio >= 2 && <span className="text-xs text-green-400 font-semibold">Good setup</span>}
          {result!.ratio >= 1 && result!.ratio < 2 && <span className="text-xs text-yellow-400 font-semibold">Marginal</span>}
          {result!.ratio < 1 && <span className="text-xs text-red-400 font-semibold">Poor risk/reward — skip or resize</span>}
        </div>
      ) : (
        <p className="text-xs text-slate-600">Enter entry, target, and stop prices to calculate R:R ratio</p>
      )}
    </div>
  )
}
