import { expect, test } from "@playwright/test";
import {
  FIXTURE_SEED_HEX,
  canvas,
  consoleErrors,
  openWorld,
  readPopulation,
  readTick,
  selectAnyOrganism,
  topBarButton,
  waitForTicks,
} from "./support";

/**
 * docs/07 PART E scenarios 1-5 and 7: world creation, time control, selection,
 * intervention and the species tree (task L08).
 *
 * These run in series against one page per test. Each starts a fresh world
 * rather than sharing one, because a shared world would make every test depend
 * on the order the others ran in — and this app's whole point is that history
 * matters.
 */

test.describe("EON browser flows", () => {
  test("1. creates a world from an explicit seed and runs it", async ({ page }) => {
    await openWorld(page);

    // The seed in the URL is the seed the app opened, and it says so.
    await expect(page.locator(".seed-button").first()).toHaveText(
      new RegExp(FIXTURE_SEED_HEX.replace("0x", "0x")),
    );
    await expect(canvas(page)).toBeVisible();

    // A world with a canvas but no organisms would render an empty ocean.
    expect(await readPopulation(page)).toBeGreaterThan(0);
    expect(consoleErrors(page), "no console or page errors during startup").toEqual([]);
  });

  test("2. pauses and resumes", async ({ page }) => {
    await openWorld(page);

    await topBarButton(page, "Pause the simulation").click();
    // Give the Worker a moment to finish the tick it was in, then confirm the
    // counter has genuinely stopped rather than merely slowed.
    await page.waitForTimeout(1_500);
    const paused = await readTick(page);
    await page.waitForTimeout(1_500);
    expect(await readTick(page)).toBe(paused);

    await topBarButton(page, "Run the simulation").click();
    await expect.poll(async () => readTick(page), { timeout: 30_000 }).toBeGreaterThan(paused);
  });

  test("3. changes speed and the achieved rate follows", async ({ page }) => {
    await openWorld(page);

    await page.locator(".topbar button[aria-pressed]", { hasText: "1×" }).first().click();
    await waitForTicks(page, 5);
    const afterSlow = await readTick(page);

    // 20x should cover far more ground in the same wall time. The assertion is
    // deliberately weak — "more ticks than before" — because docs/07 §8 forbids
    // asserting a wall-clock rate on unknown hardware.
    await page.locator(".topbar button[aria-pressed]", { hasText: "20×" }).first().click();
    const before20 = await readTick(page);
    await page.waitForTimeout(3_000);
    const after20 = await readTick(page);
    expect(after20 - before20).toBeGreaterThan(afterSlow > 0 ? 5 : 1);
  });

  test("4. selects an organism and shows its inspector detail", async ({ page }) => {
    // A sweep of a few hundred points, each costing a hit test and a React
    // render. It is bounded work, not a wait, so it gets its own budget rather
    // than the suite's default.
    test.setTimeout(300_000);
    await openWorld(page);
    // Let the founders spread out first: at tick 0 they are 256 bodies in one
    // small region, and a sweep of the whole world would mostly miss them.
    await page.locator(".topbar button[aria-pressed]", { hasText: "MAX" }).first().click();
    await expect.poll(async () => readPopulation(page), { timeout: 90_000 }).toBeGreaterThan(800);
    // Pausing stops the target moving between the click and the query.
    await topBarButton(page, "Pause the simulation").click();
    await page.waitForTimeout(1_000);

    const selected = await selectAnyOrganism(page);
    expect(selected, "a click somewhere on the canvas should select an organism").toBe(true);

    const inspector = page.locator(".inspector");
    await expect(inspector.locator("h2")).toContainText(/Organism #\d+/);
    // Authoritative detail actually arrived, rather than the header alone.
    await expect(inspector).toContainText(/Energy|Health|Diet/);
  });

  test("5. an intervention appears in the world history", async ({ page }) => {
    await openWorld(page);

    await topBarButton(page, "Intervention tools: climate, ecology, terrain, catastrophe").click();
    const tools = page.locator(".tools-panel");
    await expect(tools).toBeVisible();

    // The global temperature offset is the one tool that needs no canvas
    // gesture, so it is the one that can be driven reliably from a test.
    await tools.getByRole("button", { name: /Apply global offset/ }).click();

    await topBarButton(page, "World history: splits, extinctions, booms, crashes").click();
    const timeline = page.locator(".timeline-panel");
    await expect(timeline).toBeVisible();
    await expect(timeline).toContainText(/temperature|Temperature|Intervention/, {
      timeout: 30_000,
    });
  });

  test("7. opens the species panel and the Tree of Life", async ({ page }) => {
    await openWorld(page);

    await topBarButton(page, "Living species and the species inspector").click();
    await expect(page.locator(".species-panel")).toBeVisible();
    // Every world starts as one species (docs/05 §5), so there is always a row.
    await expect(page.locator(".species-panel")).toContainText(/Species 1|1\b/);

    await topBarButton(page, "Tree of Life: every lineage, split and extinction").click();
    await expect(page.locator(".tree-panel")).toBeVisible();
  });

  test("shows the performance HUD with live phase timings", async ({ page }) => {
    await openWorld(page);
    await topBarButton(page, "Toggle the environment grid overlay").click();

    const hud = page.locator(".perf-panel");
    await expect(hud).toBeVisible();
    // The profile is real: at least one named phase reports a cost, and the
    // memory block reports the engine's own accounting.
    await expect(hud.locator(".perf-phases li").first()).toBeVisible({ timeout: 30_000 });
    await expect(hud).toContainText(/MiB|KiB/);
  });
});
