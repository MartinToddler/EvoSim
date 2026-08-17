import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Write the built asset list into the service worker's precache placeholder.
 *
 * `public/sw.js` used to precache the shell alone, on the stated grounds that
 * "precaching a guessed asset list would fail the whole install if one guess
 * were wrong". The objection is to GUESSING, and this is not a guess: the list
 * is the bundle Vite just emitted.
 *
 * It has to be a list, because the app is full of chunks nothing fetches until
 * they are needed. Two were found the hard way, both by the offline browser
 * scenario: `simulation.worker-*.js`, which is fetched when a world is created,
 * and Pixi's `browserAll-*.js` renderer backend, which is `import()`ed when a
 * renderer starts. Both happen after a user has gone offline, and both left the
 * app dead in a different place — "Creating world…" forever, then "renderer
 * failed to start". Warming them one at a time is a game with no last move.
 */
function precacheBuiltAssets(): Plugin {
  let outDir = "dist";
  let assets: string[] = [];
  return {
    name: "eon-precache-built-assets",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      // Every emitted chunk and asset, as a URL relative to the scope root. The
      // service worker resolves them against its own scope, so the same list
      // works at "/" and under a project Pages path.
      assets = Object.keys(bundle).filter((name) => !name.endsWith(".map"));
    },
    closeBundle() {
      const swPath = join(outDir, "sw.js");
      const source = readFileSync(swPath, "utf8");
      const replaced = source.replace('"__EON_PRECACHE_ASSETS__"', JSON.stringify(assets));
      if (replaced === source) {
        throw new Error(
          `sw.js has no __EON_PRECACHE_ASSETS__ placeholder; the offline precache would ` +
            "silently ship empty",
        );
      }
      writeFileSync(swPath, replaced);
    },
  };
}

/**
 * Web application build.
 *
 * `base` is configurable because the same bundle has to work from two different
 * roots: `/` for `vite dev` and any host serving the app at a domain root, and
 * `/<repo>/` for a GitHub Pages project site. Hard-coding either one breaks the
 * other, and a wrong base is silent at build time and fatal at run time — every
 * asset, including the Worker, 404s.
 *
 * `worker.format: "es"` is required rather than cosmetic. The Worker is
 * instantiated as `new Worker(url, { type: "module" })` and its bundle is code
 * split (Pixi is not in it, the engine is), and a classic IIFE worker cannot
 * import chunks.
 */
export default defineConfig({
  base: process.env["EON_BASE_PATH"] ?? "/",
  plugins: [react(), precacheBuiltAssets()],
  worker: {
    format: "es",
  },
  build: {
    // Source maps make a deployed determinism bug diagnosable from the browser
    // instead of only from a local checkout.
    sourcemap: true,
  },
});
