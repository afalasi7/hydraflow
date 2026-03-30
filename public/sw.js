self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open("hydraflow-v1").then((cache) =>
      cache.addAll(["/", "/manifest.webmanifest", "/favicon.svg"]),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== "hydraflow-v1").map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
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
          caches.open("hydraflow-v1").then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match("/"));
    }),
  );
});
