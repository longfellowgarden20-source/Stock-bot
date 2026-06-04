'use client'

import { useEffect, useState } from 'react'
import { Bell, BellOff, Loader2 } from 'lucide-react'

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export default function PushToggle() {
  const [enabled, setEnabled] = useState(false)
  const [supported, setSupported] = useState(true)
  const [busy, setBusy] = useState(false)
  const [endpoint, setEndpoint] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setSupported(false)
      return
    }
    // Don't await `ready` — it never resolves if no SW is registered.
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      if (!reg) return
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        setEnabled(true)
        setEndpoint(sub.endpoint)
      }
    }).catch(() => { /* no sw yet */ })
  }, [])

  const enable = async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready

      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        setBusy(false)
        return
      }

      const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!vapid) {
        alert('VAPID public key not configured')
        setBusy(false)
        return
      }

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid).buffer as ArrayBuffer,
      })

      const json = sub.toJSON()
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          min_severity: 8,
        }),
      })
      setEnabled(true)
      setEndpoint(json.endpoint || null)
    } catch (e) {
      console.error('Push enable failed', e)
      alert('Could not enable notifications')
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await sub.unsubscribe()
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        })
      }
      setEnabled(false)
      setEndpoint(null)
    } catch (e) {
      console.error('Push disable failed', e)
    } finally {
      setBusy(false)
    }
  }

  if (!supported) return null

  return (
    <button
      onClick={enabled ? disable : enable}
      disabled={busy}
      className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-400 hover:text-white border border-white/10 rounded-xl hover:bg-white/5 disabled:opacity-50"
      style={{ transition: 'color 0.15s, background 0.15s' }}
      title={endpoint ? `Subscribed: ${endpoint.slice(0, 40)}…` : 'Enable browser notifications'}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : enabled ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
      {enabled ? 'Alerts on' : 'Enable alerts'}
    </button>
  )
}
