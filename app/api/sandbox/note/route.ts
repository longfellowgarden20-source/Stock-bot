import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// #2 — Save a user annotation on a closed or open sandbox trade
export async function POST(req: NextRequest) {
  try {
    const { trade_id, note } = await req.json().catch(() => ({}))
    if (!trade_id) return NextResponse.json({ error: 'trade_id required' }, { status: 400 })

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { error } = await supabase
      .from('sandbox_trades')
      .update({ user_note: note ?? null, updated_at: new Date().toISOString() })
      .eq('id', trade_id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[sandbox/note]', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
