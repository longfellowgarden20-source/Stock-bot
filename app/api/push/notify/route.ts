import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { sendPush } from '@/lib/web-push'

export const dynamic = 'force-dynamic'

/**
 * Internal endpoint — called by the Python worker (or any source) to dispatch
 * a push notification to subscribed browsers. Filtered by min_severity.
 *
 * Auth: requires PUSH_NOTIFY_TOKEN header matching env. Reject otherwise.
 *
 * Body: { signal_id, ticker, signal_type, severity, title, body }
 */
export async function POST(req: NextRequest) {
  const token = req.headers.get('x-push-token')
  if (!token || token !== process.env.PUSH_NOTIFY_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.signal_id || !body?.title || typeof body.severity !== 'number') {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 })
  }

  const db = getSupabaseAdmin()
  const { data: subs, error } = await db
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, min_severity')
    .lte('min_severity', body.severity)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!subs || subs.length === 0) return NextResponse.json({ ok: true, sent: 0 })

  const payload = {
    title: body.title,
    body: (body.body || '').slice(0, 200),
    signal_id: body.signal_id,
    severity: body.severity,
    url: `/signals/${body.signal_id}`,
    tag: body.signal_id,
  }

  const expired: string[] = []
  let sent = 0
  await Promise.all(
    subs.map(async (sub) => {
      const result = await sendPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      )
      if (result.ok) {
        sent += 1
      } else if (result.status === 404 || result.status === 410) {
        expired.push(sub.endpoint)
      }
    }),
  )

  if (expired.length) {
    await db.from('push_subscriptions').delete().in('endpoint', expired)
  }

  return NextResponse.json({ ok: true, sent, expired: expired.length })
}
