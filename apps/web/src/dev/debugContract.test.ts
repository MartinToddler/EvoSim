import { BIOME_COUNT, BIOME_NAMES, Q } from "@eon/engine";
import { DEBUG_BIOME_COLORS, DEBUG_BIOME_COUNT, DEBUG_BIOME_NAMES, Q_SCALE } from "@eon/renderer";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the constants `@eon/renderer/debug` deliberately duplicates.
 *
 * The debug painter keeps its own copy of the biome enum and of the Q scale so the
 * renderer package needs no dependency on `@eon/engine` (docs/02 §4). A copy is
 * only acceptable if divergence is loud, and `apps/web` is the one place that
 * legitimately sees both — so the comparison lives here.
 */
describe("renderer debug constants match the engine", () => {
  it("uses the same fixed-point scale", () => {
    expect(Q_SCALE).toBe(Q);
  });

  it("covers exactly the engine's biome classes", () => {
    expect(DEBUG_BIOME_COUNT).toBe(BIOME_COUNT);
    expect(DEBUG_BIOME_NAMES).toEqual(BIOME_NAMES);
    expect(DEBUG_BIOME_COLORS).toHaveLength(BIOME_COUNT);
  });

  it("gives every biome a distinct colour", () => {
    const encoded = DEBUG_BIOME_COLORS.map((color) => `${color.r},${color.g},${color.b}`);
    expect(new Set(encoded).size).toBe(BIOME_COUNT);
  });
});
