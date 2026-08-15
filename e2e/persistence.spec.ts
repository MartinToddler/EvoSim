import { expect, test } from "@playwright/test";
import { openWorld, pressPlay, readTick, topBarButton, waitForTicks } from "./support";

/**
 * docs/07 PART E scenarios 6, 8 and 9: save/reload, rewind and branch
 * (task L08; corrected by ADR 0025).
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

  test("8. dragging selects; View this time rewinds; Return to present restores", async ({
    page,
  }) => {
    await openWorld(page);
    // The tick-0 baseline from Create World already makes history explorable;
    // add a later save so the reconstruction genuinely replays forward.
    await waitForTicks(page, 40);
    await topBarButton(page, "Save this world, or load one you saved earlier").click();
    const worlds = page.locator(".worlds-panel");
    await worlds.getByRole("button", { name: "Save", exact: true }).click();
    await expect(worlds.locator(".worlds-status")).toContainText(/Saved/, { timeout: 60_000 });

    await waitForTicks(page, 40);
    const history = page.locator(".history-panel");
    await expect(history).toBeVisible();

    // Selecting a time must NOT start anything: no pointer release launches a
    // replay (docs/06 §13). The scrubber click lands mid-track.
    const scrubber = history.getByTestId("history-scrubber");
    await expect(scrubber).toBeEnabled({ timeout: 30_000 });
    await scrubber.click();
    await page.waitForTimeout(1_000);
    await expect(history.locator(".history-panel__badge--live")).toContainText("Live");

    // The selection is visible, and the explicit action is what rewinds.
    const chosen = await history.getByTestId("history-position").innerText();
    const presentBefore = await readTick(page);
    await history.getByTestId("view-this-time").click();

    await expect(history.locator(".history-panel__badge")).toContainText(/Historical preview/, {
      timeout: 90_000,
    });
    // The preview is read-only and names both ticks; the previewed tick is the
    // selected one.
    await expect(history).toContainText("interventions are disabled");
    await expect(history.getByTestId("history-position")).toHaveText(chosen);

    // Return to present restores the exact live tick, still paused.
    await history.getByTestId("return-to-present").click();
    await expect(history.locator(".history-panel__badge--live")).toContainText("Live", {
      timeout: 60_000,
    });
    await expect
      .poll(async () => readTick(page), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(presentBefore);
    expect(await readTick(page)).toBe(presentBefore);
  });

  test("9. Branch From Here opens the branch, paused at the branch tick; the parent is untouched", async ({
    page,
  }) => {
    await openWorld(page);
    await waitForTicks(page, 30);

    // Name the parent so the lineage note is checkable, and save a checkpoint.
    await topBarButton(page, "Save this world, or load one you saved earlier").click();
    const worlds = page.locator(".worlds-panel");
    await worlds.getByLabel("World name").fill("Parent");
    await worlds.getByRole("button", { name: "Save", exact: true }).click();
    await expect(worlds.locator(".world-row", { hasText: "Parent" })).toBeVisible({
      timeout: 60_000,
    });

    await waitForTicks(page, 30);

    // Rewind to a checkpoint tick (the chips select exactly a saved tick).
    const history = page.locator(".history-panel");
    await expect(history.getByTestId("history-save-ticks")).toBeVisible();
    await history.locator(".history-panel__save-chip").last().click();
    await history.getByTestId("view-this-time").click();
    await expect(history.locator(".history-panel__badge")).toContainText(/Historical preview/, {
      timeout: 90_000,
    });
    const previewedTick = await history.getByTestId("history-position").innerText();
    const parentRow = worlds.locator(".world-row", { hasText: "Parent" });
    const parentHashBefore = await parentRow
      .locator("span[title='Canonical state hash at the saved tick']")
      .innerText();

    // Branch. The branch becomes the OPEN world automatically (ADR 0025).
    await history.getByTestId("branch-name").fill("Alt Reality");
    await history.getByTestId("create-branch").click();

    await expect(page.getByTestId("branch-opened-notice")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("branch-opened-notice")).toContainText("Alt Reality");
    await expect(page.getByTestId("branch-opened-notice")).toContainText("Parent");

    // Now inside the branch: live (not previewing), paused, at the branch tick.
    await expect(history.locator(".history-panel__badge--live")).toContainText("Live", {
      timeout: 60_000,
    });
    await expect(page.locator(".topbar")).toContainText("Paused");
    await expect
      .poll(async () => readTick(page), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(0);
    expect(`tick ${(await readTick(page)).toLocaleString("en-US")}`).toBe(previewedTick);

    // The Worlds panel says where we are, with lineage.
    await expect(page.getByTestId("branch-note")).toContainText("branch of");
    const branchRow = worlds.locator(".world-row", { hasText: "Alt Reality" });
    await expect(branchRow).toContainText("• open");
    await expect(branchRow).toContainText(/branched from\s+Parent/);

    // Press Play: the branch grows its own history…
    await pressPlay(page);
    await waitForTicks(page, 20);

    // …while the parent is exactly what it was: same newest save, same hash.
    await expect(parentRow).not.toContainText("• open");
    const parentHashAfter = await parentRow
      .locator("span[title='Canonical state hash at the saved tick']")
      .innerText();
    expect(parentHashAfter).toBe(parentHashBefore);

    // Switching back to the parent reopens it at its own saved tick.
    await parentRow.getByRole("button", { name: "Load" }).click();
    await expect(page.getByTestId("branch-note")).toHaveCount(0, { timeout: 60_000 });
    await expect(worlds.locator(".world-row", { hasText: "Parent" })).toContainText("• open");
  });
});
