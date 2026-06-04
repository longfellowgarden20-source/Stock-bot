import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return NextResponse.json({ error: 'invalid subscription' }, { status: 400 })
  }
  const userAgent = req.headers.get('user-agent') || null
  const minSeverity = Math.max(1, Math.min(10, Number(body.min_severity ?? 9)))

  const { error } = await getSupabaseAdmin()
    .from('push_subscriptions')
    .upsert(
      {
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        user_agent: userAgent,
        min_severity: minSeverity,
      },
      { onConflict: 'endpoint' },
    )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.endpoint) return NextResponse.json({ error: 'endpoint required' }, { status: 400 })
  const { error } = await getSupabaseAdmin().from('push_subscriptions').delete().eq('endpoint', body.endpoint)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
