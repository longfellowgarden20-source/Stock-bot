import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET() {
  const db = getDb()
  const { data, error } = await db
    .from('journal_entries')
    .select('*')
    .order('date', { ascending: false })
    .limit(30)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { date, mood, market_notes, best_trade_id, worst_trade_id, lessons } = body

  if (!date) return NextResponse.json({ error: 'Missing date' }, { status: 400 })

  const db = getDb()
  const { data, error } = await db
    .from('journal_entries')
    .upsert(
      {
        date,
        mood: mood || null,
        market_notes: market_notes || null,
        best_trade_id: best_trade_id || null,
        worst_trade_id: worst_trade_id || null,
        lessons: lessons || null,
      },
      { onConflict: 'date' }
    )
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
