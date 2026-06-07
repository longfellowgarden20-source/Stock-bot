import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// #19 — Force-close an open trade at current price from the UI
export async function POST(req: NextRequest) {
  try {
    const { trade_id } = await req.json().catch(() => ({}))
    if (!trade_id) return NextResponse.json({ error: 'trade_id required' }, { status: 400 })

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch trade
    const { data: trade, error: fetchErr } = await supabase
      .from('sandbox_trades')
      .select('*')
      .eq('id', trade_id)
      .eq('status', 'open')
      .single()

    if (fetchErr || !trade) return NextResponse.json({ error: 'Open trade not found' }, { status: 404 })

    // Fetch current price from latest snapshot
    const { data: snap } = await supabase
      .from('snapshots')
      .select('price')
      .eq('ticker', trade.ticker)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    const exitPrice = snap?.price ? Number(snap.price) : Number(trade.entry_price)
    const entry = Number(trade.entry_price)
    const shares = Number(trade.shares) || 1
    const direction = trade.direction

    const pnl = direction === 'long'
      ? (exitPrice - entry) * shares
      : (entry - exitPrice) * shares
    const pnlPct = direction === 'long'
      ? (exitPrice - entry) / entry * 100
      : (entry - exitPrice) / entry * 100

    // Close the trade
    const { error: closeErr } = await supabase
      .from('sandbox_trades')
      .update({
        status: 'closed',
        exit_price: exitPrice,
        exit_date: new Date().toISOString().slice(0, 10),
        pnl: Math.round(pnl * 100) / 100,
        pnl_pct: Math.round(pnlPct * 10000) / 10000,
        exit_reason: 'force_close',
        groq_exit_note: 'Force-closed from UI',
        updated_at: new Date().toISOString(),
      })
      .eq('id', trade_id)

    if (closeErr) return NextResponse.json({ error: closeErr.message }, { status: 500 })

    // Update account balance + stats — mirror the worker's update_account_balance()
    // so force-closed trades count toward peak/win-rate/trade totals just like
    // worker-closed trades do. (Previously only `balance` was updated, leaving
    // peak_balance, total_trades and win/loss counters stale.)
    const { data: acct } = await supabase
      .from('sandbox_account')
      .select('id,balance,peak_balance,total_trades,winning_trades,losing_trades')
      .limit(1)
      .single()

    if (acct) {
      const newBalance = Math.round((Number(acct.balance) + pnl) * 100) / 100
      await supabase
        .from('sandbox_account')
        .update({
          balance: newBalance,
          peak_balance: Math.max(Number(acct.peak_balance) || newBalance, newBalance),
          total_trades: (Number(acct.total_trades) || 0) + 1,
          winning_trades: (Number(acct.winning_trades) || 0) + (pnl > 0 ? 1 : 0),
          losing_trades: (Number(acct.losing_trades) || 0) + (pnl < 0 ? 1 : 0),
          updated_at: new Date().toISOString(),
        })
        .eq('id', acct.id)
    }

    return NextResponse.json({ ok: true, exit_price: exitPrice, pnl, pnl_pct: pnlPct })
  } catch (err) {
    console.error('[sandbox/close]', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
