import { assert } from "@eon/shared";
import type { EngineContext } from "../EngineContext";
import { EventSeverity, WorldEventType } from "../history/EventStore";
import { SpeciesEndReason, type SpeciesRecord } from "./SpeciesStore";
import {
  TRAIT_DIMENSIONS,
  rmsThresholdSumSq,
  traitDistanceSumSq,
  writeTraitVector,
} from "./traitVector";

/**
 * Deterministic species analysis — phase 16 of the authoritative tick order
 * (docs/05 §§6–7, docs/03 §7, tasks I02–I05).
 *
 * Runs every `time.speciesAnalysisInterval` ticks. For every active species it
 * refreshes the registry centroid, and for every species large enough to
 * plausibly hold two daughter populations it runs the docs/05 §7 bifurcation
 * detector: seeded deterministic 2-means, candidate conditions, and a
 * stability requirement of `species.stabilityIntervals` consecutive qualifying
 * analyses before any split happens.
 *
 * ## Everything here is deterministic by construction
 *
 * - Members are gathered in ascending slot order, but no decision depends on
 *   that order: seeds and ties are resolved by entity ID, assignment ties go to
 *   cluster A, and centroids are order-independent integer means.
 * - There is no random initialization anywhere (CLAUDE.md forbids it; the PRNG
 *   is deliberately not consumed, so species analysis can never shift the
 *   random stream of reproduction or mutation).
 * - The stability counter's failure policy is RESET, the docs' recommended v0.1
 *   choice: any analysis that does not qualify — too small, no bimodality,
 *   daughters too small, centroids discontinuous — clears the candidate.
 *
 * ## What cannot cause a split
 *
 * - One extreme outlier: its side of the partition is below
 *   `minDaughterPopulation`, so the candidate conditions fail (docs/05 §7).
 * - A temporary excursion: the candidate must qualify at `stabilityIntervals`
 *   CONSECUTIVE analyses with continuous centroids; one failed interval resets
 *   the counter to zero.
 * - A species below `2 * minDaughterPopulation` members: not analyzed at all
 *   (docs/05 §6).
 */

/** Outcome of one bifurcation evaluation, written into engine scratch. */
export interface BifurcationResult {
  /** False when 2-means degenerated (an empty cluster). */
  readonly viable: boolean;
  readonly countA: number;
  readonly countB: number;
  /** ΣΔ² between the two final centroids. */
  readonly centroidDistanceSumSq: number;
}

/**
 * Gather the living members of one species, in ascending slot order, writing
 * slots and trait vectors into scratch. Returns the member count.
 *
 * Exported for the deterministic-tie tests, which populate the scratch member
 * arrays with exact synthetic vectors; not re-exported from the package.
 */
export function gatherMembers(ctx: EngineContext, speciesId: number): number {
  const { organisms, phenotypes, scratch, traitRanges } = ctx;
  const slots = scratch.speciesMemberSlots;
  const traits = scratch.speciesMemberTraits;
  let count = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1 || organisms.speciesId[slot] !== speciesId) {
      continue;
    }
    slots[count] = slot;
    writeTraitVector(traits, count * TRAIT_DIMENSIONS, phenotypes, slot, traitRanges);
    count += 1;
  }
  return count;
}

/** Mean member trait vector, truncated per dimension, into `out` via `sums` scratch. */
function computeCentroid(
  traits: Int32Array,
  memberCount: number,
  out: Int32Array,
  sums: Int32Array,
): void {
  assert(memberCount > 0, "centroid of an empty member set");
  sums.fill(0);
  for (let m = 0; m < memberCount; m += 1) {
    const base = m * TRAIT_DIMENSIONS;
    for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
      sums[d] = (sums[d] as number) + (traits[base + d] as number);
    }
  }
  for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
    out[d] = Math.trunc((sums[d] as number) / memberCount);
  }
}

/**
 * The member farthest from `fromOffset`'s vector; ties broken by lowest entity
 * ID (docs/05 §7 "Seed two centroids"). `from` may be inside the member array.
 */
function farthestMemberIndex(
  ctx: EngineContext,
  memberCount: number,
  from: Int32Array,
  fromOffset: number,
): number {
  const { organisms, scratch } = ctx;
  const traits = scratch.speciesMemberTraits;
  const slots = scratch.speciesMemberSlots;
  let bestIndex = -1;
  let bestDistance = -1;
  let bestEntityId = 0;
  for (let m = 0; m < memberCount; m += 1) {
    const distance = traitDistanceSumSq(traits, m * TRAIT_DIMENSIONS, from, fromOffset);
    const entityId = organisms.entityId[slots[m] as number] as number;
    if (distance > bestDistance || (distance === bestDistance && entityId < bestEntityId)) {
      bestIndex = m;
      bestDistance = distance;
      bestEntityId = entityId;
    }
  }
  assert(bestIndex >= 0, "farthest member of an empty member set");
  return bestIndex;
}

/**
 * Deterministic seeded 2-means (docs/05 §7, task I03).
 *
 * Seeding: A = lowest entity ID member; B = farthest from A (tie: lowest ID);
 * A2 = farthest from B (tie: lowest ID); centroids initialize to A2 and B.
 * Then exactly `species.kMeansIterations` iterations of assign-and-recompute.
 * Assignment ties go to cluster A. An empty cluster fails the evaluation.
 *
 * On success, scratch.speciesAssignment[m] is 0 (cluster A) or 1 (cluster B)
 * for each member, and scratch.speciesCentroidA/B hold the final centroids.
 *
 * Exported for the deterministic-tie tests; not re-exported from the package.
 */
export function evaluateBifurcation(ctx: EngineContext, memberCount: number): BifurcationResult {
  const { organisms, config, scratch } = ctx;
  const traits = scratch.speciesMemberTraits;
  const slots = scratch.speciesMemberSlots;
  const assignment = scratch.speciesAssignment;
  const centroidA = scratch.speciesCentroidA;
  const centroidB = scratch.speciesCentroidB;
  const sumsA = scratch.speciesCentroidSumA;
  const sumsB = scratch.speciesCentroidSumB;

  // Seed A: the lowest-entity-ID member.
  let seedAIndex = 0;
  let lowestEntityId = organisms.entityId[slots[0] as number] as number;
  for (let m = 1; m < memberCount; m += 1) {
    const entityId = organisms.entityId[slots[m] as number] as number;
    if (entityId < lowestEntityId) {
      lowestEntityId = entityId;
      seedAIndex = m;
    }
  }

  const seedBIndex = farthestMemberIndex(ctx, memberCount, traits, seedAIndex * TRAIT_DIMENSIONS);
  const seedA2Index = farthestMemberIndex(ctx, memberCount, traits, seedBIndex * TRAIT_DIMENSIONS);

  for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
    centroidA[d] = traits[seedA2Index * TRAIT_DIMENSIONS + d] as number;
    centroidB[d] = traits[seedBIndex * TRAIT_DIMENSIONS + d] as number;
  }

  let countA = 0;
  let countB = 0;
  for (let iteration = 0; iteration < config.species.kMeansIterations; iteration += 1) {
    countA = 0;
    countB = 0;
    sumsA.fill(0);
    sumsB.fill(0);
    for (let m = 0; m < memberCount; m += 1) {
      const base = m * TRAIT_DIMENSIONS;
      const dA = traitDistanceSumSq(traits, base, centroidA, 0);
      const dB = traitDistanceSumSq(traits, base, centroidB, 0);
      // Tie goes to cluster A (docs/05 §7).
      if (dA <= dB) {
        assignment[m] = 0;
        countA += 1;
        for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
          sumsA[d] = (sumsA[d] as number) + (traits[base + d] as number);
        }
      } else {
        assignment[m] = 1;
        countB += 1;
        for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
          sumsB[d] = (sumsB[d] as number) + (traits[base + d] as number);
        }
      }
    }
    if (countA === 0 || countB === 0) {
      return { viable: false, countA, countB, centroidDistanceSumSq: 0 };
    }
    for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
      centroidA[d] = Math.trunc((sumsA[d] as number) / countA);
      centroidB[d] = Math.trunc((sumsB[d] as number) / countB);
    }
  }

  return {
    viable: true,
    countA,
    countB,
    centroidDistanceSumSq: traitDistanceSumSq(centroidA, 0, centroidB, 0),
  };
}

/**
 * Whether a fresh candidate is the SAME bifurcation as the stored one
 * (docs/05 §7 "Compare new candidate centroids with previous, allowing A/B
 * swap"). Both centroids must lie within the continuity threshold of their
 * counterparts, directly or swapped.
 *
 * Direct and swapped can never both match: qualifying candidates keep their two
 * centroids at least `splitDistanceThresholdQ` apart, and the config validator
 * enforces `splitDistanceThresholdQ > 2 * candidateCentroidContinuityThresholdQ`,
 * so a centroid cannot be near both of a qualifying pair.
 */
function candidateContinues(ctx: EngineContext, record: SpeciesRecord): boolean {
  const candidate = record.candidate;
  if (candidate === null) {
    return false;
  }
  const { scratch, config } = ctx;
  const limit = rmsThresholdSumSq(config.species.candidateCentroidContinuityThresholdQ);
  const newA = scratch.speciesCentroidA;
  const newB = scratch.speciesCentroidB;
  const direct =
    traitDistanceSumSq(newA, 0, candidate.centroidA, 0) <= limit &&
    traitDistanceSumSq(newB, 0, candidate.centroidB, 0) <= limit;
  if (direct) {
    return true;
  }
  return (
    traitDistanceSumSq(newA, 0, candidate.centroidB, 0) <= limit &&
    traitDistanceSumSq(newB, 0, candidate.centroidA, 0) <= limit
  );
}

/**
 * Execute a stable split (docs/05 §7 "Split", task I05).
 *
 * The parent ends with reason `split`; two children are created — cluster A
 * first, then cluster B, so their IDs are deterministic — and every living
 * member is reassigned to its cluster's child. Children inherit nothing from
 * the parent's counters: lifetime accumulators count what happened while an
 * organism belonged to THIS species, which is what makes per-species diet
 * fractions meaningful (docs/05 §15).
 */
function executeSplit(
  ctx: EngineContext,
  record: SpeciesRecord,
  tick: number,
  memberCount: number,
): void {
  const { organisms, species, events, scratch } = ctx;
  const slots = scratch.speciesMemberSlots;
  const assignment = scratch.speciesAssignment;

  // Founders of each daughter: the lowest-entity-ID member of each cluster.
  let founderA = 0;
  let founderB = 0;
  let founderASlot = -1;
  let founderBSlot = -1;
  for (let m = 0; m < memberCount; m += 1) {
    const slot = slots[m] as number;
    const entityId = organisms.entityId[slot] as number;
    if (assignment[m] === 0) {
      if (founderA === 0 || entityId < founderA) {
        founderA = entityId;
        founderASlot = slot;
      }
    } else if (founderB === 0 || entityId < founderB) {
      founderB = entityId;
      founderBSlot = slot;
    }
  }
  assert(founderASlot >= 0 && founderBSlot >= 0, "split with an empty daughter cluster");

  const childA = species.createSpecies({
    parentSpeciesId: record.id,
    originTick: tick,
    centroid: scratch.speciesCentroidA,
    founderEntityId: founderA,
    generationAtOrigin: organisms.generation[founderASlot] as number,
  });
  const childB = species.createSpecies({
    parentSpeciesId: record.id,
    originTick: tick,
    centroid: scratch.speciesCentroidB,
    founderEntityId: founderB,
    generationAtOrigin: organisms.generation[founderBSlot] as number,
  });

  for (let m = 0; m < memberCount; m += 1) {
    const slot = slots[m] as number;
    const child = assignment[m] === 0 ? childA : childB;
    organisms.speciesId[slot] = child.id;
    child.population += 1;
    record.population -= 1;
  }
  assert(
    record.population === 0,
    `split left ${record.population} members behind in species ${record.id}`,
  );

  species.endSpecies(record.id, tick, SpeciesEndReason.Split);

  events.append({
    tick,
    type: WorldEventType.SpeciesSplit,
    severity: EventSeverity.Notable,
    speciesIds: [record.id, childA.id, childB.id],
    entityIds: [founderA, founderB],
    payloadVersion: 1,
    payload: [childA.population, childB.population],
  });
}

/**
 * Phase 16 — scheduled species analysis.
 *
 * Species created DURING this phase (split children) are not analyzed until the
 * next interval: the loop bound is captured before any split runs. They could
 * never qualify anyway — a fresh child has no candidate history — but the
 * explicit bound makes the iteration space of the phase a function of its
 * entry state.
 */
export function analyzeSpecies(ctx: EngineContext, tick: number): void {
  const { species, config, scratch } = ctx;
  const speciesCountAtEntry = species.count;
  const minDaughter = config.species.minDaughterPopulation;
  const splitLimit = rmsThresholdSumSq(config.species.splitDistanceThresholdQ);

  for (let id = 1; id <= speciesCountAtEntry; id += 1) {
    const record = species.get(id);
    if (record.endReason !== SpeciesEndReason.Active) {
      continue;
    }

    const memberCount = gatherMembers(ctx, id);
    assert(
      memberCount === record.population,
      `species ${id} population ${record.population} does not match ${memberCount} live members`,
    );
    if (memberCount === 0) {
      // A species with no members is extinct, and extinction is marked by death
      // finalization the moment the last member dies — analysis never sees it.
      continue;
    }

    // Refresh the registry's representative phenotype (docs/05 §5).
    computeCentroid(
      scratch.speciesMemberTraits,
      memberCount,
      record.centroidTraits,
      scratch.speciesCentroidSumA,
    );

    // docs/05 §6: only species that could hold two viable daughters are analyzed.
    if (memberCount < 2 * minDaughter) {
      record.candidate = null;
      continue;
    }

    const result = evaluateBifurcation(ctx, memberCount);
    const qualifies =
      result.viable &&
      result.countA >= minDaughter &&
      result.countB >= minDaughter &&
      result.centroidDistanceSumSq >= splitLimit;

    if (!qualifies) {
      // Reset policy (docs/05 §7): any non-qualifying analysis clears the
      // candidate entirely. A temporary separation therefore never accumulates
      // toward a split across gaps.
      record.candidate = null;
      continue;
    }

    if (candidateContinues(ctx, record)) {
      const candidate = record.candidate as NonNullable<typeof record.candidate>;
      candidate.passes += 1;
      candidate.centroidA.set(scratch.speciesCentroidA);
      candidate.centroidB.set(scratch.speciesCentroidB);
    } else {
      // Either no candidate, or a DIFFERENT bifurcation than the stored one:
      // this analysis starts a new candidate at one pass.
      record.candidate = {
        passes: 1,
        centroidA: new Int32Array(scratch.speciesCentroidA),
        centroidB: new Int32Array(scratch.speciesCentroidB),
      };
    }

    if (
      (record.candidate as NonNullable<typeof record.candidate>).passes >=
      config.species.stabilityIntervals
    ) {
      executeSplit(ctx, record, tick, memberCount);
    }
  }
}
