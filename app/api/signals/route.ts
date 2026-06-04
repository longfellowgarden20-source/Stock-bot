import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  const { id, read, ids } = await req.json()
  const db = getSupabaseAdmin()
  if (Array.isArray(ids) && ids.length > 0) {
    await db.from('signals').update({ read: read ?? true }).in('id', ids)
    return NextResponse.json({ ok: true, count: ids.length })
  }
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  await db.from('signals').update({ read: read ?? true }).eq('id', id)
  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const ticker = sp.get('ticker')
  const limit = parseInt(sp.get('limit') ?? '200')
  const from = sp.get('from')
  const to = sp.get('to')
  const type = sp.get('type')
  const minSeverity = sp.get('minSeverity')

  const db = getSupabaseAdmin()
  let q = db.from('signals').select('*').order('created_at', { ascending: false }).limit(Math.min(limit, 200))
  if (ticker) q = q.eq('ticker', ticker.toUpperCase())
  if (type && type !== 'all') q = q.eq('signal_type', type)
  if (minSeverity) q = q.gte('severity', parseInt(minSeverity))
  if (from) q = q.gte('created_at', new Date(from).toISOString())
  if (to) {
    // Include the full end day
    const toDate = new Date(to)
    toDate.setDate(toDate.getDate() + 1)
    q = q.lt('created_at', toDate.toISOString())
  }
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
