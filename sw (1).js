// sw.js — keeps a copy of StarSound on the phone so it works at dark-sky
// sites with no cell signal. Bump VERSION whenever you change any file.
const VERSION = "starsound-v15";
const FILES = [
  "./", "./index.html", "./manifest.webmanifest",
  "./sky-data.js", "./stories.js", "./faq.js", "./astronomy.browser.min.js",
  "./astro.js", "./sensors.js", "./audio.js", "./commands.js", "./listen.js", "./app.js", "./tutorial.js", "./ui.js",
  "./icon.svg", "./silence.wav", "./font-400.woff2", "./font-600.woff2", "./font-800.woff2", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// network first (so updates show up), falling back to the saved copy offline
self.addEventListener("fetch", (e) => {
  // only this app's own files are cached; nothing from other sites is stored
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
