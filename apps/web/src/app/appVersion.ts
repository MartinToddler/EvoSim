/**
 * The build identifier, in one place.
 *
 * Two things need it and must agree: every world manifest records the build that
 * wrote it (Milestone 10), and the service worker's cache generation is derived
 * from it (Milestone 13). If those two ever disagreed, a saved world could name
 * a build whose assets had already been evicted — so they read the same string
 * rather than each reading the same environment variable and hoping.
 *
 * Vite substitutes `VITE_APP_VERSION` at build time; the fallback keeps a dev
 * server honest rather than pretending to know.
 */
export const APP_VERSION: string =
  (import.meta.env["VITE_APP_VERSION"] as string | undefined) ?? "dev";
