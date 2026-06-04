'use client'

import { useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import { TrendingUp, BarChart2, Zap, Shield } from 'lucide-react'

export default function SignInPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = getSupabaseBrowser()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      window.location.href = '/dashboard'
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(14,165,233,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(14,165,233,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <div className="relative w-full max-w-md">
        <div className="flex items-center justify-center gap-3 mb-12">
          <div className="w-10 h-10 rounded-xl bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-[#0ea5e9]" />
          </div>
          <div>
            <p className="text-lg font-bold text-white tracking-tight">StockBot</p>
            <p className="text-xs text-slate-500">Intelligence Platform</p>
          </div>
        </div>

        <div className="bg-white/4 border border-white/10 rounded-2xl p-8 flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold text-white">Good morning.</h1>
            <p className="text-sm text-slate-400">Your market intelligence is ready.</p>
          </div>

          <div className="flex flex-col gap-3">
            {[
              { icon: Zap, label: 'Real-time signal detection', color: 'text-yellow-400' },
              { icon: BarChart2, label: 'Multi-source convergence alerts', color: 'text-[#0ea5e9]' },
              { icon: Shield, label: 'Portfolio watchdog 24/7', color: 'text-green-400' },
            ].map(({ icon: Icon, label, color }) => (
              <div key={label} className="flex items-center gap-3 text-sm text-slate-400">
                <Icon className={`w-4 h-4 ${color} shrink-0`} />
                {label}
              </div>
            ))}
          </div>

          <form onSubmit={signIn} className="flex flex-col gap-3">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-slate-500 focus:outline-none focus:border-[#0ea5e9]/60 text-sm"
              style={{ transition: 'border-color 0.15s' }}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-slate-500 focus:outline-none focus:border-[#0ea5e9]/60 text-sm"
              style={{ transition: 'border-color 0.15s' }}
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center py-3.5 rounded-xl font-semibold text-sm text-white bg-[#0ea5e9] hover:bg-[#38bdf8] disabled:opacity-50 active:scale-[0.98]"
              style={{ transition: 'background 0.15s, transform 0.1s' }}
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : 'Sign In'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">Private access only</p>
      </div>
    </div>
  )
}
