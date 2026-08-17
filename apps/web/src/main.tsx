import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { APP_VERSION } from "./app/appVersion";
import { registerServiceWorker } from "./app/pwa";
import { readViewFromLocation } from "./app/route";
import { EnvironmentDebugView } from "./dev/EnvironmentDebugView";
import { MorphologyGalleryView } from "./dev/MorphologyGalleryView";

/**
 * Composition root.
 *
 * Three screens: the simulation, the seed-driven world generator recovered
 * with Milestone 11, and the M14 morphology gallery (see `app/route.ts`). The choice is made here, once, so
 * neither screen has to know the other exists — the generator in particular
 * builds worlds synchronously on the main thread and must never be mounted
 * beside a running Worker.
 */
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Missing #root element in index.html");
}

const view = readViewFromLocation(globalThis.location?.search ?? "");

createRoot(rootElement).render(
  <StrictMode>
    {view === "generator" ? (
      <EnvironmentDebugView />
    ) : view === "morphology" ? (
      <MorphologyGalleryView />
    ) : (
      <App />
    )}
  </StrictMode>,
);

// The offline app shell (task M01), registered AFTER the first render: a
// service worker cannot make the first paint faster and must not delay it. In
// development it is skipped entirely — a worker caching a dev server's modules
// turns hot reload into a mystery.
void registerServiceWorker({
  baseUrl: import.meta.env.BASE_URL,
  version: APP_VERSION,
  enabled: import.meta.env.PROD,
  host: globalThis.navigator?.serviceWorker,
});
