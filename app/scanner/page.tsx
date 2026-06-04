import { createClient } from '@supabase/supabase-js'
import AppShell from '@/app/components/AppShell'
import ScannerClient from './ScannerClient'

export const revalidate = 30

export default async function ScannerPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

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
