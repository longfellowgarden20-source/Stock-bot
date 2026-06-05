import AppShell from '@/app/components/AppShell'
import BrainClient from './BrainClient'

export const dynamic = 'force-dynamic'

export default function BrainPage() {
  return (
    <AppShell>
      <BrainClient />
    </AppShell>
  )
}
