import AppShell from '@/app/components/AppShell'
import { DashboardSkeleton } from '@/app/components/LoadingSkeleton'

export default function Loading() {
  return (
    <AppShell>
      <DashboardSkeleton />
    </AppShell>
  )
}
