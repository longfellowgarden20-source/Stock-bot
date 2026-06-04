import { createClient } from '@supabase/supabase-js'
import AppShell from '@/app/components/AppShell'
import DashboardClient from './DashboardClient'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [{ data: signals }, { data: snapshots }, { data: morningBriefRows }] = await Promise.all([
    supabase
      .from('signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('snapshots')
      .select('ticker, price, change_pct, volume, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('signals')
      .select('*')
      .eq('ticker', 'REDDIT')
      .eq('signal_type', 'convergence')
      .gte('created_at', todayStart.toISOString())
      .order('created_at', { ascending: false })
      .limit(1),
  ])

  type SnapRow = { ticker: string; price: number; change_pct: number; volume: number; created_at: string }
  const latestSnaps: Record<string, SnapRow> = {}
  for (const s of (snapshots ?? []) as SnapRow[]) {
    if (!latestSnaps[s.ticker]) latestSnaps[s.ticker] = s
  }

  const unreadCount = (signals ?? []).filter(s => !s.read).length
  const morningBrief = morningBriefRows?.[0] ?? null

  return (
    <AppShell unreadCount={unreadCount}>
      <DashboardClient
        signals={signals ?? []}
        snapshots={Object.values(latestSnaps)}
        morningBrief={morningBrief}
      />
    </AppShell>
  )
}
