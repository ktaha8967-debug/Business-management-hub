// Ascentra Command - PWA Service Worker
const CACHE_NAME = 'ascentra-cache-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/ascentra_logo.png',
  '/ascentra_logo.jpg'
];

// Install event - cache app shell assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[Service Worker] Caching app shell');
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('[Service Worker] Some assets failed to cache during install:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches and claim clients
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cache) {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - network first with cache fallback
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith('http')) return;

  // Do not intercept api requests or external third-party widgets
  if (url.pathname.startsWith('/api/') || url.hostname.includes('meet.jit.si') || url.hostname.includes('cdn.jsdelivr.net')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(function() {
        return caches.match(event.request);
      })
  );
});

// Push notifications
self.addEventListener('push', function(event) {
  let data = { title: 'Ascentra Command', body: 'New operational alert received!' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Ascentra Command', body: event.data.text() };
    }
  }
  
  const isChatNotification = data.title && (data.title.includes('message') || data.title.includes('message in'));
  
  const options = {
    body: data.body,
    icon: 'ascentra_logo.jpg',
    badge: 'ascentra_logo.jpg',
    vibrate: [200, 100, 200, 100, 200],
    tag: isChatNotification ? 'chat-notification' : 'general-notification',
    renotify: true,
    requireInteraction: true,
    data: {
      url: self.registration.scope,
      type: isChatNotification ? 'chat' : 'general'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  
  const targetUrl = event.notification.data.type === 'chat' 
    ? event.notification.data.url + '#team-chat'
    : event.notification.data.url;
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Focus existing window if available
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if ('focus' in client) {
          client.focus();
          // Send message to client to open chat tab
          if (event.notification.data.type === 'chat') {
            client.postMessage({ type: 'OPEN_CHAT', title: event.notification.title });
          }
          return;
        }
      }
      // Open new window if no existing window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
