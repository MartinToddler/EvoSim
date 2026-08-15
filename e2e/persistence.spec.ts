import { expect, test } from "@playwright/test";
import { openWorld, readTick, topBarButton, waitForTicks } from "./support";

/**
 * docs/07 PART E scenarios 6, 8 and 9: save/reload, rewind and branch
 * (task L08).
 *
 * These are the flows that cross every boundary the project has — engine,
 * protocol, Worker, IndexedDB and back — so they are the ones a browser test
 * earns its keep on. What is asserted is that the flow COMPLETES and that the
 * app tells the truth about it; whether a restored world computes the same hash
 * is proven exactly in Node by the persistence and rewind suites, and repeating
 * that claim through a browser would only add flake.
 */

test.describe("persistence, rewind and branching", () => {
  test("6. saves a world and loads it back", async ({ page }) => {
    await openWorld(page);
    await waitForTicks(page, 20);

    await topBarButton(page, "Save this world, or load one you saved earlier").click();
    const worlds = page.locator(".worlds-panel");
    await expect(worlds).toBeVisible();

    await worlds.getByLabel("World name").fill("e2e save");
    await worlds.getByRole("button", { name: "Save", exact: true }).click();

    const row = worlds.locator(".world-row", { hasText: "e2e save" });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText(/tick \d/);

    // Let the world run past the saved tick, then load it back and confirm the
    // app returns to an earlier tick rather than pretending.
    await waitForTicks(page, 50);
    const beforeLoad = await readTick(page);

    await row.getByRole("button", { name: "Load" }).click();
    await expect
      .poll(async () => readTick(page), {
        timeout: 60_000,
        message: "loading a save should return the world to the saved tick",
      })
      .toBeLessThan(beforeLoad);
  });

  test("8+9. rewinds to an earlier tick and branches from it", async ({ page }) => {
    await openWorld(page);
    await waitForTicks(page, 20);

    // Rewind needs a save at or before the target tick (ADR 0018 §7).
    await topBarButton(page, "Save this world, or load one you saved earlier").click();
    const worlds = page.locator(".worlds-panel");
    await worlds.getByLabel("World name").fill("e2e rewind");
    await worlds.getByRole("button", { name: "Save", exact: true }).click();
    await expect(worlds.locator(".world-row", { hasText: "e2e rewind" })).toBeVisible({
      timeout: 60_000,
    });
    const savedTick = await readTick(page);

    await waitForTicks(page, 60);

    await topBarButton(page, "World history: splits, extinctions, booms, crashes").click();
    const history = page.locator(".history-panel");
    await expect(history).toBeVisible();

    // The scrubber commits on POINTER UP, not on change — a drag must not fire a
    // reconstruction per pixel. So the rewind is a real click on the track,
    // which lands the handle mid-history: past the save, so the reconstruction
    // genuinely has to replay forward from it.
    const scrubber = history.getByTestId("history-scrubber");
    await expect(scrubber).toBeEnabled({ timeout: 30_000 });
    expect(savedTick).toBeGreaterThan(0);
    await scrubber.click();

    await expect(history.locator(".history-panel__badge")).toContainText(/Historical preview/, {
      timeout: 90_000,
    });
    await expect(history.getByTestId("return-to-present")).toBeEnabled();

    // 9. Branch from the previewed tick. The branch is WRITTEN, not opened: the
    // preview deliberately stays on screen so the branch point is still visible,
    // and the worlds list is where a world gets opened. So the observable is a
    // new stored world, not a switch.
    const branchTick = await history.getByTestId("history-position").innerText();
    await history.getByTestId("create-branch").click();

    await expect(worlds.locator(".world-row", { hasText: /^Branch at/ })).toBeVisible({
      timeout: 90_000,
    });
    // The original is untouched and still previewing the same tick.
    await expect(history.getByTestId("history-position")).toHaveText(branchTick);
  });
});
