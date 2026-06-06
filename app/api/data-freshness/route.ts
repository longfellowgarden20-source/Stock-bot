import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * #7: Data freshness check
 * GET /api/data-freshness?ticker=AAPL
 * Returns age of last snapshot and staleness indicators
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const ticker = (sp.get('ticker') ?? '').toUpperCase()

  if (!ticker) {
    return NextResponse.json(
      { error: 'ticker required' },
      { status: 400 }
    )
  }

  try {
    const db = getSupabaseAdmin()
    const { data, error } = await db
      .from('snapshots')
      .select('data_freshness')
      .eq('ticker', ticker)
      .order('data_freshness', { ascending: false })
      .limit(1)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!data || data.length === 0) {
      return NextResponse.json({
        ticker,
        last_update: null,
        age_minutes: null,
        is_stale_10min: true,
        is_stale_1hr: true,
      })
    }

    const lastUpdate = data[0].data_freshness
    const lastDate = new Date(lastUpdate)
    const now = new Date()
    const ageSeconds = (now.getTime() - lastDate.getTime()) / 1000
    const ageMinutes = ageSeconds / 60

    return NextResponse.json({
      ticker,
      last_update: lastUpdate,
      age_minutes: Math.round(ageMinutes * 10) / 10,
      is_stale_10min: ageMinutes > 10,
      is_stale_1hr: ageMinutes > 60,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
