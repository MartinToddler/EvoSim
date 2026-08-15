import { expect, test } from "@playwright/test";
import {
  FIXTURE_SEED_HEX,
  consoleErrors,
  createWorldPaused,
  pressPlay,
  readTick,
  topBarButton,
} from "./support";

/**
 * FLOW 1 — NEW WORLD (ADR 0025; docs/01 §9 states 1-2).
 *
 * The world-start flow is a product surface, not a debug tool: the app opens on
 * a start screen, New World previews maps without any authoritative time
 * existing, Create World is the explicit acceptance, the created world begins
 * at exact tick 0 PAUSED with its tick-0 baseline persisted, and Play is what
 * starts evolution. The previewed map and the authoritative map are the same
 * world, and the app can prove it.
 */

test.describe("the world-start flow", () => {
  test("startup offers New World and Load World, and starts nothing on its own", async ({
    page,
  }) => {
    await page.goto("./");
    const start = page.getByTestId("start-screen");
    await expect(start).toBeVisible();
    await expect(page.getByTestId("start-new-world")).toBeVisible();
    await expect(start).toContainText("Load World");
    // No world exists: no top bar, no canvas, no tick.
    await expect(page.locator(".topbar")).toHaveCount(0);
    await expect(page.locator(".viewport canvas")).toHaveCount(0);
  });

  test("New World: seed, regenerate, preview, create; tick 0 paused; Play starts time", async ({
    page,
  }) => {
    await page.goto("./");
    await page.getByTestId("start-new-world").click();
    const screen = page.getByTestId("new-world-screen");
    await expect(screen).toBeVisible();

    // Choose an explicit seed and regenerate the preview from it.
    await page.getByTestId("new-world-seed").fill(FIXTURE_SEED_HEX);
    await page.getByTestId("new-world-regenerate").click();
    await expect(page.getByTestId("new-world-seed-hex")).toHaveText(FIXTURE_SEED_HEX, {
      timeout: 30_000,
    });

    // A random seed produces a (very probably) different map; regenerating the
    // explicit seed again returns to exactly the previewed world.
    const fixtureDigest = await page.getByTestId("new-world-env-hash").innerText();
    await page.getByTestId("new-world-random").click();
    await expect(page.getByTestId("new-world-seed-hex")).not.toHaveText(FIXTURE_SEED_HEX);
    await page.getByTestId("new-world-seed").fill(FIXTURE_SEED_HEX);
    await page.getByTestId("new-world-regenerate").click();
    await expect(page.getByTestId("new-world-env-hash")).toHaveText(fixtureDigest);

    // Accept the world.
    await page.getByTestId("new-world-name").fill("Flow One");
    await page.getByTestId("new-world-create").click();
    await expect(page.locator(".topbar")).toBeVisible({ timeout: 90_000 });

    // Exact tick 0, and PAUSED: time does not move until Play.
    await expect
      .poll(async () => readTick(page), { timeout: 90_000 })
      .toBeGreaterThanOrEqual(0);
    expect(await readTick(page)).toBe(0);
    await page.waitForTimeout(2_000);
    expect(await readTick(page)).toBe(0);
    await expect(page.locator(".topbar")).toContainText("Paused");

    // The authoritative world IS the previewed world: same environment digest.
    await expect(page.locator(".app")).toHaveAttribute("data-environment-hash", fixtureDigest);

    // Creating the world was an explicit persistence intent: the tick-0
    // baseline is already stored under the chosen name.
    await topBarButton(page, "Save this world, or load one you saved earlier").click();
    const worlds = page.locator(".worlds-panel");
    const row = worlds.locator(".world-row", { hasText: "Flow One" });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText("tick 0");
    await expect(row).toContainText("• open");

    // Play starts evolution.
    await pressPlay(page);
    expect(await readTick(page)).toBeGreaterThan(0);
  });

  test("a discarded preview is not persisted", async ({ page }) => {
    await page.goto("./");
    await page.getByTestId("start-new-world").click();
    await expect(page.getByTestId("new-world-screen")).toBeVisible();
    // Preview a couple of maps, then walk away without creating anything.
    await page.getByTestId("new-world-random").click();
    await expect(page.getByTestId("new-world-create")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("new-world-back").click();

    const start = page.getByTestId("start-screen");
    await expect(start).toBeVisible();
    await expect(page.getByTestId("start-no-worlds")).toBeVisible({ timeout: 30_000 });
  });

  test("a created world reloads from the start screen at its saved tick, paused", async ({
    page,
  }) => {
    await createWorldPaused(page);
    await pressPlay(page);
    // Let it run a little so the reloaded tick is visibly not zero — the
    // autosave-on-hide is not what is under test, so save explicitly.
    await expect.poll(async () => readTick(page), { timeout: 60_000 }).toBeGreaterThan(20);
    await topBarButton(page, "Save this world, or load one you saved earlier").click();
    const worlds = page.locator(".worlds-panel");
    await worlds.getByRole("button", { name: "Save", exact: true }).click();
    await expect(worlds.locator(".worlds-status")).toContainText(/Saved/, { timeout: 60_000 });
    const savedTick = await readTick(page);

    await page.reload();
    const start = page.getByTestId("start-screen");
    await expect(start).toBeVisible();
    const row = page.getByTestId("start-world-row").first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("start-load-world").first().click();

    await expect(page.locator(".topbar")).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(async () => readTick(page), { timeout: 90_000 })
      .toBeGreaterThanOrEqual(0);
    const reloadedTick = await readTick(page);
    expect(reloadedTick).toBeGreaterThan(0);
    expect(reloadedTick).toBeLessThanOrEqual(savedTick);
    // Reopened paused: inspect first, play when ready.
    await page.waitForTimeout(1_500);
    expect(await readTick(page)).toBe(reloadedTick);

    expect(consoleErrors(page), "no console or page errors across the flow").toEqual([]);
  });
});
