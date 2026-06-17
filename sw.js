var CACHE_VERSION = 'v2';
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(name) { return caches.delete(name); }));
    }).then(function() { return clients.claim(); })
  );
});
self.addEventListener('fetch', function(e) { e.respondWith(fetch(e.request)); });
