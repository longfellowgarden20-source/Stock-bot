import { createClient } from '@supabase/supabase-js'
import AppShell from '@/app/components/AppShell'
import PortfolioClient from './PortfolioClient'

export const revalidate = 30

export default async function PortfolioPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

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
