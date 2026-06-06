import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params
  const t = ticker.toUpperCase()

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Get snapshot + its age
  const { data: snap } = await supabase
    .from('snapshots')
    .select('price, change_pct, created_at')
    .eq('ticker', t)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const snapAge = snap
    ? (Date.now() - new Date(snap.created_at).getTime()) / 60000  // minutes old
    : Infinity

  // If snapshot is fresh (< 10 min), use it
  if (snap && snapAge < 10) {
    return NextResponse.json({ price: snap.price, change_pct: snap.change_pct, updated_at: snap.created_at, source: 'snapshot' })
  }

  // Snapshot is stale or missing — fetch directly from Polygon
  const polygonKey = process.env.POLYGON_API_KEY
  if (polygonKey) {
    try {
      // Try snapshot endpoint first (works during/after market hours for last trade)
      const snapRes = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${t}?apiKey=${polygonKey}`,
        { next: { revalidate: 0 } }
      )
      if (snapRes.ok) {
        const snapData = await snapRes.json()
        const tickerData = snapData?.ticker
        const price =
          tickerData?.lastTrade?.p ||
          tickerData?.day?.c ||
          tickerData?.prevDay?.c
        if (price) {
          return NextResponse.json({
            price: Number(price),
            change_pct: tickerData?.todaysChangePerc ?? null,
            updated_at: new Date().toISOString(),
            source: 'polygon_snapshot',
          })
        }
      }

      // Fallback: daily agg (previous close if after hours)
      const today = new Date().toISOString().split('T')[0]
      const start = new Date(Date.now() - 7 * 86400_000).toISOString().split('T')[0]
      const aggRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${t}/range/1/day/${start}/${today}?apiKey=${polygonKey}&limit=3&sort=desc`,
        { next: { revalidate: 0 } }
      )
      if (aggRes.ok) {
        const aggData = await aggRes.json()
        const results = aggData?.results
        if (results?.length) {
          const close = Number(results[0].c)
          const prevClose = results[1]?.c ? Number(results[1].c) : null
          const change_pct = prevClose ? ((close - prevClose) / prevClose) * 100 : null
          return NextResponse.json({
            price: close,
            change_pct,
            updated_at: new Date().toISOString(),
            source: 'polygon_agg',
          })
        }
      }
    } catch {
      // fall through to stale snapshot
    }
  }

  // Last resort: return stale snapshot if we have one
  if (snap) {
    return NextResponse.json({ price: snap.price, change_pct: snap.change_pct, updated_at: snap.created_at, source: 'snapshot_stale' })
  }

  return NextResponse.json({ price: null })
}
