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
  const ticker = req.nextUrl.searchParams.get('ticker')
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50')
  const db = getSupabaseAdmin()
  let q = db.from('signals').select('*').order('created_at', { ascending: false }).limit(limit)
  if (ticker) q = q.eq('ticker', ticker.toUpperCase())
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
