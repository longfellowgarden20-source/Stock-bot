import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params
  const t = ticker.toUpperCase()

  // Try Finnhub first — free real-time quotes, no snapshot-tier restrictions
  const finnhubKey = process.env.FINNHUB_API_KEY
  if (finnhubKey) {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${t}&token=${finnhubKey}`,
        { next: { revalidate: 0 } }
      )
      if (res.ok) {
        const d = await res.json()
        // c = current price (or last close), pc = previous close
        const price = d.c && d.c > 0 ? d.c : null
        if (price) {
          const change_pct = d.pc && d.pc > 0 ? ((d.c - d.pc) / d.pc) * 100 : null
          return NextResponse.json({
            price,
            change_pct,
            updated_at: new Date().toISOString(),
            source: 'finnhub',
          })
        }
      }
    } catch {
      // fall through
    }
  }

  // Fallback: Polygon daily agg (rate-limited on free tier, use sparingly)
  const polygonKey = process.env.POLYGON_API_KEY
  if (polygonKey) {
    try {
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
          return NextResponse.json({ price: close, change_pct, updated_at: new Date().toISOString(), source: 'polygon_agg' })
        }
      }
    } catch {
      // fall through
    }
  }

  // Last resort: stale DB snapshot
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { data: snap } = await supabase
    .from('snapshots')
    .select('price, change_pct, created_at')
    .eq('ticker', t)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (snap) {
    return NextResponse.json({ price: snap.price, change_pct: snap.change_pct, updated_at: snap.created_at, source: 'snapshot_stale' })
  }

  return NextResponse.json({ price: null })
}
