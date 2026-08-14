import { describe, expect, it } from "vitest";
import { Gene } from "../genetics/genes";
import { WorldEventType } from "../history/EventStore";
import { Q } from "../math/fixed";
import { DeathCause, finalizeDeaths, markDeath } from "../organisms/death";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { SpeciesEndReason } from "./SpeciesStore";
import { analyzeSpecies, evaluateBifurcation } from "./speciation";
import { TRAIT_DIMENSIONS } from "./traitVector";

/**
 * Deterministic speciation fixtures (docs/05 §§6–7, docs/07 §2 "Species",
 * task I03/I04/I05).
 *
 * These drive the REAL analysis phase over harness worlds with planted
 * genomes. Two gene profiles far apart in phenotype space form the two
 * "niches"; small deterministic jitter keeps each cloud from being a single
 * point without ever approaching the split threshold.
 */

/** Gene profile A: small, slow, herbivorous, short-sighted. */
const PROFILE_A: Record<number, number> = {
  [Gene.AdultSize]: Math.trunc(Q * 0.15),
  [Gene.MaxSpeed]: Math.trunc(Q * 0.2),
  [Gene.Diet]: Math.trunc(Q * 0.1),
  [Gene.VisionRange]: Math.trunc(Q * 0.2),
  [Gene.AttackPower]: Math.trunc(Q * 0.1),
  [Gene.MaxAge]: Q,
  [Gene.ThermalTolerance]: Q,
};

/** Gene profile B: large, fast, carnivorous, far-sighted. */
const PROFILE_B: Record<number, number> = {
  [Gene.AdultSize]: Math.trunc(Q * 0.85),
  [Gene.MaxSpeed]: Math.trunc(Q * 0.8),
  [Gene.Diet]: Math.trunc(Q * 0.9),
  [Gene.VisionRange]: Math.trunc(Q * 0.8),
  [Gene.AttackPower]: Math.trunc(Q * 0.9),
  [Gene.MaxAge]: Q,
  [Gene.ThermalTolerance]: Q,
};

/** Deterministic per-member jitter, well below any threshold. */
function jitter(profile: Record<number, number>, index: number): Record<number, number> {
  const out: Record<number, number> = { ...profile };
  const wobble = (index % 5) * 4; // 0..16 of 4096 — a fraction of a percent.
  out[Gene.Acceleration] = Math.trunc(Q * 0.4) + wobble;
  out[Gene.TurnRate] = Math.trunc(Q * 0.4) + ((index * 7) % 5) * 4;
  return out;
}

/** Plant `count` members of a profile into the harness world's species 1. */
function plantCloud(
  world: TestWorld,
  profile: Record<number, number>,
  count: number,
  gridBase: number,
): number[] {
  const slots: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const { xPos, yPos } = world.cellCenter(gridBase + (i % 8), 8 + Math.trunc(i / 8));
    const slot = spawnTestOrganism(world, {
      xPos,
      yPos,
      genesQ: jitter(profile, i),
      silentBrain: true,
    });
    expect(slot).toBeGreaterThanOrEqual(0);
    slots.push(slot);
  }
  return slots;
}

/** Run `count` consecutive analysis intervals against the harness context. */
function runAnalyses(world: TestWorld, count: number, startTick = 400): number {
  const interval = 400;
  let tick = startTick;
  for (let i = 0; i < count; i += 1) {
    analyzeSpecies(world.ctx, tick);
    tick += interval;
  }
  return tick - interval;
}

describe("bifurcation detector (docs/05 §7)", () => {
  it("fixture 1: a single phenotype cloud never splits", () => {
    const world = createTestWorld();
    plantCloud(world, PROFILE_A, 60, 8);

    runAnalyses(world, 12);

    expect(world.ctx.species.count).toBe(1);
    expect(world.ctx.species.get(1).endReason).toBe(SpeciesEndReason.Active);
    // The cloud's internal jitter must not even create a candidate.
    expect(world.ctx.species.get(1).candidate).toBeNull();
  });

  it("fixture 2: two separated persistent clouds split after exactly stabilityIntervals analyses", () => {
    const world = createTestWorld();
    plantCloud(world, PROFILE_A, 30, 4);
    plantCloud(world, PROFILE_B, 30, 40);

    // Four qualifying analyses: candidate exists, no split yet.
    runAnalyses(world, 4);
    expect(world.ctx.species.count).toBe(1);
    const candidate = world.ctx.species.get(1).candidate;
    expect(candidate).not.toBeNull();
    expect(candidate?.passes).toBe(4);

    // The fifth consecutive qualifying analysis executes the split.
    analyzeSpecies(world.ctx, 2000);
    const species = world.ctx.species;
    expect(species.count).toBe(3);
    const parent = species.get(1);
    expect(parent.endReason).toBe(SpeciesEndReason.Split);
    expect(parent.endTick).toBe(2000);
    expect(parent.population).toBe(0);
    expect(parent.candidate).toBeNull();

    const childA = species.get(2);
    const childB = species.get(3);
    expect(childA.parentSpeciesId).toBe(1);
    expect(childB.parentSpeciesId).toBe(1);
    expect(childA.originTick).toBe(2000);
    expect(childB.originTick).toBe(2000);
    expect(childA.population + childB.population).toBe(60);
    expect(childA.population).toBe(30);
    expect(childB.population).toBe(30);

    // Every living member was reassigned to exactly one child.
    const organisms = world.ctx.organisms;
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] === 1) {
        expect([2, 3]).toContain(organisms.speciesId[slot]);
      }
    }

    // The split emitted exactly one event naming parent and both children.
    const splits = world.ctx.events.events.filter((e) => e.type === WorldEventType.SpeciesSplit);
    expect(splits).toHaveLength(1);
    expect(splits[0]?.speciesIds).toEqual([1, 2, 3]);
    expect(splits[0]?.tick).toBe(2000);
  });

  it("fixture 3: one extreme outlier never creates a species", () => {
    const world = createTestWorld();
    plantCloud(world, PROFILE_A, 59, 8);
    plantCloud(world, PROFILE_B, 1, 40); // the lone deviant

    runAnalyses(world, 12);

    expect(world.ctx.species.count).toBe(1);
    // The outlier partition exists but its side is far below
    // minDaughterPopulation, so no candidate is ever created.
    expect(world.ctx.species.get(1).candidate).toBeNull();
  });

  it("fixture 4: a temporary separation resets and never yields a permanent species", () => {
    const world = createTestWorld();
    plantCloud(world, PROFILE_A, 30, 4);
    const cloudB = plantCloud(world, PROFILE_B, 30, 40);

    // Three qualifying analyses — two short of stability.
    runAnalyses(world, 3);
    expect(world.ctx.species.get(1).candidate?.passes).toBe(3);

    // The separation collapses: cloud B dies out (a drought, say).
    for (const slot of cloudB) {
      markDeath(world.ctx, slot, DeathCause.Starvation);
    }
    finalizeDeaths(world.ctx, 1300);

    // The next analysis fails the candidate conditions and RESETS the counter.
    analyzeSpecies(world.ctx, 1600);
    expect(world.ctx.species.count).toBe(1);
    expect(world.ctx.species.get(1).candidate).toBeNull();

    // The niche re-forms; stability must be re-earned from zero.
    plantCloud(world, PROFILE_B, 30, 40);
    runAnalyses(world, 4, 2000);
    expect(world.ctx.species.count).toBe(1);
    expect(world.ctx.species.get(1).candidate?.passes).toBe(4);
    analyzeSpecies(world.ctx, 3600);
    expect(world.ctx.species.count).toBe(3);
  });

  it("fixture 5: both daughters must reach the minimum daughter population", () => {
    const below = createTestWorld();
    plantCloud(below, PROFILE_A, 25, 4);
    plantCloud(below, PROFILE_B, 15, 40); // 15 < minDaughterPopulation = 20

    runAnalyses(below, 12);
    expect(below.ctx.species.count).toBe(1);
    expect(below.ctx.species.get(1).candidate).toBeNull();

    const at = createTestWorld();
    plantCloud(at, PROFILE_A, 20, 4);
    plantCloud(at, PROFILE_B, 20, 40); // exactly the minimum on both sides

    runAnalyses(at, 5);
    expect(at.ctx.species.count).toBe(3);
  });

  it("fixture 6: split children record the parent and the parent records the split", () => {
    const world = createTestWorld();
    plantCloud(world, PROFILE_A, 25, 4);
    plantCloud(world, PROFILE_B, 25, 40);
    runAnalyses(world, 5);

    const species = world.ctx.species;
    expect(species.count).toBe(3);
    expect(species.get(1).endReason).toBe(SpeciesEndReason.Split);
    for (const childId of [2, 3]) {
      const child = species.get(childId);
      expect(child.parentSpeciesId).toBe(1);
      expect(child.endReason).toBe(SpeciesEndReason.Active);
      expect(child.founderEntityId).toBeGreaterThan(0);
      // The recorded founder is a live member of that child species.
      const founderSlot = world.ctx.organisms.findSlotByEntityId(child.founderEntityId);
      expect(founderSlot).toBeGreaterThanOrEqual(0);
      expect(world.ctx.organisms.speciesId[founderSlot]).toBe(childId);
    }
    // Daughters are two different species with distinct centroids.
    expect(species.get(2).centroidTraits).not.toEqual(species.get(3).centroidTraits);
  });

  it("a species below 2 * minDaughterPopulation is not analyzed and loses its candidate", () => {
    const world = createTestWorld();
    plantCloud(world, PROFILE_A, 30, 4);
    const cloudB = plantCloud(world, PROFILE_B, 30, 40);
    runAnalyses(world, 2);
    expect(world.ctx.species.get(1).candidate?.passes).toBe(2);

    // Drop total membership below the analysis threshold (60 -> 39).
    for (const slot of cloudB.slice(0, 21)) {
      markDeath(world.ctx, slot, DeathCause.Starvation);
    }
    finalizeDeaths(world.ctx, 900);

    analyzeSpecies(world.ctx, 1200);
    expect(world.ctx.species.get(1).candidate).toBeNull();
  });
});

describe("deterministic tie-breaking (docs/05 §7, fixture 9)", () => {
  /**
   * Hand-build the member scratch: three members where B-seeding has an exact
   * distance tie, and one member exactly equidistant from both centroids.
   * Entity IDs come from real planted organisms, so the tie-break reads real
   * identity, not synthetic array order.
   */
  it("seeds the farthest-from-A centroid by lowest entity ID on a distance tie", () => {
    const world = createTestWorld();
    // Four real organisms whose entity IDs are 1, 2, 3, 4 in spawn order.
    plantCloud(world, PROFILE_A, 4, 8);
    const scratch = world.ctx.scratch;
    const traits = scratch.speciesMemberTraits;
    traits.fill(0, 0, 4 * TRAIT_DIMENSIONS);
    // Member 0 (entity 1, lowest ID) at the origin; members 1 and 2 both at
    // distance² = 1000² on DIFFERENT axes — an exact farthest tie; member 3
    // near the origin.
    traits[1 * TRAIT_DIMENSIONS + 0] = 1000;
    traits[2 * TRAIT_DIMENSIONS + 1] = 1000;
    traits[3 * TRAIT_DIMENSIONS + 0] = 10;

    const result = evaluateBifurcation(world.ctx, 4);
    expect(result.viable).toBe(true);
    // Seed B must be member 1 (entity ID 2), not member 2 (entity ID 3):
    // equal distance, lower ID wins. Cluster B therefore contains member 1.
    expect(scratch.speciesAssignment[1]).toBe(1);
    expect(scratch.speciesAssignment[2]).toBe(0);
  });

  it("assigns an exactly equidistant member to cluster A", () => {
    const world = createTestWorld();
    plantCloud(world, PROFILE_A, 3, 8);
    const scratch = world.ctx.scratch;
    const traits = scratch.speciesMemberTraits;
    traits.fill(0, 0, 3 * TRAIT_DIMENSIONS);
    // Members 0 and 1 sit apart on one axis; member 2 exactly midway between
    // them, equidistant from both seeded centroids at every iteration.
    traits[0 * TRAIT_DIMENSIONS + 0] = 0;
    traits[1 * TRAIT_DIMENSIONS + 0] = 2000;
    traits[2 * TRAIT_DIMENSIONS + 0] = 1000;

    const result = evaluateBifurcation(world.ctx, 3);
    expect(result.viable).toBe(true);
    expect(scratch.speciesAssignment[2]).toBe(0);
  });

  it("a degenerate all-identical cloud fails with an empty cluster instead of splitting", () => {
    const world = createTestWorld();
    plantCloud(world, PROFILE_A, 3, 8);
    const scratch = world.ctx.scratch;
    scratch.speciesMemberTraits.fill(0, 0, 3 * TRAIT_DIMENSIONS);

    const result = evaluateBifurcation(world.ctx, 3);
    expect(result.viable).toBe(false);
  });
});

describe("extinction bookkeeping in the analysis phase", () => {
  it("keeps the registry population equal to live members through deaths", () => {
    const world = createTestWorld();
    const slots = plantCloud(world, PROFILE_A, 45, 8);
    for (const slot of slots.slice(0, 5)) {
      markDeath(world.ctx, slot, DeathCause.Starvation);
    }
    finalizeDeaths(world.ctx, 100);
    expect(world.ctx.species.get(1).population).toBe(40);
    // The analysis asserts population == gathered members internally.
    analyzeSpecies(world.ctx, 400);
    expect(world.ctx.species.get(1).population).toBe(40);
  });
});
