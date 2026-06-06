import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * #6: Signal export API
 * GET /api/signals/export?format=csv|json&days=30
 * Returns all signals from last N days with full metadata
 * CSV: ticker,date,type,severity,title,body
 * JSON: full signal objects
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const format = (sp.get('format') ?? 'json').toLowerCase() as 'json' | 'csv'
  const days = Math.min(Math.max(1, parseInt(sp.get('days') ?? '30')), 365) // Clamp 1-365 days

  if (!['json', 'csv'].includes(format)) {
    return NextResponse.json(
      { error: "format must be 'json' or 'csv'" },
      { status: 400 }
    )
  }

  const db = getSupabaseAdmin()
  const since = new Date()
  since.setDate(since.getDate() - days)

  try {
    const { data, error } = await db
      .from('signals')
      .select('*')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(10000) // Safety cap

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: 'No signals found for the given criteria', data: [] },
        { status: 404 }
      )
    }

    if (format === 'json') {
      return NextResponse.json({
        status: 'ok',
        count: data.length,
        days,
        data,
      })
    }

    // CSV format
    const headers = [
      'id',
      'ticker',
      'date',
      'type',
      'severity',
      'title',
      'body',
      'read',
    ]

    const rows = data.map((signal) => {
      const date = new Date(signal.created_at).toISOString().split('T')[0]
      return [
        signal.id,
        signal.ticker || '',
        date,
        signal.signal_type || '',
        signal.severity || 0,
        `"${(signal.title || '').replace(/"/g, '""')}"`,
        `"${(signal.body || '').replace(/"/g, '""')}"`,
        signal.read ? 'true' : 'false',
      ].join(',')
    })

    const csv = [headers.join(','), ...rows].join('\n')

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="signals_${days}d_${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
