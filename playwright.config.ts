import { existsSync, readdirSync, statSync } from "node:fs";
import { defineConfig, devices, type Project } from "@playwright/test";

/**
 * Browser end-to-end suite (tasks L08/L09, docs/07 PART E).
 *
 * CLAUDE.md's toolchain policy says to add Playwright once the first
 * interactive vertical slice exists. That became true at Milestone 6 and the
 * suite has been outstanding since (ADR 0010 §2); Milestone 12 is where it
 * lands, because "performance and calibration" is exactly the milestone whose
 * claims have to be checked in a real browser rather than in jsdom.
 *
 * ## What these tests are for, and what they are NOT for
 *
 * They check that the ten docs/07 PART E flows work through the real stack:
 * a real Worker, a real WebGL canvas, real IndexedDB. They deliberately do NOT
 * assert simulation outcomes — no population count, no hash, no species story.
 * Determinism is proven by the engine's golden fixtures in Node, where it can be
 * proven exactly; asserting it again through a browser would add flake without
 * adding evidence.
 *
 * ## The browser matrix
 *
 * docs/07 PART E asks for Chromium, Firefox and WebKit "where practical". Each
 * browser is a project here, and each project is included only when its browser
 * is actually installed, so a machine with one browser runs one project instead
 * of failing five ways. `pnpm e2e` on a machine with all three runs all three.
 *
 * Chromium resolves through PLAYWRIGHT_BROWSERS_PATH like the others, except
 * when the environment provides a pre-installed build under a different revision
 * than this Playwright pins — then `EON_CHROMIUM_PATH` points at it directly.
 */

const browsersRoot = process.env["PLAYWRIGHT_BROWSERS_PATH"];

/**
 * True when a browser directory for `prefix` exists in the browsers root.
 *
 * Playwright names its directories `<browser>-<revision>`, and the revision
 * moves with the Playwright version, so the check is a prefix match rather than
 * an exact path — otherwise every Playwright upgrade would silently drop
 * projects from the matrix.
 */
function browserInstalled(prefix: string): boolean {
  if (browsersRoot === undefined || !existsSync(browsersRoot)) {
    // No explicit root means the default cache, which we cannot cheaply probe;
    // assume installed and let Playwright report a clear error if it is not.
    return true;
  }
  return readdirSync(browsersRoot).some((entry) => entry.startsWith(`${prefix}-`));
}

/**
 * A pre-installed Chromium the environment supplies outside Playwright's own
 * revision layout.
 *
 * Some CI images ship one Chromium and symlink it as `<root>/chromium`, pinned
 * to a revision that will not match whatever `@playwright/test` wants after the
 * next upgrade. Playwright would then refuse to launch a browser that is sitting
 * right there. Honouring that symlink — and `EON_CHROMIUM_PATH` when it is set
 * explicitly — keeps the suite runnable on those images without pinning this
 * repository to their Playwright version.
 */
function resolveChromiumPath(): string | undefined {
  const explicit = process.env["EON_CHROMIUM_PATH"];
  if (explicit !== undefined && explicit !== "") return explicit;
  if (browsersRoot === undefined) return undefined;
  const symlinked = `${browsersRoot}/chromium`;
  return existsSync(symlinked) && !statSync(symlinked).isDirectory() ? symlinked : undefined;
}

const chromiumPath = resolveChromiumPath();

/**
 * The mobile scenario, which only means anything on a phone-sized viewport.
 *
 * It asserts the docs/06 §16 one-sheet rule, which the desktop layout
 * deliberately does not obey, so the desktop projects must skip this file and
 * the mobile project must run only it.
 */
const MOBILE_ONLY = /mobile\.spec\.ts$/;

const projects: Project[] = [];

if (chromiumPath !== undefined || browserInstalled("chromium")) {
  projects.push({
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      ...(chromiumPath !== undefined ? { launchOptions: { executablePath: chromiumPath } } : {}),
    },
    testIgnore: MOBILE_ONLY,
  });
  // docs/07 PART E scenario 10: mobile viewport pan/zoom/sheets. Runs on the
  // same engine as the desktop project — docs/02 §20 forbids changing
  // authoritative ecology by device class, so this checks layout, not biology.
  projects.push({
    name: "mobile-chromium",
    use: {
      ...devices["Pixel 7"],
      ...(chromiumPath !== undefined ? { launchOptions: { executablePath: chromiumPath } } : {}),
    },
    testMatch: MOBILE_ONLY,
  });
}

if (browserInstalled("firefox")) {
  projects.push({
    name: "firefox",
    use: { ...devices["Desktop Firefox"] },
    testIgnore: MOBILE_ONLY,
  });
}

if (browserInstalled("webkit")) {
  projects.push({
    name: "webkit",
    use: { ...devices["Desktop Safari"] },
    testIgnore: MOBILE_ONLY,
  });
}

export default defineConfig({
  testDir: "./e2e",
  // The app generates a 256x256 world and starts a Worker before anything is
  // interactive; on a shared CI runner that is seconds, not milliseconds.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // A retry hides a real flake in CI, so there are none. A failure here is a
  // failure to investigate.
  retries: 0,
  // The app is one shared world per page; workers each get their own page and
  // their own Worker thread, and this container has four cores that the
  // simulation itself wants.
  workers: 1,
  reporter: process.env["CI"] === undefined ? [["list"]] : [["list"], ["github"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects,
  // `vite preview` serves the production build, which is what deploys — so the
  // suite exercises the same bundle, the same Worker chunking and the same
  // service worker as the published site, not a dev-server approximation.
  webServer: {
    command: "pnpm --filter @eon/web preview --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: process.env["CI"] === undefined,
    timeout: 120_000,
  },
});
