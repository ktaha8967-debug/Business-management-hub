// Ascentra Command - PWA Service Worker for Push Notifications
self.addEventListener('push', function(event) {
  let data = { title: 'Ascentra Command', body: 'New operational alert received!' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Ascentra Command', body: event.data.text() };
    }
  }
  
  const options = {
    body: data.body,
    icon: 'ascentra_logo.jpg',
    badge: 'ascentra_logo.jpg',
    vibrate: [100, 50, 100],
    data: {
      url: self.registration.scope
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if (client.url === event.notification.data.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url);
      }
    })
  );
});
