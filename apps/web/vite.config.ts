import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  plugins: [react()],
  worker: {
    format: "es",
  },
  build: {
    // Source maps make a deployed determinism bug diagnosable from the browser
    // instead of only from a local checkout.
    sourcemap: true,
  },
});
