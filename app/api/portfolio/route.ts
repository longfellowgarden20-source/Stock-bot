import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { ticker, shares, avg_cost, notes } = await req.json()
  if (!ticker || !shares || !avg_cost) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

  const { data, error } = await getSupabaseAdmin()
    .from('portfolio')
    .insert({ ticker: ticker.toUpperCase(), shares, avg_cost, notes: notes || null })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  await getSupabaseAdmin().from('portfolio').delete().eq('id', id)
  return NextResponse.json({ ok: true })
}
