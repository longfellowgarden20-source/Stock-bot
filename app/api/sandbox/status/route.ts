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

  const now = new Date()
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const etDow = etDate.getDay() // 0 Sun … 6 Sat
  const isWeekend = etDow === 0 || etDow === 6

  // Primary liveness signal: sandbox_trade_evals.evaluated_at — written every worker
  // cycle when there are open positions to re-evaluate. Most reliable heartbeat.
  const lastEvalTime = lastEval?.evaluated_at ? new Date(lastEval.evaluated_at) : null
  const hoursSinceEval = lastEvalTime
    ? (now.getTime() - lastEvalTime.getTime()) / 3600000
    : Infinity

  // Secondary: equity snapshot (written once daily ~5pm ET on weekdays)
  const lastEquityDate = lastEquity?.date ? new Date(lastEquity.date) : null
  const hoursSinceEquity = lastEquityDate
    ? (now.getTime() - lastEquityDate.getTime()) / 3600000
    : Infinity

  // Tertiary: account updated_at (written on every trade close)
  const lastAccountUpdate = account?.updated_at ? new Date(account.updated_at) : null
  const hoursSinceAccount = lastAccountUpdate
    ? (now.getTime() - lastAccountUpdate.getTime()) / 3600000
    : Infinity

  // Worker is alive if ANY signal is fresh:
  //   - eval within 2h (worker ran recently with open positions)
  //   - equity within 28h on weekdays / 74h over weekends (Mon morning)
  //   - account updated within same window
  const evalAlive = hoursSinceEval < 2
  const equityWindow = isWeekend || etDow === 1 ? 74 : 28
  const dataAlive = hoursSinceEquity < equityWindow || hoursSinceAccount < equityWindow
  const workerAlive = evalAlive || dataAlive

  const hoursSinceLastActivity = Math.min(hoursSinceEval, hoursSinceEquity, hoursSinceAccount)

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
    hours_since_last_activity: hoursSinceLastActivity,
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
