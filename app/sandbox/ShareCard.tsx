'use client'

import { useRef, useState, forwardRef } from 'react'
import { toPng } from 'html-to-image'
import { Download, Copy, Check, X } from 'lucide-react'
import Mascot from '../components/Mascot'

type ShareStats = {
  balance: number
  starting: number
  totalPnl: number
  totalPnlPct: number
  peak: number
  winRate: number
  totalTrades: number
  winningTrades: number
  days?: number | null
}

function fmtMoney(n: number, withSign = false): string {
  const sign = withSign && n > 0 ? '+' : n < 0 ? '-' : ''
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`
}

/**
 * Branded, Canva-style performance summary card rendered from real sandbox
 * data. The hidden 1080×1350 node is what gets snapshotted to PNG so the
 * export is always crisp and consistent regardless of screen size.
 */
export default function ShareCard({ stats, onClose }: { stats: ShareStats; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<'download' | 'copy' | null>(null)
  const [copied, setCopied] = useState(false)

  const positive = stats.totalPnl >= 0
  const accent = positive ? '#2dd4bf' : '#f87171'
  const accentGlow = positive ? 'rgba(45,212,191,0.4)' : 'rgba(248,113,113,0.4)'

  async function render(): Promise<string | null> {
    if (!cardRef.current) return null
    // pixelRatio 2 → 2160×2700 output, plenty sharp for any platform
    return toPng(cardRef.current, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: '#080c0b',
    })
  }

  async function handleDownload() {
    setBusy('download')
    try {
      const url = await render()
      if (!url) return
      const a = document.createElement('a')
      a.href = url
      a.download = `stockbot-sandbox-${new Date().toISOString().slice(0, 10)}.png`
      a.click()
    } catch (e) {
      console.error('Share download failed', e)
      alert('Could not generate image — try again.')
    } finally {
      setBusy(null)
    }
  }

  async function handleCopy() {
    setBusy('copy')
    try {
      const url = await render()
      if (!url) return
      const blob = await (await fetch(url)).blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      console.error('Share copy failed', e)
      alert('Clipboard image copy not supported in this browser — use Download instead.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col items-center gap-4 max-h-[92vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-2 w-full">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mr-auto">Share card</p>
          <button
            onClick={handleDownload}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-teal-500/15 border border-teal-500/30 text-teal-300 hover:bg-teal-500/25 disabled:opacity-50 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            {busy === 'download' ? 'Rendering…' : 'Download PNG'}
          </button>
          <button
            onClick={handleCopy}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 border border-white/15 text-slate-200 hover:bg-white/10 disabled:opacity-50 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-teal-400" /> : <Copy className="w-3.5 h-3.5" />}
            {busy === 'copy' ? 'Copying…' : copied ? 'Copied!' : 'Copy image'}
          </button>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Preview — scaled down; the real export node is full-size below */}
        <div className="origin-top" style={{ transform: 'scale(0.34)', width: 1080, height: 1350, marginBottom: -1350 * 0.66 }}>
          <CardArt ref={cardRef} stats={stats} accent={accent} accentGlow={accentGlow} positive={positive} />
        </div>
      </div>
    </div>
  )
}

// ─── The actual graphic (1080×1350 — Instagram portrait, prints crisp) ───────
const CardArt = forwardRef<HTMLDivElement, {
  stats: ShareStats
  accent: string
  accentGlow: string
  positive: boolean
}>(function CardArt({ stats, accent, accentGlow, positive }, ref) {
  return (
    <div
      ref={ref}
      style={{
        width: 1080,
        height: 1350,
        position: 'relative',
        background: '#080c0b',
        backgroundImage:
          'radial-gradient(900px 520px at 12% -6%, rgba(45,212,191,0.10), transparent 60%),' +
          'radial-gradient(820px 480px at 104% 0%, rgba(16,185,129,0.08), transparent 56%),' +
          'radial-gradient(900px 900px at 50% 118%, rgba(20,184,166,0.05), transparent 60%)',
        fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
        color: '#e6f0ec',
        overflow: 'hidden',
        padding: 72,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top hairline sheen */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, rgba(94,234,212,0.5), transparent)' }} />

      {/* Brand row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <div style={{
          width: 76, height: 76,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          filter: `drop-shadow(0 0 22px ${accentGlow})`,
        }}>
          <Mascot size={76} expression={positive ? 'excited' : 'neutral'} float={false} staticRender />
        </div>
        <div>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#fff' }}>StockBot</div>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#5b7269' }}>Sandbox · AI Paper Trader</div>
        </div>
      </div>

      {/* Hero P&L */}
      <div style={{ marginTop: 96 }}>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#5b7269', marginBottom: 14 }}>
          Total Return
        </div>
        <div style={{
          fontSize: 168, lineHeight: 0.92, fontWeight: 800, letterSpacing: '-0.03em',
          color: accent, fontVariantNumeric: 'tabular-nums',
          textShadow: `0 0 60px ${accentGlow}`,
        }}>
          {stats.totalPnl >= 0 ? '+' : '−'}${Math.abs(Math.round(stats.totalPnl)).toLocaleString('en-US')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 22 }}>
          <span style={{
            fontSize: 46, fontWeight: 800, color: accent, fontVariantNumeric: 'tabular-nums',
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            {positive ? '▲' : '▼'} {stats.totalPnlPct >= 0 ? '+' : ''}{stats.totalPnlPct.toFixed(2)}%
          </span>
          {stats.days ? (
            <span style={{ fontSize: 28, fontWeight: 600, color: '#5b7269' }}>over {stats.days} days</span>
          ) : null}
        </div>
      </div>

      {/* Stat grid */}
      <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        <Stat label="Win Rate" value={`${stats.winRate.toFixed(0)}%`} sub={`${stats.winningTrades}/${stats.totalTrades} trades`} accent={accent} />
        <Stat label="Trades" value={stats.totalTrades.toLocaleString('en-US')} sub="executed" />
        <Stat label="Balance" value={fmtMoney(stats.balance)} sub={`from ${fmtMoney(stats.starting)}`} />
        <Stat label="Peak" value={fmtMoney(stats.peak)} sub="all-time high" />
      </div>

      {/* Footer */}
      <div style={{ marginTop: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: '#3f524c' }}>
          Autonomous · multi-signal convergence engine
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#5b7269', fontVariantNumeric: 'tabular-nums' }}>
          {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>
      </div>
    </div>
  )
})

function Stat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div style={{
      background: 'linear-gradient(180deg, rgba(94,234,212,0.04), rgba(255,255,255,0) 50%), rgba(12,18,17,0.85)',
      border: '1.5px solid rgba(180,230,215,0.10)',
      borderRadius: 22,
      padding: '28px 32px',
      boxShadow: '0 1px 0 0 rgba(180,230,215,0.05) inset',
    }}>
      <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#5b7269' }}>{label}</div>
      <div style={{ fontSize: 62, fontWeight: 800, letterSpacing: '-0.02em', color: accent ?? '#f0fdfa', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 22, fontWeight: 500, color: '#4a5a55', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{sub}</div>
    </div>
  )
}
