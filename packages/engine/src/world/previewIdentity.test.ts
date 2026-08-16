import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { SimulationEngine } from "../SimulationEngine";
import { hashEnvironment } from "./hashEnvironment";

/**
 * Preview identity (ADR 0025, the New World flow).
 *
 * The New World screen constructs an engine on the main thread to PREVIEW the
 * map; Create World asks the Worker to construct the authoritative engine from
 * the same seed and config. The product invariant is that the accepted preview
 * IS the world the simulation runs — same environment, same founder placement,
 * same canonical tick-0 state — which is exactly the determinism contract
 * applied at world birth: a world is a pure function of (seed, config, engine).
 *
 * These tests are the Node half of the invariant; the browser E2E half checks
 * the digest shown on the New World screen against the digest the Worker
 * reports for the world it created.
 */

const SEEDS = [0xe0a12026, 0xe0a13f15, 0x00000007];

describe("preview identity (ADR 0025)", () => {
  it("two independent constructions of the same seed are the same world at tick 0", () => {
    for (const seed of SEEDS) {
      const preview = new SimulationEngine({ seed, config: DEFAULT_CONFIG });
      const authoritative = new SimulationEngine({ seed, config: DEFAULT_CONFIG });

      expect(hashEnvironment(authoritative.environment)).toBe(hashEnvironment(preview.environment));
      expect(authoritative.computeStateHash()).toBe(preview.computeStateHash());
      expect(authoritative.tick).toBe(0);
      expect(preview.tick).toBe(0);
      expect(authoritative.founderRegion.centerCellIndex).toBe(
        preview.founderRegion.centerCellIndex,
      );
      expect(authoritative.generationAttempt).toBe(preview.generationAttempt);
    }
  });

  it("different seeds produce different maps (the digest actually discriminates)", () => {
    const a = new SimulationEngine({ seed: SEEDS[0] as number, config: DEFAULT_CONFIG });
    const b = new SimulationEngine({ seed: SEEDS[1] as number, config: DEFAULT_CONFIG });
    expect(hashEnvironment(a.environment)).not.toBe(hashEnvironment(b.environment));
  });
});
