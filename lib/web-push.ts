import webpush from 'web-push'

let configured = false

function configure() {
  if (configured) return
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
  if (!publicKey || !privateKey) {
    throw new Error('VAPID keys not configured — run `npx web-push generate-vapid-keys`')
  }
  webpush.setVapidDetails(subject, publicKey, privateKey)
  configured = true
}

export type PushPayload = {
  title: string
  body: string
  signal_id?: string
  severity?: number
  url?: string
  tag?: string
}

export async function sendPush(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: PushPayload,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  configure()
  try {
    const result = await webpush.sendNotification(subscription, JSON.stringify(payload))
    return { ok: true, status: result.statusCode }
  } catch (e: unknown) {
    const err = e as { statusCode?: number; message?: string }
    return { ok: false, status: err.statusCode, error: err.message || 'send failed' }
  }
}
