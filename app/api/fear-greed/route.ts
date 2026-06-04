import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function fetchVixFromFred(): Promise<number | null> {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) return null
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=${apiKey}&sort_order=desc&limit=5&file_type=json`
    const r = await fetch(url, { next: { revalidate: 0 } })
    if (!r.ok) return null
    const data = await r.json()
    const obs = data?.observations ?? []
    for (const o of obs) {
      const val = parseFloat(o.value)
      if (!isNaN(val)) return val
    }
    return null
  } catch {
    return null
  }
}

export async function GET() {
  const db = getSupabaseAdmin()
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [
    { data: macroSignals },
    { data: convergenceSignals },
    { data: allSignals24h },
    fredVix,
  ] = await Promise.all([
    db.from('signals').select('raw_data').eq('signal_type', 'macro').gte('created_at', since24h).limit(20),
    db.from('signals').select('id').eq('signal_type', 'convergence').gte('created_at', since24h),
    db.from('signals').select('severity').gte('created_at', since24h).limit(200),
    fetchVixFromFred(),
  ])

  // Extract VIX from macro signals if FRED unavailable
  let vix: number | null = fredVix
  if (vix === null && macroSignals) {
    for (const row of macroSignals) {
      const rd = row.raw_data as Record<string, unknown> | null
      const v = rd?.vix ?? rd?.VIX ?? rd?.vix_value
      if (v != null && !isNaN(Number(v))) {
        vix = Number(v)
        break
      }
    }
  }

  // Compute components
  let vixScore = 0
  if (vix !== null) {
    if (vix < 15) vixScore = 20
    else if (vix < 20) vixScore = 10
    else if (vix < 25) vixScore = 0
    else if (vix < 30) vixScore = -10
    else vixScore = -20
  }

  const convergenceCount = convergenceSignals?.length ?? 0
  let convergenceScore = 0
  if (convergenceCount > 5) convergenceScore = 10
  else if (convergenceCount >= 2) convergenceScore = 5

  const severities = (allSignals24h ?? []).map(s => s.severity as number)
  const avgSeverity = severities.length > 0 ? severities.reduce((a, b) => a + b, 0) / severities.length : 0
  // High severity = more fear (market stress), not greed
  let severityScore = 0
  if (avgSeverity > 7) severityScore = -10
  else if (avgSeverity >= 5) severityScore = -5

  const raw = 50 + vixScore + convergenceScore + severityScore
  const score = Math.max(0, Math.min(100, raw))

  let label: string
  if (score <= 20) label = 'Extreme Fear'
  else if (score <= 40) label = 'Fear'
  else if (score <= 60) label = 'Neutral'
  else if (score <= 80) label = 'Greed'
  else label = 'Extreme Greed'

  return NextResponse.json({
    score,
    label,
    vix,
    components: {
      base: 50,
      vix: vixScore,
      convergence: convergenceScore,
      severity: severityScore,
      convergence_count: convergenceCount,
      avg_severity: Math.round(avgSeverity * 10) / 10,
    },
    updated_at: new Date().toISOString(),
  })
}
