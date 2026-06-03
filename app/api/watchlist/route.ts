import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { ticker, notes, alert_threshold_pct } = await req.json()
  if (!ticker) return NextResponse.json({ error: 'Missing ticker' }, { status: 400 })

  const { data, error } = await getSupabaseAdmin()
    .from('watchlist')
    .insert({ ticker: ticker.toUpperCase(), notes: notes || null, alert_threshold_pct: alert_threshold_pct || null })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  await getSupabaseAdmin().from('watchlist').delete().eq('id', id)
  return NextResponse.json({ ok: true })
}
