import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseServer } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

export async function POST() {
  // Require authenticated session — only the logged-in user can reset
  const auth = await getSupabaseServer()
  const { data: { user } } = await auth.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  try {
    // Delete in FK-safe order
    await supabase.from('sandbox_trade_evals').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('sandbox_trades').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('sandbox_performance').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('sandbox_equity').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('sandbox_premarket_plans').delete().neq('id', '00000000-0000-0000-0000-000000000000')

    // Reset account balance to $50k
    const { data: existing } = await supabase.from('sandbox_account').select('id').limit(1)
    if (existing && existing.length > 0) {
      await supabase.from('sandbox_account').update({
        balance: 50000.00,
        starting_balance: 50000.00,
        peak_balance: 50000.00,
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        updated_at: new Date().toISOString(),
      }).eq('id', existing[0].id)
    } else {
      await supabase.from('sandbox_account').insert({
        balance: 50000.00,
        starting_balance: 50000.00,
        peak_balance: 50000.00,
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
      })
    }

    return NextResponse.json({ status: 'ok', message: 'Sandbox reset to $50,000' })
  } catch (err) {
    console.error('[sandbox/reset]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Reset failed' }, { status: 500 })
  }
}
