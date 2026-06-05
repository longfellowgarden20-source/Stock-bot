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

  const [{ data: openTrades }, { data: closedTrades }, { data: performance }] = await Promise.all([
    supabase
      .from('sandbox_trades')
      .select('*')
      .eq('status', 'open')
      .order('entry_date', { ascending: false }),
    supabase
      .from('sandbox_trades')
      .select('*')
      .eq('status', 'closed')
      .gte('entry_date', since30d)
      .order('exit_date', { ascending: false })
      .limit(100),
    supabase
      .from('sandbox_performance')
      .select('*')
      .order('date', { ascending: false })
      .limit(30),
  ])

  return (
    <AppShell>
      <SandboxClient
        openTrades={openTrades ?? []}
        closedTrades={closedTrades ?? []}
        performance={performance ?? []}
      />
    </AppShell>
  )
}
