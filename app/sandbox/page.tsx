import { createClient } from '@supabase/supabase-js'
import AppShell from '@/app/components/AppShell'
import SandboxClient from './SandboxClient'

export const dynamic = 'force-dynamic'

export default async function SandboxPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const since30d = new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0]
  const today = new Date().toISOString().split('T')[0]
  const since7d = new Date(Date.now() - 7 * 86400_000).toISOString().split('T')[0]

  const [
    { data: openTrades },
    { data: closedTrades },
    { data: performance },
    { data: accountRows },
    { data: equity },
    { data: premktPlanRows },
    { data: groqSelfRows },
    { data: groqPatternsRows },
    { data: groqWeeklyRows },
    { data: tradeEvals },
  ] = await Promise.all([
    supabase.from('sandbox_trades').select('*').eq('status', 'open').order('entry_date', { ascending: false }),
    supabase.from('sandbox_trades').select('*').eq('status', 'closed').gte('entry_date', since30d).order('exit_date', { ascending: false }).limit(100),
    supabase.from('sandbox_performance').select('*').order('date', { ascending: false }).limit(30),
    supabase.from('sandbox_account').select('*').limit(1),
    supabase.from('sandbox_equity').select('*').order('date', { ascending: true }).limit(60),
    // #12 — Today's pre-market game plan
    supabase.from('sandbox_premarket_plans').select('*').eq('date', today).limit(1),
    // #14 — Latest Groq self-critique (last 3 days)
    supabase.from('prediction_lessons').select('date,lesson,key_factors').eq('ticker', 'GROQ_SELF').gte('date', since7d).order('date', { ascending: false }).limit(3),
    // #14 — Latest pattern rules
    supabase.from('prediction_lessons').select('date,lesson').eq('ticker', 'GROQ_PATTERNS').order('date', { ascending: false }).limit(1),
    // #14 — Latest weekly rules
    supabase.from('prediction_lessons').select('date,lesson').eq('ticker', 'GROQ_WEEKLY').order('date', { ascending: false }).limit(1),
    // #13 — Recent swing trade re-evaluations
    supabase.from('sandbox_trade_evals').select('*').order('evaluated_at', { ascending: false }).limit(50),
  ])

  const account = accountRows?.[0] ?? null
  const premktPlan = premktPlanRows?.[0] ?? null

  return (
    <AppShell>
      <SandboxClient
        openTrades={openTrades ?? []}
        closedTrades={closedTrades ?? []}
        performance={performance ?? []}
        account={account}
        equity={equity ?? []}
        premktPlan={premktPlan}
        groqSelfCritiques={groqSelfRows ?? []}
        groqPatterns={groqPatternsRows?.[0] ?? null}
        groqWeekly={groqWeeklyRows?.[0] ?? null}
        tradeEvals={tradeEvals ?? []}
      />
    </AppShell>
  )
}
