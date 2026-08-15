/**
 * Installable / offline app shell registration (task M01, docs/07 Milestone 13).
 *
 * The service worker itself is `public/sw.js`; this module decides *whether* and
 * *where* to register it, which is the part with rules worth testing.
 *
 * ## Why the URL carries the build version
 *
 * A browser refetches a service worker when its URL or bytes change. `sw.js` is
 * copied verbatim from `public/`, so its bytes are identical between two builds
 * of different application code — a user would keep the old worker, and its
 * cache, indefinitely. Appending the build version makes every deploy a new
 * worker URL, and the worker reads the same value back out of its own
 * `location.search` to name (and expire) its cache.
 *
 * ## Why registration is opt-out in development
 *
 * A service worker caching a dev server's modules turns hot reload into a
 * mystery. It registers only for a real build, and `unregisterServiceWorkers`
 * exists so a developer who once loaded a production build on `localhost` can
 * get out again.
 */

/** The minimum of `navigator.serviceWorker` this module uses. */
export interface ServiceWorkerHost {
  register(url: string, options?: { scope?: string }): Promise<unknown>;
  getRegistrations?(): Promise<readonly { unregister(): Promise<boolean> }[]>;
}

export interface RegisterServiceWorkerOptions {
  /** `import.meta.env.BASE_URL`: "/" locally, "/<repo>/" on a project Pages site. */
  baseUrl: string;
  /** Build identifier; becomes the cache generation. */
  version: string;
  /** False in development, where a caching worker only hides changes. */
  enabled: boolean;
  /** Injected for tests; the real one is `navigator.serviceWorker`. */
  host: ServiceWorkerHost | undefined;
}

/**
 * The script URL to register, including the cache-generation query.
 *
 * Relative to the base so the same bundle works at a domain root and under a
 * repository path — the same reason `vite.config.ts` takes `base` from the
 * environment.
 */
export function serviceWorkerUrl(baseUrl: string, version: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}sw.js?v=${encodeURIComponent(version)}`;
}

/**
 * Register the app-shell worker. Resolves to whether registration was attempted.
 *
 * Failure is swallowed deliberately: an app that refuses to start because it
 * could not arrange to work offline would be trading a working session for a
 * cache. It is reported to the console and nowhere else.
 */
export async function registerServiceWorker(
  options: RegisterServiceWorkerOptions,
): Promise<boolean> {
  const { host } = options;
  if (!options.enabled || host === undefined) {
    return false;
  }
  const base = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
  try {
    await host.register(serviceWorkerUrl(options.baseUrl, options.version), { scope: base });
    return true;
  } catch (error) {
    console.warn("EON: offline app shell unavailable", error);
    return false;
  }
}

/** Remove any worker this origin has registered. For development escape hatches. */
export async function unregisterServiceWorkers(host: ServiceWorkerHost | undefined): Promise<void> {
  if (host?.getRegistrations === undefined) return;
  const registrations = await host.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}
