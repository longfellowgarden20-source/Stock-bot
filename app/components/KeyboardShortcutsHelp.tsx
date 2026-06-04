'use client'

import { X } from 'lucide-react'

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: '/', description: 'Focus search' },
  { keys: 'j / k', description: 'Next / previous signal' },
  { keys: 'o', description: 'Open focused signal' },
  { keys: 'r', description: 'Mark focused signal as read' },
  { keys: 'p', description: 'Pin/unpin focused ticker' },
  { keys: 'm', description: 'Mute focused ticker' },
  { keys: 'x', description: 'Select focused signal' },
  { keys: 'a', description: 'Mark all read' },
  { keys: 'f', description: 'Force scan' },
  { keys: '+', description: 'Quick add ticker' },
  { keys: 'g d', description: 'Go to Signals' },
  { keys: 'g s', description: 'Go to Scanner' },
  { keys: 'g p', description: 'Go to Portfolio' },
  { keys: 'g w', description: 'Go to Watchlist' },
  { keys: '?', description: 'Show this help' },
  { keys: 'Esc', description: 'Close / clear search' },
]

export default function KeyboardShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-[#0a0f1a] border border-white/10 rounded-2xl p-5 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-white">Keyboard shortcuts</h2>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close" style={{ transition: 'color 0.15s, background 0.15s' }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
              <span className="text-xs text-slate-400">{s.description}</span>
              <kbd className="px-2 py-1 rounded-md text-xs font-mono font-semibold bg-white/5 border border-white/10 text-slate-200">{s.keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
