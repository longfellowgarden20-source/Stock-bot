// StockBot service worker — receives push, focuses dashboard on click.

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload = {}
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'StockBot', body: event.data.text() }
  }

  const title = payload.title || 'StockBot Signal'
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || payload.signal_id || 'stockbot',
    data: { url: payload.url || '/dashboard', signal_id: payload.signal_id },
    requireInteraction: (payload.severity || 0) >= 9,
    vibrate: [200, 100, 200],
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/dashboard'
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of allClients) {
      if (c.url.includes(url) && 'focus' in c) {
        return c.focus()
      }
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow(url)
    }
  })())
})
