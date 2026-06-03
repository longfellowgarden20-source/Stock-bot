'use client'

import { useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import { TrendingUp, BarChart2, Zap, Shield } from 'lucide-react'

export default function SignInPage() {
  const [loading, setLoading] = useState(false)

  const signIn = async () => {
    setLoading(true)
    const supabase = getSupabaseBrowser()
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/api/auth` },
    })
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center px-4">
      {/* Background grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(14,165,233,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(14,165,233,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-12">
          <div className="w-10 h-10 rounded-xl bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-[#0ea5e9]" />
          </div>
          <div>
            <p className="text-lg font-bold text-white tracking-tight">StockBot</p>
            <p className="text-xs text-slate-500">Intelligence Platform</p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white/4 border border-white/10 rounded-2xl p-8 flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold text-white">Good morning.</h1>
            <p className="text-sm text-slate-400">Your market intelligence is ready.</p>
          </div>

          {/* Features */}
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

          <button
            onClick={signIn}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl font-semibold text-sm text-white bg-[#0ea5e9] hover:bg-[#38bdf8] disabled:opacity-50 active:scale-[0.98]"
            style={{ transition: 'background 0.15s, transform 0.1s' }}
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            )}
            {loading ? 'Signing in...' : 'Continue with Google'}
          </button>
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">Private access only</p>
      </div>
    </div>
  )
}
