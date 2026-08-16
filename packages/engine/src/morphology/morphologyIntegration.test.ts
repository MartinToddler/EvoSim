import { describe, expect, it } from "vitest";
import { MORPH_CHANNEL_COUNT, MorphChannel, MORPH_MAGNITUDE_SCALE } from "@eon/protocol";
import { SimulationEngine } from "../SimulationEngine";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { engineInternals } from "../internal";
import { Q } from "../math/fixed";
import {
  MORPH_CHANNEL_STRIDE,
  MORPH_MAGNITUDE_SCALE as ENGINE_MAGNITUDE_SCALE,
  MorphChannelIndex,
  writeRenderSnapshot,
  type RenderSnapshotWriter,
} from "../render/renderSnapshot";
import { MORPH_GENE_COUNT, MorphGene } from "./morphGenes";

const FIXTURE_SEED = 0xe0a12026;

/** A small but real world: founders, plants, births — just fewer of them. */
function smallWorldConfig(): ReturnType<typeof cloneConfig> {
  const config = cloneConfig(DEFAULT_CONFIG);
  const gridSize = 64;
  config.world.envGridSize = gridSize;
  config.world.sizeLU = gridSize * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(gridSize / 8));
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 2,
  );
  config.world.initialOrganisms = 60;
  config.limits.maxOrganisms = 2048;
  config.limits.maxCarcasses = 1024;
  // Validity thresholds are absolute totals calibrated for the 256² default
  // world, so they scale with the area or a valid small world is rejected for
  // being small.
  const areaRatio = (gridSize * gridSize) / (256 * 256);
  config.world.validity.minFounderRegionCells = Math.max(
    16,
    Math.floor(config.world.validity.minFounderRegionCells * areaRatio),
  );
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity * areaRatio,
  );
  return config;
}

function smallWorld(seed = FIXTURE_SEED): SimulationEngine {
  return new SimulationEngine({ seed, config: smallWorldConfig() });
}

function createWriter(organismCapacity: number, carcassCapacity: number): RenderSnapshotWriter {
  return {
    organismId: new Uint32Array(organismCapacity),
    organismX: new Float32Array(organismCapacity),
    organismY: new Float32Array(organismCapacity),
    organismRotation: new Float32Array(organismCapacity),
    organismRadiusLU: new Float32Array(organismCapacity),
    organismSpeciesId: new Uint32Array(organismCapacity),
    organismMorph: new Uint8Array(organismCapacity * MORPH_CHANNEL_STRIDE),
    organismHueDeg: new Uint16Array(organismCapacity),
    organismFlags: new Uint16Array(organismCapacity),
    organismHealth: new Uint8Array(organismCapacity),
    organismEnergy: new Uint8Array(organismCapacity),
    organismDiet: new Int8Array(organismCapacity),
    organismSpeed: new Uint8Array(organismCapacity),
    carcassId: new Uint32Array(carcassCapacity),
    carcassX: new Float32Array(carcassCapacity),
    carcassY: new Float32Array(carcassCapacity),
    carcassRadiusLU: new Float32Array(carcassCapacity),
  };
}

describe("morphology is inherited state (M14)", () => {
  it("every founder shares the founder body", () => {
    const engine = smallWorld();
    const { genomes, organisms } = engine;
    const first = [...genomes.morphGenes.subarray(0, MORPH_GENE_COUNT)];
    for (let slot = 1; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      expect([
        ...genomes.morphGenes.subarray(
          genomes.morphOffset(slot),
          genomes.morphOffset(slot) + MORPH_GENE_COUNT,
        ),
      ]).toEqual(first);
    }
  });

  it("a child with mutation disabled is its parent's morphological clone", () => {
    const config = smallWorldConfig();
    for (const block of [config.mutation.ecological, config.mutation.morphology]) {
      block.perGeneMutationProbabilityQ = 0;
      block.largeMutationProbabilityQ = 0;
      block.resetProbabilityQ = 0;
    }
    config.mutation.morphology.structuralProbabilityQ = 0;
    config.mutation.brain.perWeightMutationProbabilityQ = 0;
    config.mutation.brain.largeWeightMutationProbabilityQ = 0;

    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config });
    const founderBody = [...engine.genomes.morphGenes.subarray(0, MORPH_GENE_COUNT)];
    const initialBirths = engine.organisms.totalBirths;
    engine.stepMany(4_000);
    expect(engine.organisms.totalBirths).toBeGreaterThan(initialBirths);

    // With every mutation class off, no descendant can differ from the founder.
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      if (engine.organisms.alive[slot] !== 1) {
        continue;
      }
      expect([
        ...engine.genomes.morphGenes.subarray(
          engine.genomes.morphOffset(slot),
          engine.genomes.morphOffset(slot) + MORPH_GENE_COUNT,
        ),
      ]).toEqual(founderBody);
    }
  });

  it("ordinary mutation makes descendants differ from the founder", () => {
    const engine = smallWorld();
    const founderBody = [...engine.genomes.morphGenes.subarray(0, MORPH_GENE_COUNT)];
    engine.stepMany(6_000);

    let live = 0;
    let differing = 0;
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      if (engine.organisms.alive[slot] !== 1) {
        continue;
      }
      live += 1;
      const body = [
        ...engine.genomes.morphGenes.subarray(
          engine.genomes.morphOffset(slot),
          engine.genomes.morphOffset(slot) + MORPH_GENE_COUNT,
        ),
      ];
      if (body.some((value, index) => value !== founderBody[index])) {
        differing += 1;
      }
    }
    expect(live).toBeGreaterThan(0);
    expect(differing).toBeGreaterThan(0);
  });

  it("morphology genes are hashed, so two worlds differing only in a body differ in hash", () => {
    const a = smallWorld();
    const b = smallWorld();
    expect(a.computeStateHash()).toBe(b.computeStateHash());
    // Reach past the public surface deliberately: this asserts that the gene
    // block is inside the canonical stream, which is the whole point.
    b.genomes.morphGenes[MorphGene.BodyLength] =
      ((b.genomes.morphGenes[MorphGene.BodyLength] as number) + 1) & 0xffff;
    expect(a.computeStateHash()).not.toBe(b.computeStateHash());
  });

  it("survives serialize and restore exactly, including the developed body", () => {
    const engine = smallWorld();
    engine.stepMany(500);
    const before = engine.computeStateHash();
    const bodiesBefore = [...engine.genomes.morphGenes];

    const restored = SimulationEngine.fromSnapshot(engine.serialize());
    expect(restored.computeStateHash()).toBe(before);
    expect([...restored.genomes.morphGenes]).toEqual(bodiesBefore);

    // The developed cache is not serialized; it must be rebuilt identically.
    const live = engineInternals(engine).context.morphology;
    const back = engineInternals(restored).context.morphology;
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      if (engine.organisms.alive[slot] !== 1) {
        continue;
      }
      expect(back.bodyLengthQ[slot]).toBe(live.bodyLengthQ[slot]);
      expect(back.segmentCount[slot]).toBe(live.segmentCount[slot]);
      expect(back.appendagePairs[slot]).toBe(live.appendagePairs[slot]);
      expect(back.primaryHueDeg[slot]).toBe(live.primaryHueDeg[slot]);
      expect(back.silhouetteLengthQ[slot]).toBe(live.silhouetteLengthQ[slot]);
    }

    // And continuing from the restore must match continuing from the original.
    engine.stepMany(250);
    restored.stepMany(250);
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());
  });
});

describe("morphology on the render wire (M14)", () => {
  it("the engine's channel indices mirror the protocol's exactly", () => {
    expect(MORPH_CHANNEL_STRIDE).toBe(MORPH_CHANNEL_COUNT);
    expect(ENGINE_MAGNITUDE_SCALE).toBe(MORPH_MAGNITUDE_SCALE);
    for (const [name, index] of Object.entries(MorphChannelIndex)) {
      expect(`${name}:${index}`).toBe(
        `${name}:${(MorphChannel as Record<string, number>)[name] as number}`,
      );
    }
    expect(Object.keys(MorphChannelIndex)).toHaveLength(MORPH_CHANNEL_COUNT);
  });

  it("projects the developed body without touching authoritative state", () => {
    const engine = smallWorld();
    engine.stepMany(200);
    const before = engine.computeStateHash();
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );

    const counts = writeRenderSnapshot(engine, writer);
    expect(counts.organismCount).toBeGreaterThan(0);
    expect(engine.computeStateHash()).toBe(before);

    const morphology = engineInternals(engine).context.morphology;
    // Walk the dense output back to the slot it came from and check one
    // structural and one magnitude channel round-trip through the wire.
    let out = 0;
    for (
      let slot = 0;
      slot < engine.organisms.slotHighWater && out < counts.organismCount;
      slot += 1
    ) {
      if (engine.organisms.alive[slot] !== 1) {
        continue;
      }
      const base = out * MORPH_CHANNEL_STRIDE;
      expect(writer.organismMorph[base + MorphChannelIndex.SegmentCount]).toBe(
        morphology.segmentCount[slot],
      );
      expect(writer.organismMorph[base + MorphChannelIndex.AppendagePairs]).toBe(
        morphology.appendagePairs[slot],
      );
      expect(writer.organismMorph[base + MorphChannelIndex.PrimaryHueHalfDeg]).toBe(
        (morphology.primaryHueDeg[slot] as number) >> 1,
      );
      // Magnitude channels decode back to their Q value within one quantum.
      const decoded =
        ((writer.organismMorph[base + MorphChannelIndex.BodyLength] as number) / 255) *
        MORPH_MAGNITUDE_SCALE *
        Q;
      expect(Math.abs(decoded - (morphology.bodyLengthQ[slot] as number))).toBeLessThan(
        (MORPH_MAGNITUDE_SCALE * Q) / 255,
      );
      out += 1;
    }
  });

  it("writes a full channel block for every projected organism", () => {
    const engine = smallWorld();
    engine.stepMany(50);
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );
    const counts = writeRenderSnapshot(engine, writer);
    for (let out = 0; out < counts.organismCount; out += 1) {
      const base = out * MORPH_CHANNEL_STRIDE;
      // Body extents are strictly positive for every legal genome, so an
      // unwritten block would show up here as a zero.
      expect(writer.organismMorph[base + MorphChannelIndex.BodyLength] as number).toBeGreaterThan(
        0,
      );
      expect(writer.organismMorph[base + MorphChannelIndex.BodyWidth] as number).toBeGreaterThan(0);
      expect(writer.organismMorph[base + MorphChannelIndex.SegmentCount] as number).toBeGreaterThan(
        0,
      );
    }
  });
});
