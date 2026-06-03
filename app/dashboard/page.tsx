import { getSupabaseServer } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import DashboardClient from './DashboardClient'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const { data: signals } = await supabase
    .from('signals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  const { data: snapshots } = await supabase
    .from('snapshots')
    .select('ticker, price, change_pct, volume, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  type SnapRow = { ticker: string; price: number; change_pct: number; volume: number; created_at: string }
  const latestSnaps: Record<string, SnapRow> = {}
  for (const s of (snapshots ?? []) as SnapRow[]) {
    if (!latestSnaps[s.ticker]) latestSnaps[s.ticker] = s
  }

  const unreadCount = (signals ?? []).filter(s => !s.read).length

  return (
    <AppShell unreadCount={unreadCount}>
      <DashboardClient signals={signals ?? []} snapshots={Object.values(latestSnaps)} />
    </AppShell>
  )
}
