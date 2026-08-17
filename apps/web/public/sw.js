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
 * The navigation shell. Its absence is fatal to an offline start, so it is
 * cached strictly: if this fails, the install fails.
 */
const SHELL = [SCOPE.href, new URL("index.html", SCOPE).href];

/**
 * Every file the build emitted, injected by the `eon-precache-built-assets`
 * plugin in `apps/web/vite.config.ts`. The literal below is replaced at build
 * time; it stays an empty list in `vite dev`, where no worker is registered.
 *
 * ## Why this is a list now
 *
 * It used to be the shell alone, reasoning that "everything else is
 * content-hashed and picked up on first use" and that precaching a GUESSED list
 * would fail the whole install if one guess were wrong. The second half of that
 * is still true, which is why this list is emitted by the build rather than
 * guessed — but the first half was wrong, because "first use" is not the first
 * page load for every chunk.
 *
 * Two chunks proved it, both found by the offline browser scenario:
 * `simulation.worker-*.js`, fetched when a world is created, and Pixi's
 * `browserAll-*.js` renderer backend, `import()`ed when a renderer starts.
 * Neither is touched by opening the app, so an installed EON that had never run
 * a world could not start one offline — it sat on "Creating world…", and once
 * that was fixed, on "renderer failed to start". docs/07 Milestone 13 promises
 * a fully working offline EON, so the fix has to cover the whole bundle rather
 * than the two chunks that happened to be caught.
 */
const PRECACHE_ASSETS = "__EON_PRECACHE_ASSETS__";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL);
      // The bundle is cached best-effort and INDIVIDUALLY. `addAll` rejects
      // wholesale on a single failure, which would turn one unlucky asset into
      // no offline app at all; a missing chunk should cost only that chunk.
      if (Array.isArray(PRECACHE_ASSETS)) {
        await Promise.allSettled(
          PRECACHE_ASSETS.map((asset) => cache.add(new URL(asset, SCOPE).href)),
        );
      }
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
