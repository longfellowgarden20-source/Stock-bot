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
    supabase.from('sandbox_trades').select('id,ticker,trade_type,entry_date,position_size,fill_status').eq('status', 'open'),
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

  // The equity snapshot is written once per day (~5:15pm ET) and the worker skips
  // weekends, so the gap legitimately spans a full weekend on Monday mornings
  // (Fri 5pm → Mon 9am ≈ 64h). Widen the alive window on weekend/Monday so a
  // healthy worker is never falsely reported as "offline".
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const etDow = etDate.getDay() // 0 Sun … 6 Sat
  const aliveWindow = etDow === 0 || etDow === 1 || etDow === 6 ? 74 : 28
  const workerAlive = hoursSinceEquity < aliveWindow || hoursSinceAccount < aliveWindow

  // Count stale open trades — use ET date to match how sandbox_worker records entry_date
  const today = `${etDate.getFullYear()}-${String(etDate.getMonth() + 1).padStart(2, '0')}-${String(etDate.getDate()).padStart(2, '0')}`
  const staleDayTrades = (openTrades || []).filter(
    t => t.trade_type === 'day' && t.entry_date < today
  )

  // Available cash = account balance minus capital locked in FILLED open positions
  // Pending (not yet filled) orders don't count — no capital deployed until filled
  const deployedCapital = (openTrades ?? [])
    .filter(t => (t as any).fill_status !== 'pending')
    .reduce((sum, t) => sum + (Number((t as any).position_size) || 0), 0)
  const availableCash = account ? Math.max(0, Math.round((Number(account.balance) - deployedCapital) * 100) / 100) : null

  return NextResponse.json({
    worker_alive: workerAlive,
    hours_since_last_activity: Math.min(hoursSinceEquity, hoursSinceAccount),
    account: account ?? null,
    available_cash: availableCash,
    deployed_capital: Math.round(deployedCapital * 100) / 100,
    open_positions: openTrades?.length ?? 0,
    stale_day_trades: staleDayTrades.length,
    last_equity_date: lastEquity?.date ?? null,
    last_performance: lastPerf ?? null,
    last_eval_at: lastEval?.evaluated_at ?? null,
  })
}
