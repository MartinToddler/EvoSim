/*
 * EON service worker (task M01, docs/07 Milestone 13).
 *
 * ## What it is for
 *
 * One thing: making the app shell open without a network. EON is a simulation
 * that runs entirely in the browser — no API, no server state — so once its
 * bundle is on the device there is nothing left to fetch. A saved world lives
 * in IndexedDB, which does not involve this file at all.
 *
 * ## Why it is hand-written
 *
 * A precache-manifest plugin would inline a list of hashed asset URLs at build
 * time. That is the right tool for an app with a server; here it buys nothing
 * over the strategy below and costs a build-time dependency that would have to
 * be kept in step with the Worker chunking. This file is 100 lines and does
 * exactly what it says.
 *
 * ## Strategy
 *
 * - **Navigations**: network first, falling back to the cached shell. A user
 *   who is online always gets the current build; a user who is offline still
 *   gets the app.
 * - **Same-origin GETs inside our scope**: cache first, then network, and
 *   successful responses are cached. Vite emits content-hashed filenames, so a
 *   cached asset URL is immutable — cache-first is correct rather than merely
 *   convenient, and it is what makes the simulation Worker and the Pixi chunks
 *   available offline.
 * - **Everything else** (cross-origin, non-GET): untouched. This worker never
 *   sees a request it has no reason to answer.
 *
 * ## Versioning
 *
 * The cache name carries the build version, which arrives as `?v=` on this
 * script's own URL — changing it both makes the browser fetch a new worker and
 * tells that worker to drop every older cache on activate. That is why the
 * registration in `pwa.ts` appends the app version.
 */

const VERSION = new URL(self.location.href).searchParams.get("v") ?? "dev";
const CACHE_NAME = `eon-shell-${VERSION}`;

/** Scope root, e.g. "/" locally and "/EvoSim/" on a project Pages site. */
const SCOPE = new URL("./", self.location.href);

/**
 * What is fetched eagerly on install.
 *
 * Only the shell entry: everything else is content-hashed and picked up on
 * first use. Precaching a guessed asset list would fail the whole install if
 * one guess were wrong, which is a worse failure than a second visit being the
 * one that completes the offline copy.
 */
const SHELL = [SCOPE.href, new URL("index.html", SCOPE).href];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL);
      // Take over as soon as the new build is cached; the alternative is a user
      // who reloads to get a fix and is served the old worker anyway.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((name) =>
          name.startsWith("eon-shell-") && name !== CACHE_NAME ? caches.delete(name) : undefined,
        ),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(SCOPE.href)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          await cache.put(SHELL[0], response.clone());
          return response;
        } catch {
          const cached = await caches.match(SHELL[0]);
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached !== undefined) return cached;
      const response = await fetch(request);
      // Opaque and error responses are not worth caching: an opaque body cannot
      // be validated and a 404 cached forever is a bug that survives a deploy.
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
