import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [
    { data: account },
    { data: openTrades },
    { data: lastEquity },
    { data: lastPerf },
    { data: lastEval },
  ] = await Promise.all([
    supabase.from('sandbox_account').select('balance,peak_balance,total_trades,updated_at').limit(1).single(),
    supabase.from('sandbox_trades').select('id,ticker,trade_type,entry_date').eq('status', 'open'),
    supabase.from('sandbox_equity').select('date,balance,win_rate').order('date', { ascending: false }).limit(1).single(),
    supabase.from('sandbox_performance').select('date,wins,losses,win_rate,gross_pnl').order('date', { ascending: false }).limit(1).single(),
    supabase.from('sandbox_trade_evals').select('evaluated_at').order('evaluated_at', { ascending: false }).limit(1).single(),
  ])

  // Determine if worker is alive — last equity snapshot should be today or yesterday on weekdays
  const now = new Date()
  const lastEquityDate = lastEquity?.date ? new Date(lastEquity.date) : null
  const hoursSinceEquity = lastEquityDate
    ? (now.getTime() - lastEquityDate.getTime()) / 3600000
    : Infinity

  // Last account update (set on every trade close)
  const lastAccountUpdate = account?.updated_at ? new Date(account.updated_at) : null
  const hoursSinceAccount = lastAccountUpdate
    ? (now.getTime() - lastAccountUpdate.getTime()) / 3600000
    : Infinity

  const workerAlive = hoursSinceEquity < 26 || hoursSinceAccount < 26

  // Count stale open trades (day trades from before today)
  const today = now.toISOString().split('T')[0]
  const staleDayTrades = (openTrades || []).filter(
    t => t.trade_type === 'day' && t.entry_date !== today
  )

  return NextResponse.json({
    worker_alive: workerAlive,
    hours_since_last_activity: Math.min(hoursSinceEquity, hoursSinceAccount),
    account: account ?? null,
    open_positions: openTrades?.length ?? 0,
    stale_day_trades: staleDayTrades.length,
    last_equity_date: lastEquity?.date ?? null,
    last_performance: lastPerf ?? null,
    last_eval_at: lastEval?.evaluated_at ?? null,
  })
}
