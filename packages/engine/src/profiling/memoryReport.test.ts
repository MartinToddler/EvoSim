import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
import { cloneConfig, type ReadonlySimulationConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { BRAIN_WEIGHT_COUNT } from "../brain/BrainLayout";
import { GENE_COUNT } from "../genetics/genes";
import { DEATH_CAUSE_COUNT } from "../organisms/death";
import { InterventionKind } from "../commands/SimulationCommand";
import { estimateEngineMemory, formatBytes } from "./memoryReport";

/**
 * Memory diagnostics (task L03, docs/07 §11).
 *
 * The tests that matter here are the ones about what a diagnostic must never
 * do — change a hash, cost a tick anything, or quietly stop counting a category
 * that grew. Byte totals themselves are asserted only where they are exact
 * (typed arrays) or bounded (they must scale with the thing they measure).
 */

const SMALL_WORLD: ReadonlySimulationConfig = (() => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = 64;
  config.world.sizeLU = 64 * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = 8;
  config.world.initialOrganisms = 16;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = Math.floor((64 * 64) / 8);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 16,
  );
  config.limits.maxOrganisms = 512;
  config.limits.maxCarcasses = 256;
  return config;
})();

function smallEngine(seed = 0x51ab1e): SimulationEngine {
  return new SimulationEngine({ seed, config: SMALL_WORLD });
}

describe("estimateEngineMemory (task L03)", () => {
  it("cannot change authoritative state", () => {
    const measured = smallEngine();
    const control = smallEngine();

    for (let tick = 0; tick < 60; tick += 1) {
      measured.step();
      control.step();
      estimateEngineMemory(measured);
    }

    expect(measured.computeStateHash()).toBe(control.computeStateHash());
  });

  it("reports gene and brain storage exactly", () => {
    const engine = smallEngine();
    const { bytes } = estimateEngineMemory(engine);
    const capacity = SMALL_WORLD.limits.maxOrganisms;

    // Uint16 genes, Int16 brain weights — both two bytes per element.
    expect(bytes.genes).toBe(capacity * GENE_COUNT * 2);
    expect(bytes.brains).toBe(capacity * BRAIN_WEIGHT_COUNT * 2);
  });

  it("scales the environment with the grid, not with the population", () => {
    const engine = smallEngine();
    const before = estimateEngineMemory(engine);
    engine.stepMany(200);
    const after = estimateEngineMemory(engine);

    expect(after.bytes.environment).toBe(before.bytes.environment);
    // The grid is 64x64 cells; every column is 1 or 2 bytes per cell, so the
    // total must be within an order of magnitude of cellCount * 16.
    expect(before.bytes.environment).toBeGreaterThan(64 * 64);
    expect(before.bytes.environment).toBeLessThan(64 * 64 * 32);
  });

  it("counts every category into the total", () => {
    const engine = smallEngine();
    engine.stepMany(120);
    const { bytes } = estimateEngineMemory(engine);

    const summed =
      bytes.organismState +
      bytes.genes +
      bytes.brains +
      bytes.phenotypes +
      bytes.environment +
      bytes.carcasses +
      bytes.spatialIndex +
      bytes.scratch +
      bytes.species +
      bytes.events +
      bytes.statistics +
      bytes.commands;
    expect(bytes.total).toBe(summed);
    for (const [name, value] of Object.entries(bytes)) {
      expect(value, `${name} must be a non-negative finite byte count`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("grows the command category when commands are logged", () => {
    const engine = smallEngine();
    const before = estimateEngineMemory(engine).bytes.commands;

    const result = engine.queueCommand({
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: 100,
    });
    expect(result.accepted).toBe(true);

    const after = estimateEngineMemory(engine);
    expect(after.bytes.commands).toBeGreaterThan(before);
    expect(after.context.commandCount).toBe(1);
  });

  it("reports occupancy alongside capacity", () => {
    const engine = smallEngine();
    engine.stepMany(50);
    const { context } = estimateEngineMemory(engine);

    expect(context.organismCapacity).toBe(SMALL_WORLD.limits.maxOrganisms);
    expect(context.carcassCapacity).toBe(SMALL_WORLD.limits.maxCarcasses);
    expect(context.environmentCells).toBe(64 * 64);
    expect(context.liveOrganisms).toBeGreaterThan(0);
    expect(context.liveOrganisms).toBeLessThanOrEqual(context.organismCapacity);
    expect(context.speciesRecords).toBeGreaterThanOrEqual(1);
    expect(context.bytesPerOrganismSlot).toBeGreaterThan(0);
  });

  it("scales per-slot cost with the organism cap", () => {
    const small = estimateEngineMemory(smallEngine());

    const bigConfig = cloneConfig(SMALL_WORLD);
    bigConfig.limits.maxOrganisms = 1024;
    const big = estimateEngineMemory(new SimulationEngine({ seed: 0x51ab1e, config: bigConfig }));

    // Doubling the cap doubles every per-slot column. Genes and brains are
    // purely per-slot, so they double exactly; organism state also carries the
    // fixed death-cause histogram, so it doubles everything except that.
    expect(big.bytes.brains).toBe(small.bytes.brains * 2);
    expect(big.bytes.genes).toBe(small.bytes.genes * 2);
    const fixedOrganismBytes = DEATH_CAUSE_COUNT * Uint32Array.BYTES_PER_ELEMENT;
    expect(big.bytes.organismState).toBe(small.bytes.organismState * 2 - fixedOrganismBytes);

    // Per-slot cost is therefore the same to within that fixed remainder
    // spread over the cap — under a byte per slot at these sizes.
    expect(big.context.bytesPerOrganismSlot).toBeCloseTo(small.context.bytesPerOrganismSlot, 0);
  });

  it("keeps counting the organism columns if the store is refactored", () => {
    const engine = smallEngine();
    const { bytes } = estimateEngineMemory(engine);
    const capacity = SMALL_WORLD.limits.maxOrganisms;

    // The SoA stores are walked generically over their own enumerable
    // typed-array fields, which is drift-proof for columns that are ADDED and
    // silently wrong for a column that becomes private. This bound is the
    // tripwire: the store holds well over twenty columns, the narrowest of
    // which is one byte, so a walk that found only a handful would fail here
    // rather than quietly under-report.
    const MINIMUM_BYTES_PER_SLOT = 40;
    expect(bytes.organismState).toBeGreaterThan(capacity * MINIMUM_BYTES_PER_SLOT);
    expect(bytes.phenotypes).toBeGreaterThan(capacity * 20);
    expect(bytes.scratch).toBeGreaterThan(capacity * 20);
    expect(bytes.spatialIndex).toBeGreaterThan(capacity * 4);
  });

  it("formats byte counts for human reading", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MiB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GiB");
  });
});
