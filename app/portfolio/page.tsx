import { getSupabaseServer } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import PortfolioClient from './PortfolioClient'

export const dynamic = 'force-dynamic'

export default async function PortfolioPage() {
  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const { data: portfolio } = await supabase
    .from('portfolio')
    .select('*')
    .order('added_at', { ascending: false })

  const { data: snapshots } = await supabase
    .from('snapshots')
    .select('ticker, price, change_pct, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  const latestSnaps: Record<string, { price: number; change_pct: number }> = {}
  for (const s of snapshots ?? []) {
    if (!latestSnaps[s.ticker]) latestSnaps[s.ticker] = { price: s.price, change_pct: s.change_pct }
  }

  return (
    <AppShell>
      <PortfolioClient portfolio={portfolio ?? []} snapshots={latestSnaps} />
    </AppShell>
  )
}
