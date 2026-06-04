'use client'
import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'

const HEIGHTS = [400, 600, 900]

export default function TradingViewChart({ ticker }: { ticker: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [heightIdx, setHeightIdx] = useState(0)
  const height = HEIGHTS[heightIdx]

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    container.innerHTML = ''
    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.async = true
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: ticker,
      interval: 'D',
      timezone: 'America/New_York',
      theme: 'dark',
      style: '1',
      locale: 'en',
      backgroundColor: '#0a0f1a',
      gridColor: 'rgba(255,255,255,0.04)',
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      hide_volume: false,
    })
    if (active) container.appendChild(script)
    return () => {
      active = false
      container.innerHTML = ''
    }
  }, [ticker, height])

  const expanded = heightIdx > 0

  return (
    <div className="relative rounded-2xl overflow-hidden border border-white/10">
      <div
        className="tradingview-widget-container"
        ref={containerRef}
        style={{ height: `${height}px`, width: '100%' }}
      >
        <div className="tradingview-widget-container__widget" style={{ height: '100%', width: '100%' }} />
      </div>
      <button
        onClick={() => setHeightIdx((i) => (i + 1) % HEIGHTS.length)}
        className="absolute bottom-3 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-300 bg-[#0a0f1a]/80 border border-white/10 hover:border-white/25 hover:text-white backdrop-blur-sm"
        style={{ transition: 'border-color 0.15s, color 0.15s' }}
        title={expanded ? 'Shrink chart' : 'Expand chart'}
      >
        {heightIdx === HEIGHTS.length - 1
          ? <><Minimize2 className="w-3 h-3" /> Collapse</>
          : <><Maximize2 className="w-3 h-3" /> Expand</>
        }
      </button>
    </div>
  )
}
