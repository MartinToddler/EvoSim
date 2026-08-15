import { describe, expect, it, vi } from "vitest";
import {
  registerServiceWorker,
  serviceWorkerUrl,
  unregisterServiceWorkers,
  type ServiceWorkerHost,
} from "./pwa";

/**
 * App-shell registration (task M01). The rules worth pinning are the ones a
 * wrong deploy would break silently: the base path, the cache generation, and
 * refusing to register where a worker would do harm.
 */
describe("serviceWorkerUrl", () => {
  it("resolves against the deployment base", () => {
    expect(serviceWorkerUrl("/", "abc")).toBe("/sw.js?v=abc");
    expect(serviceWorkerUrl("/EvoSim/", "abc")).toBe("/EvoSim/sw.js?v=abc");
  });

  it("tolerates a base without its trailing slash", () => {
    expect(serviceWorkerUrl("/EvoSim", "abc")).toBe("/EvoSim/sw.js?v=abc");
  });

  it("escapes a version that would otherwise change the query", () => {
    expect(serviceWorkerUrl("/", "a&b=c")).toBe("/sw.js?v=a%26b%3Dc");
  });

  it("changes with the build, which is what expires the old cache", () => {
    expect(serviceWorkerUrl("/", "build-1")).not.toBe(serviceWorkerUrl("/", "build-2"));
  });
});

describe("registerServiceWorker", () => {
  const host = (): ServiceWorkerHost & { register: ReturnType<typeof vi.fn> } => ({
    register: vi.fn().mockResolvedValue({}),
  });

  it("registers at the base scope", async () => {
    const serviceWorker = host();
    const registered = await registerServiceWorker({
      baseUrl: "/EvoSim/",
      version: "sha",
      enabled: true,
      host: serviceWorker,
    });
    expect(registered).toBe(true);
    expect(serviceWorker.register.mock.calls).toEqual([
      ["/EvoSim/sw.js?v=sha", { scope: "/EvoSim/" }],
    ]);
  });

  it("does nothing when disabled", async () => {
    const serviceWorker = host();
    expect(
      await registerServiceWorker({
        baseUrl: "/",
        version: "sha",
        enabled: false,
        host: serviceWorker,
      }),
    ).toBe(false);
    expect(serviceWorker.register.mock.calls).toEqual([]);
  });

  it("does nothing where the browser has no service workers", async () => {
    expect(
      await registerServiceWorker({ baseUrl: "/", version: "sha", enabled: true, host: undefined }),
    ).toBe(false);
  });

  it("survives a registration failure instead of taking the app down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing: ServiceWorkerHost = {
      register: () => Promise.reject(new Error("blocked by policy")),
    };
    await expect(
      registerServiceWorker({ baseUrl: "/", version: "sha", enabled: true, host: failing }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("unregisterServiceWorkers", () => {
  it("unregisters every registration", async () => {
    const first = { unregister: vi.fn().mockResolvedValue(true) };
    const second = { unregister: vi.fn().mockResolvedValue(true) };
    await unregisterServiceWorkers({
      register: vi.fn(),
      getRegistrations: () => Promise.resolve([first, second]),
    });
    expect(first.unregister.mock.calls).toHaveLength(1);
    expect(second.unregister.mock.calls).toHaveLength(1);
  });

  it("is a no-op where the API is missing", async () => {
    await expect(unregisterServiceWorkers(undefined)).resolves.toBeUndefined();
  });
});
