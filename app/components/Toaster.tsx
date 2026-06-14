'use client'

import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
type Toast = { id: number; kind: ToastKind; message: string }

type Ctx = { toast: (message: string, kind?: ToastKind) => void }

const ToastCtx = createContext<Ctx>({ toast: () => {} })

export function useToast() {
  return useContext(ToastCtx)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const toast = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { id, kind, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3500)
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? AlertTriangle : Info
  const color = toast.kind === 'success' ? 'text-green-400 border-green-500/30 bg-green-500/10' :
                toast.kind === 'error' ? 'text-red-400 border-red-500/30 bg-red-500/10' :
                'text-[#14b8a6] border-[#14b8a6]/30 bg-[#14b8a6]/10'

  return (
    <div className={`flex items-start gap-2.5 px-3.5 py-3 rounded-xl border backdrop-blur-md ${color} pointer-events-auto shadow-lg`} role="status">
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <p className="text-sm font-medium text-slate-100 flex-1 leading-snug">{toast.message}</p>
      <button onClick={onDismiss} className="text-slate-400 hover:text-white shrink-0" aria-label="Dismiss" style={{ transition: 'color 0.15s' }}>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
