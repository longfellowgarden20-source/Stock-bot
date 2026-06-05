import AppShell from '@/app/components/AppShell'
import PlaysClient from './PlaysClient'

export const dynamic = 'force-dynamic'

export default function PlaysPage() {
  return (
    <AppShell>
      <PlaysClient />
    </AppShell>
  )
}
