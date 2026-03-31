const CACHE_KEY = "hydraflow-v2";

function getBaseUrl() {
  return new URL(self.registration.scope).pathname;
}

self.addEventListener("install", (event) => {
  const baseUrl = getBaseUrl();

  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_KEY).then((cache) =>
      cache.addAll([baseUrl, `${baseUrl}manifest.webmanifest`, `${baseUrl}favicon.svg`]),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_KEY).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const baseUrl = getBaseUrl();

  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_KEY).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(baseUrl));
    }),
  );
});
