// sw.js — keeps a copy of StarSound on the phone so it works at dark-sky
// sites with no cell signal. Bump VERSION whenever you change any file.
const VERSION = "starsound-v3";
const FILES = [
  "./", "./index.html", "./manifest.webmanifest",
  "./data/sky-data.js", "./data/stories.js", "./data/faq.js", "./lib/astronomy.browser.min.js",
  "./js/astro.js", "./js/sensors.js", "./js/audio.js", "./js/commands.js", "./js/listen.js", "./js/app.js",
  "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
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
  if (e.request.method !== "GET") return;
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
