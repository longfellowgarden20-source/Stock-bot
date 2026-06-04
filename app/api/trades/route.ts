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
    .from('trades')
    .select('*')
    .order('date', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { date, ticker, direction, entry_price, exit_price, shares, pattern, grade, grade_accurate, writeup, mistakes, best_ops } = body

  if (!date || !ticker || !direction || entry_price == null || shares == null) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  let pnl: number | null = null
  if (exit_price != null) {
    const multiplier = direction === 'short' ? -1 : 1
    pnl = Math.round(((Number(exit_price) - Number(entry_price)) * Number(shares) * multiplier) * 100) / 100
  }

  const db = getDb()
  const { data, error } = await db
    .from('trades')
    .insert({
      date,
      ticker: ticker.toUpperCase(),
      direction,
      entry_price: Number(entry_price),
      exit_price: exit_price != null ? Number(exit_price) : null,
      shares: Number(shares),
      pnl,
      pattern: pattern || null,
      grade: grade || null,
      grade_accurate: grade_accurate ?? null,
      writeup: writeup || null,
      mistakes: mistakes || null,
      best_ops: best_ops || null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
