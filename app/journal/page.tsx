import { createClient } from '@supabase/supabase-js'
import AppShell from '@/app/components/AppShell'
import JournalClient from './JournalClient'

export const dynamic = 'force-dynamic'

export default async function JournalPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [{ data: trades }, { data: coachingNotes }] = await Promise.all([
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
  ])

  return (
    <AppShell>
      <JournalClient
        initialTrades={trades ?? []}
        latestCoachingNote={coachingNotes?.[0] ?? null}
      />
    </AppShell>
  )
}
