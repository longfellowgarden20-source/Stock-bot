import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import TradeDetailClient from './TradeDetailClient'

export const dynamic = 'force-dynamic'

export default async function TradeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: trade } = await supabase
    .from('sandbox_trades')
    .select('*')
    .eq('id', id)
    .single()

  if (!trade) notFound()

  return (
    <AppShell>
      <TradeDetailClient trade={trade} />
    </AppShell>
  )
}
