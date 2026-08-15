import { DEFAULT_CONFIG, InterventionKind, SimulationEngine } from "@eon/engine";
import { describe, expect, it } from "vitest";
import { decodeDurableSnapshot, encodeDurableSnapshot } from "./durableSnapshot";
import { ACCEPTANCE_CONFIG, ACCEPTANCE_SEED, countAlive } from "./testWorlds";

/**
 * Continuation across a save, on the cases the mandated 10 000-tick run in
 * `acceptance.continuation.test.ts` cannot cover cheaply:
 *
 * - the **reference world** (`DEFAULT_CONFIG` at full size), on a shorter
 *   horizon, so the acceptance world's smaller map is never the only geometry
 *   the format is proven against;
 * - a world with **player commands** in its history and pending across the
 *   save, which is what the persisted command cursor is for;
 * - **repeated** save/load cycles, because a single round trip can hide state
 *   that is merely carried rather than truly restored.
 */

/** Encode, discard the engine, decode: nothing but bytes crosses the gap. */
function throughDurableBytes(engine: SimulationEngine): SimulationEngine {
  const encoded = encodeDurableSnapshot({
    snapshot: engine.serialize(),
    stateHash: engine.computeStateHash(),
    configHash: engine.configHash,
  });
  const stored = new Uint8Array(encoded.slice().buffer);
  const { header, snapshot } = decodeDurableSnapshot(stored);
  const restored = SimulationEngine.fromSnapshot(snapshot);
  expect(restored.computeStateHash()).toBe(header.stateHash);
  return restored;
}

describe("the reference world continues identically across a save", () => {
  // DEFAULT_CONFIG at full size is expensive per tick once its population
  // climbs, so this horizon is short by design; the long run lives in
  // `acceptance.continuation.test.ts`.
  const SAVE_AT = 800;
  const TOTAL = 2400;

  it(`matches an uninterrupted run to tick ${TOTAL}`, () => {
    const control = new SimulationEngine({ seed: ACCEPTANCE_SEED, config: DEFAULT_CONFIG });
    control.stepMany(TOTAL);

    const saved = new SimulationEngine({ seed: ACCEPTANCE_SEED, config: DEFAULT_CONFIG });
    saved.stepMany(SAVE_AT);
    const continued = throughDurableBytes(saved);
    continued.stepMany(TOTAL - SAVE_AT);

    expect(countAlive(continued.serialize().organisms.alive)).toBeGreaterThan(0);
    expect(continued.computeStateHash()).toBe(control.computeStateHash());
  });
});

describe("a world with an intervention history continues identically", () => {
  const SAVE_AT = 1500;
  const TOTAL = 3000;

  /**
   * Queue the world's commands. Two are applied before the save, one targets
   * the save tick itself and one lands after it — so the snapshot is taken
   * with applied history *behind* the cursor and a pending command *ahead* of
   * it, which is the pair the cursor exists to keep straight.
   */
  function queueCommands(engine: SimulationEngine): void {
    const cell = engine.environment.cellSizeLU;
    const centreX = Math.round((engine.founderRegion.centerGridX + 0.5) * cell);
    const centreY = Math.round((engine.founderRegion.centerGridY + 0.5) * cell);

    expect(
      engine.queueCommand({
        kind: InterventionKind.SetGlobalTemperature,
        offsetCentiC: 350,
        targetTick: 400,
      }).accepted,
    ).toBe(true);
    expect(
      engine.queueCommand({
        kind: InterventionKind.AddBiomass,
        radiusLU: 60,
        strength: 400,
        falloff: 0,
        samplesXLU: [centreX, centreX + 40],
        samplesYLU: [centreY, centreY + 20],
        targetTick: 900,
      }).accepted,
    ).toBe(true);
    expect(
      engine.queueCommand({
        kind: InterventionKind.Meteor,
        centerXLU: centreX,
        centerYLU: centreY,
        radiusLU: 50,
        targetTick: SAVE_AT,
      }).accepted,
    ).toBe(true);
    expect(
      engine.queueCommand({
        kind: InterventionKind.RaiseTerrain,
        radiusLU: 40,
        strength: 200,
        falloff: 0,
        samplesXLU: [centreX + 10],
        samplesYLU: [centreY + 10],
        targetTick: 2200,
      }).accepted,
    ).toBe(true);
  }

  it(`matches an uninterrupted run to tick ${TOTAL}`, () => {
    const control = new SimulationEngine({ seed: ACCEPTANCE_SEED, config: ACCEPTANCE_CONFIG });
    queueCommands(control);
    control.stepMany(TOTAL);

    const saved = new SimulationEngine({ seed: ACCEPTANCE_SEED, config: ACCEPTANCE_CONFIG });
    queueCommands(saved);
    saved.stepMany(SAVE_AT);

    const snapshot = saved.serialize();
    // The save really does straddle the cursor: history behind, work ahead.
    expect(snapshot.commands.commands.length).toBe(4);
    expect(snapshot.commands.cursor).toBeGreaterThan(0);
    expect(snapshot.commands.cursor).toBeLessThan(snapshot.commands.commands.length);

    const continued = throughDurableBytes(saved);
    // The restored log is the same log, cursor included.
    const restoredCommands = continued.serialize().commands;
    expect(restoredCommands.cursor).toBe(snapshot.commands.cursor);
    expect(restoredCommands.commands.map((command) => command.id)).toEqual(
      snapshot.commands.commands.map((command) => command.id),
    );

    continued.stepMany(TOTAL - SAVE_AT);

    expect(continued.serialize().commands.cursor).toBe(4);
    expect(continued.computeStateHash()).toBe(control.computeStateHash());
  });

  it("still applies a command that was pending when the world was saved", () => {
    // The sharp case on its own: save one tick before a command's target, and
    // the reload must apply it exactly once.
    const control = new SimulationEngine({ seed: ACCEPTANCE_SEED, config: ACCEPTANCE_CONFIG });
    control.stepMany(200);
    expect(
      control.queueCommand({
        kind: InterventionKind.SetGlobalTemperature,
        offsetCentiC: 900,
        targetTick: 300,
      }).accepted,
    ).toBe(true);

    const saved = throughDurableBytes(control);
    expect(saved.environment.globalTemperatureOffsetCentiC).toBe(0);

    saved.stepMany(101);
    control.stepMany(101);

    expect(saved.environment.globalTemperatureOffsetCentiC).toBe(900);
    expect(saved.computeStateHash()).toBe(control.computeStateHash());
  });
});

describe("repeated save/load cycles", () => {
  it("stay identical to an uninterrupted run", () => {
    const CYCLES = 8;
    const PER_CYCLE = 300;

    const control = new SimulationEngine({ seed: ACCEPTANCE_SEED, config: ACCEPTANCE_CONFIG });
    control.stepMany(CYCLES * PER_CYCLE);

    let engine = new SimulationEngine({ seed: ACCEPTANCE_SEED, config: ACCEPTANCE_CONFIG });
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      engine.stepMany(PER_CYCLE);
      engine = throughDurableBytes(engine);
    }

    expect(engine.tick).toBe(CYCLES * PER_CYCLE);
    expect(engine.computeStateHash()).toBe(control.computeStateHash());
  });
});
