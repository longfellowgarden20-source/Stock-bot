import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import PositionDetailClient from './PositionDetailClient'

export const dynamic = 'force-dynamic'

function fmt30DaysAgo() {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().split('T')[0]
}

function fmtToday() {
  return new Date().toISOString().split('T')[0]
}

export default async function PositionDetailPage({
  params,
}: {
  params: Promise<{ ticker: string }>
}) {
  const { ticker } = await params
  const symbol = ticker.toUpperCase()

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  // Parallel DB fetches
  const [
    { data: position },
    { data: snapshots },
    { data: signals },
    { data: allPortfolio },
  ] = await Promise.all([
    supabase.from('portfolio').select('*').eq('ticker', symbol).single(),
    supabase
      .from('snapshots')
      .select('*')
      .eq('ticker', symbol)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('signals')
      .select('*')
      .eq('ticker', symbol)
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('portfolio').select('id, ticker, shares, avg_cost'),
  ])

  if (!position) notFound()

  const latestSnapshot = snapshots?.[0] ?? null

  // Compute total portfolio value for position sizing
  let totalPortfolioValue = 0
  // We'd need snapshots for all tickers — approximate with cost basis
  for (const p of allPortfolio ?? []) {
    totalPortfolioValue += p.shares * p.avg_cost
  }

  // Parallel external API fetches
  const FINNHUB = process.env.FINNHUB_API_KEY ?? ''
  const POLYGON = process.env.POLYGON_API_KEY ?? ''
  const fromDate = fmt30DaysAgo()
  const toDate = fmtToday()

  const [profile, metrics, news, recommendations, prevClose] = await Promise.all([
    fetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${FINNHUB}`,
      { next: { revalidate: 0 } }
    )
      .then(r => r.ok ? r.json() : null)
      .catch(() => null),

    fetch(
      `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${FINNHUB}`,
      { next: { revalidate: 0 } }
    )
      .then(r => r.ok ? r.json() : null)
      .catch(() => null),

    fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate}&to=${toDate}&token=${FINNHUB}`,
      { next: { revalidate: 0 } }
    )
      .then(r => r.ok ? r.json() : null)
      .then((arr: unknown) => Array.isArray(arr) ? (arr as object[]).slice(0, 10) : null)
      .catch(() => null),

    fetch(
      `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${FINNHUB}`,
      { next: { revalidate: 0 } }
    )
      .then(r => r.ok ? r.json() : null)
      .catch(() => null),

    fetch(
      `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${POLYGON}`,
      { next: { revalidate: 0 } }
    )
      .then(r => r.ok ? r.json() : null)
      .catch(() => null),
  ])

  return (
    <AppShell>
      <PositionDetailClient
        position={position}
        snapshots={snapshots ?? []}
        latestSnapshot={latestSnapshot}
        signals={signals ?? []}
        totalPortfolioValue={totalPortfolioValue}
        profile={profile}
        metrics={metrics}
        news={news ?? []}
        recommendations={recommendations}
        prevClose={prevClose}
      />
    </AppShell>
  )
}
