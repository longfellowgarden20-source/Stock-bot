import { getSupabaseServer } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import WatchlistClient from './WatchlistClient'

export const dynamic = 'force-dynamic'

export default async function WatchlistPage() {
  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

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
