import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// Cancel all pending (unfilled) limit orders — mirrors what the worker does
// when age > 30 min. Called from the UI when the worker is offline.
export async function POST() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: pending, error } = await supabase
    .from('sandbox_trades')
    .select('id,ticker')
    .eq('status', 'open')
    .eq('fill_status', 'pending')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!pending || pending.length === 0) return NextResponse.json({ cancelled: 0 })

  const today = new Date().toISOString().slice(0, 10)
  const { error: updateErr } = await supabase
    .from('sandbox_trades')
    .update({
      status: 'closed',
      exit_reason: 'limit_expired',
      pnl: 0,
      pnl_pct: 0,
      exit_date: today,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'open')
    .eq('fill_status', 'pending')

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  return NextResponse.json({ cancelled: pending.length, tickers: pending.map(t => t.ticker) })
}
