// Precyz — service worker. Zatím jen pro push notifikace, žádné agresivní
// cachování appky (appka se má vždy načíst čerstvá, ne ze staré kopie).

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = { title: 'Precyz', body: 'Máš novou zprávu.' };
  try { data = event.data.json(); } catch (e) { /* fallback na výchozí text */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Precyz', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: data.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('precyz') && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
