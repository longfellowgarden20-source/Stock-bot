import { createClient } from '@supabase/supabase-js'
import AppShell from '@/app/components/AppShell'
import JournalClient from './JournalClient'

export const dynamic = 'force-dynamic'

export default async function JournalPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const today = new Date().toISOString().split('T')[0]
  const since7d = new Date(Date.now() - 7 * 86400_000).toISOString().split('T')[0]

  const since2d = new Date(Date.now() - 2 * 86400_000).toISOString()

  const [{ data: trades }, { data: coachingNotes }, { data: predictions }, { data: briefs }, { data: lessons }] = await Promise.all([
    supabase
      .from('trades')
      .select('*')
      .order('date', { ascending: false })
      .limit(200),
    supabase
      .from('coaching_notes')
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(1),
    supabase
      .from('eod_predictions')
      .select('*')
      .gte('date', since7d)
      .order('date', { ascending: false })
      .order('ticker'),
    supabase
      .from('prediction_lessons')
      .select('*')
      .gte('date', since7d)
      .order('date', { ascending: false }),
    supabase
      .from('signals')
      .select('*')
      .eq('ticker', 'REDDIT')
      .eq('signal_type', 'convergence')
      .gte('created_at', since2d)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  return (
    <AppShell>
      <JournalClient
        initialTrades={trades ?? []}
        latestCoachingNote={coachingNotes?.[0] ?? null}
        predictions={predictions ?? []}
        briefs={briefs ?? []}
        lessons={lessons ?? []}
        today={today}
      />
    </AppShell>
  )
}
