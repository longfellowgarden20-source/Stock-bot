import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import Link from 'next/link'
import { ArrowLeft, Zap } from 'lucide-react'

export const revalidate = 30

export default async function SignalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: signal } = await supabase.from('signals').select('*').eq('id', id).single()
  if (!signal) notFound()

  // Mark as read
  await supabase.from('signals').update({ read: true }).eq('id', id)

  // Get other recent signals for same ticker
  const { data: related } = await supabase
    .from('signals')
    .select('*')
    .eq('ticker', signal.ticker)
    .neq('id', id)
    .order('created_at', { ascending: false })
    .limit(5)

  const severityColor = signal.severity >= 9 ? 'text-red-400 bg-red-500/10 border-red-500/30' :
    signal.severity >= 7 ? 'text-orange-400 bg-orange-500/10 border-orange-500/30' :
    signal.severity >= 5 ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30' :
    'text-slate-400 bg-slate-500/10 border-slate-500/30'

  return (
    <AppShell>
      <div className="flex flex-col gap-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/8 border border-white/10" style={{ transition: 'background 0.15s' }}>
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-white font-mono">{signal.ticker}</h1>
            <p className="text-xs text-slate-500">{new Date(signal.created_at).toLocaleString()}</p>
          </div>
        </div>

        {/* Signal detail card */}
        <div className="bg-white/4 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`px-3 py-1 rounded-full text-xs font-bold border ${severityColor}`}>
              Severity {signal.severity}/10
            </span>
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-white/5 border border-white/10 text-slate-300">
              {signal.signal_type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}
            </span>
          </div>
          <h2 className="text-lg font-bold text-white leading-snug">{signal.title}</h2>
          <p className="text-sm text-slate-300 leading-relaxed">{signal.body}</p>

          {signal.raw_data && (
            <div className="mt-2">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Raw Data</p>
              <pre className="text-xs text-slate-400 bg-black/30 rounded-xl p-4 overflow-x-auto leading-relaxed">
                {JSON.stringify(signal.raw_data, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Related signals */}
        {related && related.length > 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-2">
              <Zap className="w-3.5 h-3.5" /> Other signals for {signal.ticker}
            </p>
            {related.map(s => (
              <Link key={s.id} href={`/signals/${s.id}`} className="flex items-start gap-3 px-4 py-3 bg-white/3 border border-white/8 rounded-xl hover:border-white/15" style={{ transition: 'border-color 0.15s' }}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">{s.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{s.signal_type.replace(/_/g, ' ')} · {new Date(s.created_at).toLocaleDateString()}</p>
                </div>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${s.severity >= 9 ? 'bg-red-500/20 text-red-400' : s.severity >= 7 ? 'bg-orange-500/20 text-orange-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                  {s.severity}/10
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}
