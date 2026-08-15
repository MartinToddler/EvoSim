import { InterventionKind, SimulationEngine, type CommandInput } from "@eon/engine";
import { describe, expect, it } from "vitest";
import { decodeDurableSnapshot, encodeDurableSnapshot } from "./durableSnapshot";
import { ACCEPTANCE_CONFIG, ACCEPTANCE_SEED, countAlive } from "./testWorlds";

/**
 * Independent release-gate acceptance for Milestone 10 (A19 review).
 *
 * Deliberately NOT a refactor of `acceptance.continuation.test.ts`: a review
 * that reuses the implementation's own harness inherits its blind spots. This
 * file drives the mandated scenario through its own script, and adds the case
 * the shipped tests cannot reach.
 *
 * ## The blind spot this file exists to cover
 *
 * Every save tick in the shipped suite — 2 500, 4 000, 1 500, 800, 300×N, 200,
 * 100 — is a multiple of `time.environmentInterval` (20). Phase 1 therefore
 * runs on the *first tick after every one of those loads*, which would
 * overwrite any environment-derived cache the restore rebuilt differently
 * before anything could read it. A save one tick off that lattice gets no such
 * cover: the restored world senses, feeds and fights on whatever the restore
 * produced. The off-lattice test below is the one that would fail if a derived
 * environment cache ever came back.
 *
 * (It passes today because the plant gradient is computed where it is consumed
 * rather than cached — `plants.ts` — and passability is a pure function of the
 * stored biome. The test pins that property instead of trusting it.)
 */

const TOTAL = 10_000;
const SAVE_AT = 2500;

/** Bytes out, engine gone, bytes in: the only thing that crosses is the file. */
function reloadThroughBytes(engine: SimulationEngine): SimulationEngine {
  const encoded = encodeDurableSnapshot({
    snapshot: engine.serialize(),
    stateHash: engine.computeStateHash(),
    configHash: engine.configHash,
  });
  const stored = new Uint8Array(encoded.slice().buffer);
  const { header, snapshot } = decodeDurableSnapshot(stored);
  const restored = SimulationEngine.fromSnapshot(snapshot);
  expect(restored.computeStateHash()).toBe(header.stateHash);
  expect(restored.tick).toBe(header.tick);
  return restored;
}

interface ScriptedCommand {
  tick: number;
  build: (engine: SimulationEngine) => CommandInput;
}

/**
 * A world that is edited while it lives.
 *
 * Each command is queued one tick before it applies, so a save taken at
 * `SAVE_AT` carries applied history behind the cursor *and* a command pending
 * ahead of it — the meteor is aimed at the save tick itself.
 */
function interventionScript(): ScriptedCommand[] {
  const centre = (engine: SimulationEngine): { x: number; y: number } => {
    const cell = engine.environment.cellSizeLU;
    return {
      x: Math.round((engine.founderRegion.centerGridX + 0.5) * cell),
      y: Math.round((engine.founderRegion.centerGridY + 0.5) * cell),
    };
  };
  return [
    {
      tick: 300,
      build: () => ({
        kind: InterventionKind.SetGlobalTemperature,
        offsetCentiC: -400,
        targetTick: 300,
      }),
    },
    {
      tick: 1200,
      build: (engine) => {
        const { x, y } = centre(engine);
        return {
          kind: InterventionKind.AddBiomass,
          radiusLU: 90,
          strength: 900,
          falloff: 0,
          samplesXLU: [x, x + 60, x - 40],
          samplesYLU: [y, y + 30, y - 50],
          targetTick: 1200,
        };
      },
    },
    {
      // Lands on the save tick: accepted before the snapshot, applied after the
      // reload. This is what a lost command cursor would break.
      tick: SAVE_AT,
      build: (engine) => {
        const { x, y } = centre(engine);
        return {
          kind: InterventionKind.Meteor,
          centerXLU: x + 40,
          centerYLU: y + 40,
          radiusLU: 70,
          targetTick: SAVE_AT,
        };
      },
    },
    {
      tick: 4200,
      build: (engine) => {
        const { x, y } = centre(engine);
        return {
          kind: InterventionKind.PaintMoisture,
          radiusLU: 70,
          strength: 500,
          falloff: 1,
          samplesXLU: [x - 80, x - 20],
          samplesYLU: [y + 80, y + 20],
          targetTick: 4200,
        };
      },
    },
    {
      tick: 6800,
      build: (engine) => {
        const { x, y } = centre(engine);
        return {
          kind: InterventionKind.RaiseTerrain,
          radiusLU: 50,
          strength: 200,
          falloff: 0,
          samplesXLU: [x + 100],
          samplesYLU: [y - 100],
          targetTick: 6800,
        };
      },
    },
    {
      tick: 8500,
      build: () => ({
        kind: InterventionKind.SetGlobalTemperature,
        offsetCentiC: 300,
        targetTick: 8500,
      }),
    },
  ];
}

/**
 * Advance `engine` from `from` to `until`, queueing every scripted command one
 * tick before it applies — the live UI path, not a pre-seeded log.
 */
function runScripted(
  engine: SimulationEngine,
  script: readonly ScriptedCommand[],
  from: number,
  until: number,
): void {
  let tick = from;
  for (const entry of script) {
    if (entry.tick <= from || entry.tick > until) {
      continue;
    }
    const queueAt = entry.tick - 1;
    engine.stepMany(queueAt - tick);
    tick = queueAt;
    const result = engine.queueCommand(entry.build(engine));
    expect(result.accepted, `command for tick ${entry.tick} was rejected`).toBe(true);
  }
  engine.stepMany(until - tick);
}

function freshEngine(): SimulationEngine {
  return new SimulationEngine({ seed: ACCEPTANCE_SEED, config: ACCEPTANCE_CONFIG });
}

describe("M10 gate: a reloaded world has the same future as one that never stopped", () => {
  const script = interventionScript();

  // CONTROL: one uninterrupted run of an edited, populated world.
  const control = freshEngine();
  runScripted(control, script, 0, SAVE_AT);
  const controlAtSave = control.serialize();
  const hashAtSave = control.computeStateHash();
  runScripted(control, script, SAVE_AT, TOTAL);
  const controlHash = control.computeStateHash();

  it("runs a world worth comparing: population, deaths, carrion, lineages, history", () => {
    // A hash comparison between two empty worlds proves nothing. Everything
    // asserted here is state the snapshot has to carry.
    const end = control.serialize();
    expect(countAlive(controlAtSave.organisms.alive)).toBeGreaterThan(0);
    expect(countAlive(end.organisms.alive)).toBeGreaterThan(0);
    expect(end.organisms.totalBirths).toBeGreaterThan(0);
    expect(end.organisms.totalDeaths).toBeGreaterThan(0);
    expect(end.organisms.nextEntityId).toBeGreaterThan(ACCEPTANCE_CONFIG.world.initialOrganisms);
    expect(end.organisms.freeSlots.length).toBeGreaterThan(0);
    expect(end.carcasses.totalCreated).toBeGreaterThan(0);
    expect(end.species.records.length).toBeGreaterThan(0);
    expect(end.history.events.events.length).toBeGreaterThan(0);
    expect(end.history.stats.tiers[0]?.length ?? 0).toBeGreaterThan(0);
    // Every scripted intervention really was accepted and applied.
    expect(end.commands.commands).toHaveLength(script.length);
    expect(end.commands.cursor).toBe(script.length);
    // And the save straddles the cursor: history behind it, a meteor ahead.
    expect(controlAtSave.commands.cursor).toBeGreaterThan(0);
    expect(controlAtSave.commands.cursor).toBeLessThan(controlAtSave.commands.commands.length);
  });

  it(`CONTROL(${TOTAL}) === SAVE(${SAVE_AT}) -> destroy -> LOAD -> CONTINUE(${TOTAL})`, () => {
    let saved: SimulationEngine | null = freshEngine();
    runScripted(saved, script, 0, SAVE_AT);
    expect(saved.computeStateHash()).toBe(hashAtSave);

    const continued = reloadThroughBytes(saved);
    // Drop the pre-save runtime: nothing but the decoded bytes may continue.
    saved = null;
    expect(saved).toBeNull();

    runScripted(continued, script, SAVE_AT, TOTAL);

    expect(continued.tick).toBe(TOTAL);
    expect(continued.computeStateHash()).toBe(controlHash);
  });

  it("continues identically from a save that is off the phase lattice", () => {
    // 2 503 is a multiple of none of the tick intervals (environment 20,
    // carcass decay 20, statistics 100, species analysis 400), so the tick
    // after the load runs no scheduled phase that could paper over a
    // mis-restored derived cache.
    const OFF_LATTICE = 2503;
    const HORIZON = 4200;
    expect(OFF_LATTICE % ACCEPTANCE_CONFIG.time.environmentInterval).not.toBe(0);
    expect(OFF_LATTICE % ACCEPTANCE_CONFIG.time.carcassDecayInterval).not.toBe(0);
    expect(OFF_LATTICE % ACCEPTANCE_CONFIG.time.statisticsInterval).not.toBe(0);
    expect(OFF_LATTICE % ACCEPTANCE_CONFIG.time.speciesAnalysisInterval).not.toBe(0);

    const reference = freshEngine();
    runScripted(reference, script, 0, OFF_LATTICE);
    const offLatticeHash = reference.computeStateHash();
    runScripted(reference, script, OFF_LATTICE, HORIZON);
    const referenceHash = reference.computeStateHash();

    const source = freshEngine();
    runScripted(source, script, 0, OFF_LATTICE);
    const continued = reloadThroughBytes(source);
    expect(continued.computeStateHash()).toBe(offLatticeHash);

    runScripted(continued, script, OFF_LATTICE, HORIZON);
    expect(continued.computeStateHash()).toBe(referenceHash);
  });

  it("restores the derived history the canonical hash does not cover", () => {
    // Statistics are serialized but deliberately unhashed (`hashState.ts`), so
    // the hash comparisons above would not notice a broken statistics restore —
    // the charts would simply be wrong after every load. Compared explicitly.
    const mature = freshEngine();
    runScripted(mature, script, 0, 1200);
    const before = mature.serialize().history.stats;
    const after = reloadThroughBytes(mature).serialize().history.stats;
    expect(after).toEqual(before);
    expect(after.tiers[0]?.length ?? 0).toBeGreaterThan(0);
    expect(after.speciesSeries.length).toBeGreaterThan(0);
  });
});
