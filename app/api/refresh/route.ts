import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const WORKERS = ['price', 'news', 'sec', 'reddit', 'engine'] as const

export async function POST(req: NextRequest) {
  const { worker } = await req.json().catch(() => ({}))
  const workerUrl = process.env.WORKER_SERVICE_URL
  if (!workerUrl) return NextResponse.json({ error: 'Worker service not configured' }, { status: 500 })

  const targets = worker && WORKERS.includes(worker) ? [worker] : WORKERS

  const results: Record<string, unknown> = {}
  for (const w of targets) {
    try {
      const r = await fetch(`${workerUrl}/trigger/${w}`, { method: 'POST' })
      results[w] = r.ok ? await r.json() : { error: `status ${r.status}` }
    } catch (e) {
      results[w] = { error: e instanceof Error ? e.message : 'fetch failed' }
    }
  }
  return NextResponse.json(results)
}
