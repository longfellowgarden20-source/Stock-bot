import { createClient } from '@supabase/supabase-js'
import AppShell from '@/app/components/AppShell'
import WatchlistClient from './WatchlistClient'

export const dynamic = 'force-dynamic'

export default async function WatchlistPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: watchlist } = await supabase
    .from('watchlist')
    .select('*')
    .order('added_at', { ascending: false })

  return (
    <AppShell>
      <WatchlistClient watchlist={watchlist ?? []} />
    </AppShell>
  )
}
