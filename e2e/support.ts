import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared helpers for the browser end-to-end suite (task L08, docs/07 PART E).
 *
 * Everything here is about *waiting for the right thing*, which is the whole
 * difficulty of testing this app in a browser: a world is generated, a Worker
 * starts, a WebGL context comes up and telemetry begins to flow, and none of
 * those are instant on a shared runner. Polling a tick counter is reliable in a
 * way that a fixed sleep never is.
 */

/** The mandatory deterministic fixture world (CLAUDE.md). */
export const FIXTURE_SEED_HEX = "0xE0A12026";

/** Read the top bar's tick counter. Returns -1 before the world exists. */
export async function readTick(page: Page): Promise<number> {
  const text = await page
    .locator(".stat", { has: page.locator(".stat-label", { hasText: /^Tick$/ }) })
    .locator(".stat-value")
    .innerText();
  const digits = text.replace(/[^\d]/g, "");
  return digits === "" ? -1 : Number.parseInt(digits, 10);
}

/** Read the top bar's population counter. */
export async function readPopulation(page: Page): Promise<number> {
  const text = await page
    .locator(".stat", { has: page.locator(".stat-label", { hasText: /^Population$/ }) })
    .locator(".stat-value")
    .innerText();
  const digits = text.replace(/[^\d]/g, "");
  return digits === "" ? 0 : Number.parseInt(digits, 10);
}

/** Start collecting console/page errors for {@link consoleErrors}. */
function collectErrors(page: Page): void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
  (page as Page & { __eonConsoleErrors?: string[] }).__eonConsoleErrors = errors;
}

/**
 * Walk the product's New World flow up to — but not including — Play
 * (ADR 0025): deep-link the seed into the New World screen, let it preview,
 * click Create World, and wait for the world stage to come up PAUSED at
 * exact tick 0.
 */
export async function createWorldPaused(page: Page, seedHex = FIXTURE_SEED_HEX): Promise<void> {
  collectErrors(page);

  // Relative, with no leading slash: `page.goto` resolves against `baseURL` as
  // `new URL(path, baseURL)`, and a leading "/" would resolve to the ORIGIN
  // ROOT and throw away the deployment path. A project Pages site lives at
  // `/<repo>/`, which is exactly the case EON_E2E_BASE_URL exists for.
  await page.goto(`./?seed=${seedHex}`);
  await expect(page.getByTestId("new-world-screen")).toBeVisible();
  // The preview generates synchronously on the main thread; Create World is
  // enabled once a valid world is on screen.
  const create = page.getByTestId("new-world-create");
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();

  await expect(page.locator(".topbar")).toBeVisible({ timeout: 90_000 });
  await waitForTelemetry(page);
  // A created world begins at exact tick 0, paused: the user starts time.
  expect(await readTick(page)).toBe(0);
}

/**
 * Wait until REAL telemetry is on screen. The top bar renders `0` placeholders
 * before the first telemetry frame, so a tick read taken too early describes
 * the placeholder, not the world. Population is the honest signal: a live
 * world always has organisms, a placeholder always shows zero.
 */
export async function waitForTelemetry(page: Page): Promise<void> {
  await expect
    .poll(async () => readPopulation(page), { timeout: 90_000, message: "telemetry never arrived" })
    .toBeGreaterThan(0);
}

/** Press Play (1×) and wait for authoritative time to actually advance. */
export async function pressPlay(page: Page): Promise<void> {
  await topBarButton(page, "Run the simulation").click();
  await expect
    .poll(async () => readTick(page), { timeout: 90_000, message: "world never started ticking" })
    .toBeGreaterThan(0);
}

/**
 * Open a world and run it: the product flow (New World → Create World → Play),
 * driven to the point where ticks are advancing. The shape every scenario that
 * just needs "a running world" starts from.
 */
export async function openWorld(page: Page, seedHex = FIXTURE_SEED_HEX): Promise<void> {
  await createWorldPaused(page, seedHex);
  await pressPlay(page);
}

/**
 * From the START SCREEN already on display (no navigation): click New World,
 * create the previewed world, and press Play. Used where navigation itself is
 * the thing under test — e.g. the offline reload.
 */
export async function runNewWorldFromStartScreen(page: Page): Promise<void> {
  await page.getByTestId("start-new-world").click();
  const create = page.getByTestId("new-world-create");
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();
  await expect(page.locator(".topbar")).toBeVisible({ timeout: 90_000 });
  await pressPlay(page);
}

/** Console and page errors collected since {@link openWorld}. */
export function consoleErrors(page: Page): string[] {
  return (page as Page & { __eonConsoleErrors?: string[] }).__eonConsoleErrors ?? [];
}

/** Wait until the tick counter has advanced by at least `delta`. */
export async function waitForTicks(page: Page, delta: number): Promise<void> {
  const from = await readTick(page);
  await expect
    .poll(async () => readTick(page), {
      timeout: 90_000,
      message: `tick never advanced ${delta} past ${from}`,
    })
    .toBeGreaterThanOrEqual(from + delta);
}

/** A top-bar button, addressed by its tooltip — the app's stable handle on it. */
export function topBarButton(page: Page, title: string): Locator {
  return page.locator(`.topbar button[title="${title}"]`);
}

/** The world canvas. */
export function canvas(page: Page): Locator {
  return page.locator(".viewport canvas");
}

/**
 * Click around the canvas until an organism is selected, or give up.
 *
 * A deterministic click point does not exist: organism positions are an
 * ecological outcome, so sweeping is what a user does too, and it tests exactly
 * the thing under test — that clicking a body selects it — without pretending to
 * know where the bodies are.
 *
 * Two things make the sweep actually land:
 *
 * - **It sweeps the world, not the canvas.** The camera fits the world into the
 *   shorter viewport axis, so at the default zoom the world is a centred square
 *   of side `min(width, height)` and everything outside it is void. Sweeping the
 *   full canvas spends most of its clicks on nothing.
 * - **It skips the floating chrome.** The top bar covers the first rows and the
 *   inspector the bottom-right corner; a click on either is intercepted and
 *   never reaches the canvas.
 *
 * The pick tolerance is 8 screen pixels around each body, so the grid pitch is
 * chosen fine enough that a populated world is very unlikely to fall through it.
 */
export async function selectAnyOrganism(page: Page): Promise<boolean> {
  const box = await canvas(page).boundingBox();
  if (box === null) return false;

  const side = Math.min(box.width, box.height);
  const originX = (box.width - side) / 2;
  const originY = (box.height - side) / 2;

  // The chrome that floats over the canvas, measured rather than guessed: a
  // click landing on the top bar or the inspector is intercepted and never
  // reaches the world, and a guessed exclusion rectangle is exactly how a sweep
  // ends up skipping the one corner the population is standing in.
  const blockers = (
    await Promise.all([
      page.locator(".topbar").boundingBox(),
      page.locator(".inspector").boundingBox(),
    ])
  ).filter((rect): rect is NonNullable<typeof rect> => rect !== null);

  const blocked = (pageX: number, pageY: number): boolean =>
    blockers.some(
      (rect) =>
        pageX >= rect.x &&
        pageX <= rect.x + rect.width &&
        pageY >= rect.y &&
        pageY <= rect.y + rect.height,
    );

  // Ordered from the middle of the world outward rather than raster-scanned: a
  // raster spends its first hundreds of clicks on whichever corner the world's
  // ocean happens to occupy, and every click costs a hit test and a React
  // render whether it lands or not.
  const steps = 30;
  const points: { x: number; y: number; d: number }[] = [];
  for (let row = 0; row <= steps; row += 1) {
    for (let column = 0; column <= steps; column += 1) {
      const x = box.x + originX + (side * column) / steps;
      const y = box.y + originY + (side * row) / steps;
      if (blocked(x, y)) continue;
      const dx = column / steps - 0.5;
      const dy = row / steps - 0.5;
      points.push({ x, y, d: dx * dx + dy * dy });
    }
  }
  points.sort((a, b) => a.d - b.d);

  for (const { x, y } of points) {
    // `page.mouse.click` rather than `locator.click`: the locator form re-runs
    // its actionability checks on every one of several hundred points, which
    // turns a sweep into a two-minute test. The canvas is already known to be
    // visible and stable, so the raw pointer event is the honest equivalent.
    await page.mouse.click(x, y);
    const selected = await page
      .locator(".inspector h2", { hasText: /Organism #\d+/ })
      .isVisible()
      .catch(() => false);
    if (selected) return true;
  }
  return false;
}

/**
 * The page's vertical scroll offset.
 *
 * A non-zero value means a canvas gesture scrolled the PAGE instead of panning
 * the world, which is the failure `touch-action: none` exists to prevent.
 */
export async function pageScrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}
