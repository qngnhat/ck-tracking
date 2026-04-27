// ── Service Worker: cache app shell with stale-while-revalidate ──

const CACHE = "stock-analyzer-v32";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./analysis.js",
  "./ranking.js",
  "./portfolio.js",
  "./auth.js",
  "./config.js",
  "./app.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never cache API calls — always go to network for fresh data
  if (url.hostname.includes("vndirect.com.vn")) return;

  // Stale-while-revalidate for same-origin assets:
  // serve cache (fast), but always fetch fresh in background and update cache.
  if (e.request.method === "GET" && url.origin === self.location.origin) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        const fetchPromise = fetch(e.request)
          .then((response) => {
            if (response && response.ok) cache.put(e.request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
