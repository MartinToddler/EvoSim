import { expect, test } from "@playwright/test";
import { openWorld, readPopulation, readTick, topBarButton } from "./support";

/**
 * Render and tick performance measurement in a real browser (task L04,
 * docs/07 §§7-10).
 *
 * docs/07 §10 puts "profile" first in the optimization order and CLAUDE.md says
 * to optimize measured hotspots only. Node benchmarks (`pnpm benchmark:engine`)
 * measure the engine; only a browser can measure the renderer, the transport and
 * the two of them competing. This test is that measurement.
 *
 * ## It records; it does not enforce
 *
 * docs/07 §8 forbids enforcing an arbitrary wall clock on unknown hardware, so
 * every number below is attached to the test report rather than asserted. What
 * IS asserted is structural and hardware-independent: the profile exists, the
 * transport is not silently collapsing, and the pooled buffers stay bounded.
 * A CI machine that is merely slow must not turn this red.
 */

/** Read one `dt`/`dd` pair out of the HUD by its term. */
async function hudValue(
  page: import("@playwright/test").Page,
  section: string,
  term: string,
): Promise<string> {
  return page
    .locator(".perf-section", { has: page.locator("h3", { hasText: section }) })
    .locator("div", { has: page.locator("dt", { hasText: term }) })
    .locator("dd")
    .first()
    .innerText();
}

test.describe("performance pass", () => {
  test("records the tick profile, render cost and memory at MAX", async ({ page }, testInfo) => {
    await openWorld(page);
    await topBarButton(page, "Toggle the environment grid overlay").click();
    const hud = page.locator(".perf-panel");
    await expect(hud).toBeVisible();

    // MAX is the interesting operating point: the Worker runs unpaced, the
    // render stream is throttled against it, and the population climbs — which
    // is exactly where docs/07 §8's budgets are supposed to bite.
    await page.locator(".topbar button[aria-pressed]", { hasText: "MAX" }).first().click();

    // Give the world real work to do. Population, not wall time, is the
    // condition — a slow machine should measure the same world, more slowly.
    await expect.poll(async () => readPopulation(page), { timeout: 110_000 }).toBeGreaterThan(500);

    await expect(hud.locator(".perf-phases li").first()).toBeVisible({ timeout: 30_000 });

    const phases = await hud.locator(".perf-phases li").allInnerTexts();
    const memory = await hud.locator(".perf-memory li").allInnerTexts();
    const headline = await hud.locator(".perf-headline").first().innerText();
    const fps = await hudValue(page, "Render", "Frame rate");
    const drawn = await hudValue(page, "Render", "Organisms drawn");
    const detailed = await hudValue(page, "Render", "With detail");
    const inFlight = await hudValue(page, "Render", "Buffers in flight");
    const dropped = await hudValue(page, "Render", "Snapshots dropped");
    const achieved = await hudValue(page, "Tick", "Achieved");

    const report = [
      `tick:        ${headline.replace(/\s+/g, " ")}`,
      `achieved:    ${achieved}`,
      `population:  ${await readPopulation(page)} at tick ${await readTick(page)}`,
      `render:      ${fps}, ${drawn} drawn, ${detailed} detailed`,
      `transport:   ${inFlight} in flight, ${dropped} dropped`,
      "phases:",
      ...phases.map((line) => `  ${line.replace(/\s+/g, " ")}`),
      "memory:",
      ...memory.map((line) => `  ${line.replace(/\s+/g, " ")}`),
    ].join("\n");
    await testInfo.attach("performance", { body: report, contentType: "text/plain" });
    console.log(`\n[L04 render performance pass — ${testInfo.project.name}]\n${report}\n`);

    // Structural assertions only.
    expect(phases.length, "the tick profile must name at least a few phases").toBeGreaterThan(3);
    expect(memory.length, "the memory report must name its categories").toBeGreaterThan(3);
    // Back-pressure is correct behaviour, but the pool must not have leaked:
    // buffers in flight are bounded by the pool size, which is single digits.
    expect(Number.parseInt(inFlight, 10)).toBeLessThanOrEqual(8);
  });
});
