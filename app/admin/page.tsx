import AppShell from '@/app/components/AppShell'
import AdminClient from './AdminClient'

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

export default async function AdminPage() {
  const { health, configured } = await getWorkerHealth()

  const workers: WorkerName[] = [...WORKERS]

  return (
    <AppShell>
      <AdminClient workers={workers} initialHealth={health} configured={configured} />
    </AppShell>
  )
}
