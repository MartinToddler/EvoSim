/**
 * Pull the simulation Worker chunk into the offline cache while the network is
 * still there (M14 CI investigation; task M01, docs/07 Milestone 13).
 *
 * ## The gap this closes
 *
 * `public/sw.js` precaches the shell only, and deliberately so: "everything
 * else is content-hashed and picked up on first use", because precaching a
 * guessed asset list fails the whole install if one guess is wrong. That is
 * sound for the render and UI chunks, which the first page load fetches anyway.
 *
 * It is not sound for ONE asset. `simulation.worker-*.js` is referenced from
 * nowhere in `index.html` — Vite emits it as a separate chunk that is fetched
 * the first time `new Worker(new URL(...))` runs, and that happens when a world
 * is created, not when the app loads. So an installed EON that had never
 * created a world had no copy of the simulation, and creating one offline hung
 * on "Creating world…" forever: the Worker fetch failed, no WORLD_READY ever
 * arrived, and the top bar sat at tick 0 with an empty world.
 *
 * docs/07 Milestone 13 promises the opposite — "an offline EON is a fully
 * working EON — all the way through creating and running a world with the
 * network off" — so this was a real hole in the offline story, found when the
 * browser suite's offline scenario failed on CI.
 *
 * ## Why a throwaway Worker rather than a fetch
 *
 * The chunk's URL is content-hashed and known only to the bundler. Vite rewrites
 * the `new Worker(new URL("…", import.meta.url))` FORM into that URL; a bare
 * `new URL(...)` is a different transform that can emit a different asset. So
 * the only way to name exactly the chunk `WorldSession` will later ask for is to
 * ask for it the same way. Constructing and immediately terminating one costs a
 * worker spin-up once per page load and guarantees the cache holds the same
 * bytes the real session needs.
 *
 * Failure is ignored on purpose: this is a cache warm-up, and an app that
 * cannot warm its cache must still start.
 */
export function warmSimulationWorkerCache(enabled: boolean): void {
  if (!enabled || typeof Worker === "undefined") {
    return;
  }
  try {
    const worker = new Worker(new URL("../worker/simulation.worker.ts", import.meta.url), {
      type: "module",
    });
    // The chunk is in the HTTP/service-worker cache the moment the request
    // completes; the Worker itself is not wanted. Terminating on the next task
    // rather than synchronously lets the fetch actually start.
    setTimeout(() => {
      worker.terminate();
    }, 0);
  } catch {
    // No Worker support, a blocked construction, or an offline first visit.
    // None of those are reasons to fail a page load.
  }
}
