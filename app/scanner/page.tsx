import { getSupabaseServer } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import ScannerClient from './ScannerClient'

export const dynamic = 'force-dynamic'

export default async function ScannerPage() {
  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  // Top signals from last 24h grouped by ticker
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: signals } = await supabase
    .from('signals')
    .select('*')
    .gte('created_at', since)
    .order('severity', { ascending: false })
    .limit(200)

  return (
    <AppShell>
      <ScannerClient signals={signals ?? []} />
    </AppShell>
  )
}
