import AppShell from '@/app/components/AppShell'
import AdminClient from './AdminClient'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const WORKERS = [
  'price', 'news', 'sec', 'reddit', 'engine',
  'options', 'congress', 'squeeze',
  'technical', 'earnings', 'analyst', 'macro', 'darkpool', 'sector',
  'intelligence', 'prediction', 'sandbox', 'morning_outlook',
] as const

type WorkerName = typeof WORKERS[number]

async function getWorkerHealth(): Promise<{ health: Record<string, unknown>; configured: boolean }> {
  const workerUrl = process.env.WORKER_SERVICE_URL
  if (!workerUrl) return { health: {}, configured: false }

  try {
    const r = await fetch(`${workerUrl}/health`, { cache: 'no-store' })
    if (r.ok) return { health: await r.json(), configured: true }
    return { health: {}, configured: true }
  } catch {
    return { health: {}, configured: true }
  }
}

export type WorkerStats = {
  signalsByType: Record<string, number>      // signal_type -> count (24h)
  totalSignals24h: number
  failures: Array<{
    ticker: string
    signal_type: string
    error_message: string
    retry_count: number
    resolved: boolean
    created_at: string
  }>
  failuresUnresolved: number
}

async function getWorkerStats(): Promise<WorkerStats> {
  const empty: WorkerStats = { signalsByType: {}, totalSignals24h: 0, failures: [], failuresUnresolved: 0 }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return empty
  try {
    const supabase = createClient(url, key)
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

    const [{ data: sigs }, { data: fails }] = await Promise.all([
      supabase.from('signals').select('signal_type').gte('created_at', since).limit(5000),
      supabase
        .from('failed_signals')
        .select('ticker,signal_type,error_message,retry_count,resolved,created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(40),
    ])

    const signalsByType: Record<string, number> = {}
    for (const s of sigs ?? []) {
      const t = (s as { signal_type: string }).signal_type
      signalsByType[t] = (signalsByType[t] ?? 0) + 1
    }
    const failures = (fails ?? []) as WorkerStats['failures']
    return {
      signalsByType,
      totalSignals24h: (sigs ?? []).length,
      failures,
      failuresUnresolved: failures.filter(f => !f.resolved).length,
    }
  } catch {
    return empty
  }
}

export default async function AdminPage() {
  const [{ health, configured }, stats] = await Promise.all([getWorkerHealth(), getWorkerStats()])
  const workers: WorkerName[] = [...WORKERS]

  return (
    <AppShell>
      <AdminClient workers={workers} initialHealth={health} configured={configured} stats={stats} />
    </AppShell>
  )
}
