// SOLO: the offline service worker. The game runs entirely in the page now
// (its server is the sim worker), so once a visit has cached the build the
// next one needs no network at all. vite.config.ts fills in the version and
// the build's file list (self.__AB_SW__) and emits this as /sw.js.
//
//   - install: precache EVERY file of this build (3–4 MB: the bundle, the
//     sim worker, the radio voices, the icons) under the build's version;
//   - activate: drop every other version's cache, take the open pages;
//   - fetch: a page load is network-first (a deploy shows up at once),
//     falling back to the cached shell offline; anything else of this
//     origin is cache-first (the hashed assets never change), filling the
//     cache as it goes.

const { version, files } = self.__AB_SW__;
const CACHE = `ab-${version}`;
const SHELL = "./";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SHELL, ...files]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("ab-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(SHELL, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(SHELL, { cacheName: CACHE, ignoreVary: true })
            .then((hit) => hit ?? Response.error()),
        ),
    );
    return;
  }
  event.respondWith(
    // ignoreVary: a server's `Vary: Origin` must not split the precached
    // copy from a module script's request (which carries an Origin).
    caches.match(req, { ignoreSearch: true, ignoreVary: true }).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
