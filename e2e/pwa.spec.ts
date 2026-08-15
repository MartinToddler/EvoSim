import { expect, test } from "@playwright/test";
import { openWorld, readTick, runNewWorldFromStartScreen } from "./support";

/**
 * Installable shell and lifecycle behaviour in a real browser (tasks M01/M03,
 * docs/07 Milestone 13).
 *
 * These check the two things a unit test cannot: that the manifest and the
 * worker are actually *served* at the deployment base — a wrong base is silent
 * at build time and fatal at run time — and that hiding the page really stops
 * the simulation.
 */

test.describe("installable app shell", () => {
  test("serves a manifest with everything an install needs", async ({ page, baseURL }) => {
    await page.goto("./");

    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href, "index.html must link a manifest").not.toBeNull();

    const base = baseURL?.endsWith("/") === true ? baseURL : `${baseURL ?? ""}/`;
    const response = await page.request.get(new URL(href as string, base).href);
    expect(response.ok()).toBe(true);

    const manifest = (await response.json()) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: { src: string; sizes: string; type: string; purpose?: string }[];
    };

    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBeTruthy();

    // Chromium's install criteria: a 192px and a 512px icon, plus a maskable
    // one for Android's adaptive shapes.
    const icons = manifest.icons ?? [];
    expect(icons.some((icon) => icon.sizes.includes("192"))).toBe(true);
    expect(icons.some((icon) => icon.sizes.includes("512"))).toBe(true);
    expect(icons.some((icon) => (icon.purpose ?? "").includes("maskable"))).toBe(true);

    // Every icon must actually be there. A manifest that lists a 404 installs
    // with a blank icon and nothing warns.
    for (const icon of icons) {
      const iconResponse = await page.request.get(
        new URL(icon.src, new URL(href as string, base)).href,
      );
      expect(iconResponse.ok(), `${icon.src} must be served`).toBe(true);
    }
  });

  test("serves the service worker at the deployment base", async ({ page, baseURL }) => {
    await page.goto("./");
    // `baseURL` may name a subdirectory, so the worker is resolved relative to
    // it — the same reason the app registers `<base>sw.js` rather than `/sw.js`.
    const base = baseURL?.endsWith("/") === true ? baseURL : `${baseURL ?? ""}/`;
    const response = await page.request.get(new URL("sw.js", base).href);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain("eon-shell-");
  });
});

test.describe("offline app shell", () => {
  test("registers a service worker that takes control", async ({ page }) => {
    // `vite preview` serves the production build over http on 127.0.0.1, which
    // browsers treat as a secure context, so this is the same code path as the
    // deployed site.
    await page.goto("./");
    await expect(page.getByTestId("start-screen")).toBeVisible();

    const active = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active !== null;
    });
    expect(active, "a service worker should be active after the first visit").toBe(true);
  });

  test("opens again with the network switched off", async ({ page, context, browserName }) => {
    // Playwright's WebKit build fails `page.reload()` with an internal error
    // once the context is offline — the navigation never completes, before any
    // application code runs. The two halves of this scenario that WebKit CAN
    // answer are covered above and by the manifest test; skipping is honest,
    // and pretending would be worse than the gap.
    test.skip(
      browserName === "webkit",
      "Playwright WebKit: page.reload() errors internally in an offline context",
    );

    await page.goto("./");
    await expect(page.getByTestId("start-screen")).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);

    // A reload while online, so the navigation response is in the cache the
    // worker will serve from.
    await page.reload();
    await expect(page.getByTestId("start-screen")).toBeVisible();

    await context.setOffline(true);
    await page.reload();

    // The shell is what has to survive; the simulation runs locally anyway, so
    // an offline EON is a fully working EON — all the way through creating and
    // running a world with the network off.
    await expect(page.getByTestId("start-screen")).toBeVisible({ timeout: 60_000 });
    await runNewWorldFromStartScreen(page);
    await expect
      .poll(async () => readTick(page), { timeout: 90_000, message: "offline world never ticked" })
      .toBeGreaterThan(0);

    await context.setOffline(false);
  });
});

test.describe("page lifecycle", () => {
  test("stops the simulation while the page is hidden and restarts it after", async ({ page }) => {
    await openWorld(page);

    // Drive the real event: `visibilitychange` with a hidden `visibilityState`
    // is exactly what a phone delivers when the user switches app. The
    // property is redefined rather than faked at a higher level so the app's
    // own read of it is what changes.
    const setVisibility = async (state: "hidden" | "visible"): Promise<void> => {
      await page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => value,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    };

    await setVisibility("hidden");
    await expect(page.locator(".topbar")).toContainText("Paused", { timeout: 30_000 });

    const whileHidden = await readTick(page);
    await page.waitForTimeout(1_500);
    expect(await readTick(page)).toBe(whileHidden);

    await setVisibility("visible");
    await expect.poll(async () => readTick(page), { timeout: 30_000 }).toBeGreaterThan(whileHidden);
  });
});
