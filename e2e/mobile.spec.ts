import { expect, test } from "@playwright/test";
import { canvas, openWorld, pageScrollY, readTick, topBarButton } from "./support";

/**
 * docs/07 PART E scenario 10: mobile viewport pan/zoom/sheets (tasks L08/M02).
 *
 * Runs on a phone-sized viewport with touch enabled. What it checks is layout
 * and interaction, never biology: docs/02 §20 forbids changing authoritative
 * ecology by device class, so a phone runs the same engine and this file must
 * not assert anything a desktop run would not also see.
 *
 * The one-sheet rule (docs/06 §16, "only one major sheet at once") is the
 * property most likely to break silently, and the Milestone 7 review found a
 * real defect against it, so it is asserted directly.
 */

test.describe("mobile viewport", () => {
  test("10. pans, zooms and honours the one-sheet rule", async ({ page }) => {
    await openWorld(page);

    const view = canvas(page);
    await expect(view).toBeVisible();
    const box = await view.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;

    // A drag pans. There is no camera read-out to assert against, so the check
    // is that a touch drag reaches the canvas and the world keeps running —
    // the failure mode this guards is the gesture scrolling the PAGE instead.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 4, box.y + box.height / 3, { steps: 8 });
    await page.mouse.up();
    expect(await pageScrollY(page)).toBe(0);

    // Wheel zoom, which the renderer handles with preventDefault for the same
    // reason: the page must not scroll under the gesture.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
    expect(await pageScrollY(page)).toBe(0);

    // The world is still running after the gestures.
    const tick = await readTick(page);
    await expect.poll(async () => readTick(page), { timeout: 30_000 }).toBeGreaterThan(tick);

    // One sheet at a time: opening a second must close the first.
    await topBarButton(page, "Global statistics and charts").click();
    await expect(page.locator(".stats-panel")).toBeVisible();

    await topBarButton(page, "World layers: biomes, climate, fertility, plants, density").click();
    await expect(page.locator(".layers-panel")).toBeVisible();
    await expect(page.locator(".stats-panel")).toHaveCount(0);
  });

  test("keeps the world visible behind an open sheet", async ({ page }) => {
    await openWorld(page);
    await topBarButton(page, "Global statistics and charts").click();
    await expect(page.locator(".stats-panel")).toBeVisible();
    // docs/06 §16: "world remains visible" — the sheet is a partial-height
    // overlay, never a full-screen route.
    await expect(canvas(page)).toBeVisible();
    const sheet = await page.locator(".stats-panel").boundingBox();
    const viewport = page.viewportSize();
    expect(sheet).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (sheet === null || viewport === null) return;
    expect(sheet.height).toBeLessThan(viewport.height * 0.75);
  });
});
