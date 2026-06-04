import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const WORKERS = [
  'price', 'news', 'sec', 'reddit', 'engine',
  'options', 'congress', 'squeeze',
  'technical', 'earnings', 'analyst', 'macro', 'darkpool', 'sector',
] as const

type Worker = typeof WORKERS[number]

export async function GET() {
  const workerUrl = process.env.WORKER_SERVICE_URL
  if (!workerUrl) return NextResponse.json({ error: 'Worker service not configured', workers: [] })

  let health: Record<string, unknown> = {}
  try {
    const r = await fetch(`${workerUrl}/health`, { next: { revalidate: 0 } })
    if (r.ok) health = await r.json()
  } catch {
    // worker service unreachable
  }

  return NextResponse.json({ workers: WORKERS, health, workerUrl: workerUrl ? 'configured' : 'missing' })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const worker: string | undefined = body?.worker
  const workerUrl = process.env.WORKER_SERVICE_URL
  if (!workerUrl) return NextResponse.json({ error: 'Worker service not configured' }, { status: 500 })

  const targets: readonly Worker[] = worker && (WORKERS as readonly string[]).includes(worker)
    ? [worker as Worker]
    : WORKERS

  const results: Record<string, unknown> = {}
  await Promise.all(targets.map(async (w) => {
    try {
      const r = await fetch(`${workerUrl}/trigger/${w}`, { method: 'POST' })
      results[w] = r.ok ? await r.json() : { error: `status ${r.status}` }
    } catch (e) {
      results[w] = { error: e instanceof Error ? e.message : 'fetch failed' }
    }
  }))
  return NextResponse.json(results)
}
