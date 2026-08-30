/* Service worker for Usman Traders.
 *
 * Scope is the whole site, so both the admin app and the field form install
 * and open without a connection.
 *
 * Strategy:
 *   - navigation + shell assets: network first, falling back to cache. Stale
 *     business software is worse than slow business software, so a reachable
 *     server always wins; the cache is the safety net.
 *   - /api/: never cached. Showing yesterday's stock as today's would be
 *     actively harmful. Offline API calls fail, and the pages handle that -
 *     the field form queues its entries locally.
 */
const VERSION = "utf-v13";
const SHELL = [
  "/", "/index.html", "/app.js", "/styles.css",
  "/field.html", "/field.js",
  "/logo.png", "/icon-180.png", "/manifest.json", "/field.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // one missing file must not abort the whole install
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

function offlineFallback(request) {
  const url = new URL(request.url);
  if (request.mode === "navigate") {
    return caches.match(url.pathname.startsWith("/field") ? "/field.html" : "/index.html");
  }
  return caches.match(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // The item list is the one API answer worth keeping. A booking form with no
  // items is useless, and a day-old price list is far better than none - every
  // other endpoint stays live, because stale stock or money would mislead.
  if (url.pathname === "/api/field/bootstrap") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) =>
          hit || new Response('{"products":[],"customers":[],"suppliers":[]}',
                              { headers: { "Content-Type": "application/json" } }))));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;      // always live, never cached

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => offlineFallback(request).then((hit) =>
        hit || new Response("Offline", { status: 503, statusText: "Offline" }))));
});

/* Background Sync: Chrome/Android can wake the worker once connectivity is
   back, even if the page was closed. The page still syncs on its own when
   reopened, so this is an improvement rather than something to depend on -
   iOS does not implement it. */
self.addEventListener("sync", (event) => {
  if (event.tag === "utf-sync") {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: "sync-now" }));
      }));
  }
});
