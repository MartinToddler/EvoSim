import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";
import { TRAIT_DIMENSIONS } from "./traitVector";

/**
 * Why a species record ended (docs/05 §5). `Active` occupies 0 so a record is
 * active exactly while `endReason === 0`, matching `endTick === 0`.
 */
export const SpeciesEndReason = {
  Active: 0,
  Split: 1,
  Extinct: 2,
} as const;

export type SpeciesEndReason = (typeof SpeciesEndReason)[keyof typeof SpeciesEndReason];

/** Human-readable end reasons, indexed by SpeciesEndReason. Diagnostics/DTOs. */
export const SPECIES_END_REASON_NAMES: readonly string[] = ["active", "split", "extinct"];

/**
 * Persistent split-candidate state (docs/05 §7 "Stability").
 *
 * A qualifying bifurcation must persist across `species.stabilityIntervals`
 * consecutive analyses before it becomes a split. The candidate centroids are
 * what "the same bifurcation" means between analyses, so they are authoritative
 * state: they influence exactly when a future split happens, and they must
 * survive snapshot/restore bit-for-bit or a reloaded world would speciate on a
 * different tick than the world that never saved.
 */
export interface SplitCandidateState {
  /** Consecutive qualifying analyses, including the one that created this. */
  passes: number;
  /** Candidate daughter centroid A at the most recent qualifying analysis. */
  readonly centroidA: Int32Array;
  /** Candidate daughter centroid B at the most recent qualifying analysis. */
  readonly centroidB: Int32Array;
}

/**
 * One species record (docs/05 §5). Records are permanent: an ended species
 * keeps its row forever, because the Tree of Life and the timeline are built
 * from them (docs/05 §§8, 19).
 *
 * These are ordinary objects rather than SoA columns on purpose. The organism
 * store holds thousands of rows touched twenty times per tick; the species
 * registry holds tens-to-hundreds of rows touched every 400 ticks. Clarity wins
 * where the data layout rule has nothing to optimize.
 */
export interface SpeciesRecord {
  /** Deterministic 1-based identity; never reused (docs/05 §5). */
  readonly id: number;
  /** Parent species, 0 for the founder species. Always < id, so the tree is acyclic. */
  readonly parentSpeciesId: number;
  readonly originTick: number;
  /** 0 while active (docs/05 §5). */
  endTick: number;
  endReason: SpeciesEndReason;
  /** Live members right now; maintained by every birth, death and split. */
  population: number;
  /**
   * Mean member trait vector, refreshed at every analysis while the species
   * lives (docs/05 §5 "representative/centroid ecological phenotype").
   */
  readonly centroidTraits: Int32Array;
  /** Centroid at origin, frozen: what the species looked like when it appeared. */
  readonly originCentroid: Int32Array;
  /** Lowest-entity-ID member at origin (docs/05 §5). */
  readonly founderEntityId: number;
  readonly generationAtOrigin: number;

  // --- Lifetime accumulators (docs/05 §5) -----------------------------------
  totalBirths: number;
  totalDeaths: number;
  totalKills: number;
  plantEnergyConsumed: number;
  meatEnergyConsumed: number;

  /** Pending bifurcation, or null when none is being tracked (docs/05 §7). */
  candidate: SplitCandidateState | null;

  // --- Carnivore-lineage detector (docs/05 §15) ------------------------------
  /** Permanent badge: this lineage was detected living on meat. */
  carnivoreDetected: boolean;
  /** Consecutive statistics samples that met the carnivore criteria. */
  carnivoreStreak: number;
  /** Cumulative consumption at the previous statistics sample, for deltas. */
  prevPlantConsumedSample: number;
  prevMeatConsumedSample: number;
}

/** Serializable species registry state (docs/10 §18 "species registry/candidate state"). */
export interface SpeciesSnapshot {
  nextSpeciesId: number;
  records: {
    id: number;
    parentSpeciesId: number;
    originTick: number;
    endTick: number;
    endReason: number;
    population: number;
    centroidTraits: Int32Array;
    originCentroid: Int32Array;
    founderEntityId: number;
    generationAtOrigin: number;
    totalBirths: number;
    totalDeaths: number;
    totalKills: number;
    plantEnergyConsumed: number;
    meatEnergyConsumed: number;
    candidatePasses: number;
    /** Empty arrays when there is no candidate. */
    candidateCentroidA: Int32Array;
    candidateCentroidB: Int32Array;
    carnivoreDetected: number;
    carnivoreStreak: number;
    prevPlantConsumedSample: number;
    prevMeatConsumedSample: number;
  }[];
}

/** Error thrown when a species snapshot cannot be restored. */
export class SpeciesSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeciesSnapshotError";
  }
}

/**
 * The species registry (docs/05 §5, task I01).
 *
 * IDs are dense: record `id` lives at `records[id - 1]`, which makes lookup
 * O(1) without a map whose iteration order could tempt anyone. IDs are handed
 * out by a monotonic counter that is itself authoritative state, exactly like
 * entity IDs.
 */
export class SpeciesStore {
  readonly #records: SpeciesRecord[] = [];
  #nextSpeciesId = 1;
  #activeCount = 0;

  /** Number of species ever created (active and ended). */
  get count(): number {
    return this.#records.length;
  }

  /** Number of currently active species. */
  get activeCount(): number {
    return this.#activeCount;
  }

  /** Species ID the next creation will use. */
  get nextSpeciesId(): number {
    return this.#nextSpeciesId;
  }

  /** The record for a species ID. Throws on an ID that was never issued. */
  get(id: number): SpeciesRecord {
    const record = this.#records[id - 1];
    assert(record !== undefined, `species ${id} does not exist (count ${this.#records.length})`);
    return record;
  }

  /** Read-only view of every record, index = id - 1. Do not mutate. */
  get records(): readonly SpeciesRecord[] {
    return this.#records;
  }

  /**
   * Create a species and return its record. Centroid arrays are copied.
   *
   * `population` starts 0: members arrive through {@link recordBirth} (births,
   * founders) or through split reassignment, both of which keep the
   * population-matches-members invariant maintainable in one place each.
   */
  createSpecies(options: {
    parentSpeciesId: number;
    originTick: number;
    centroid: Int32Array;
    founderEntityId: number;
    generationAtOrigin: number;
  }): SpeciesRecord {
    assert(
      options.centroid.length === TRAIT_DIMENSIONS,
      `species centroid must have ${TRAIT_DIMENSIONS} dimensions, got ${options.centroid.length}`,
    );
    const id = this.#nextSpeciesId;
    assert(id <= 0xffffffff, "species IDs are exhausted");
    this.#nextSpeciesId += 1;

    const record: SpeciesRecord = {
      id,
      parentSpeciesId: options.parentSpeciesId,
      originTick: options.originTick,
      endTick: 0,
      endReason: SpeciesEndReason.Active,
      population: 0,
      centroidTraits: new Int32Array(options.centroid),
      originCentroid: new Int32Array(options.centroid),
      founderEntityId: options.founderEntityId,
      generationAtOrigin: options.generationAtOrigin,
      totalBirths: 0,
      totalDeaths: 0,
      totalKills: 0,
      plantEnergyConsumed: 0,
      meatEnergyConsumed: 0,
      candidate: null,
      carnivoreDetected: false,
      carnivoreStreak: 0,
      prevPlantConsumedSample: 0,
      prevMeatConsumedSample: 0,
    };
    this.#records.push(record);
    this.#activeCount += 1;
    return record;
  }

  /** A birth (or founder spawn) into a species. */
  recordBirth(speciesId: number): void {
    const record = this.get(speciesId);
    assert(
      record.endReason === SpeciesEndReason.Active,
      `birth recorded into ended species ${speciesId}`,
    );
    record.population += 1;
    record.totalBirths += 1;
  }

  /**
   * A member's death. Returns the new population so the caller — death
   * finalization, which knows the tick and owns event emission — can mark the
   * extinction (docs/05 §8).
   */
  recordDeath(speciesId: number): number {
    const record = this.get(speciesId);
    assert(
      record.endReason === SpeciesEndReason.Active,
      `death recorded against ended species ${speciesId}`,
    );
    assert(record.population > 0, `death would make species ${speciesId} population negative`);
    record.population -= 1;
    record.totalDeaths += 1;
    return record.population;
  }

  /** A combat kill credited to a member of this species. */
  recordKill(speciesId: number): void {
    this.get(speciesId).totalKills += 1;
  }

  /** Energy gained by a member from plant or carcass feeding (docs/05 §5). */
  recordConsumption(speciesId: number, plantEnergy: number, meatEnergy: number): void {
    const record = this.get(speciesId);
    record.plantEnergyConsumed += plantEnergy;
    record.meatEnergyConsumed += meatEnergy;
  }

  /**
   * End a species (docs/05 §§7–8). Population must already be 0 for `Extinct`;
   * a split ends the parent only after every member was reassigned.
   */
  endSpecies(speciesId: number, tick: number, reason: SpeciesEndReason): void {
    const record = this.get(speciesId);
    assert(record.endReason === SpeciesEndReason.Active, `species ${speciesId} ended twice`);
    assert(reason !== SpeciesEndReason.Active, "endSpecies requires a terminal reason");
    assert(
      record.population === 0,
      `species ${speciesId} ended with ${record.population} live members`,
    );
    record.endTick = tick;
    record.endReason = reason;
    record.candidate = null;
    this.#activeCount -= 1;
  }

  /**
   * Feed the registry into the canonical state hash.
   *
   * Everything here is authoritative: the counters feed event detection, the
   * candidate state decides future splits, and the record fields are the
   * permanent history (docs/02 §9). The field order is a hashing contract.
   */
  hashInto(hasher: StateHash): void {
    hasher.word(this.#records.length);
    hasher.word(this.#nextSpeciesId);
    hasher.word(this.#activeCount);
    for (const record of this.#records) {
      hasher.word(record.id);
      hasher.word(record.parentSpeciesId);
      hasher.safeInteger(record.originTick);
      hasher.safeInteger(record.endTick);
      hasher.word(record.endReason);
      hasher.word(record.population);
      hasher.array(HASH_TAG.i32, record.centroidTraits);
      hasher.array(HASH_TAG.i32, record.originCentroid);
      hasher.word(record.founderEntityId);
      hasher.word(record.generationAtOrigin);
      hasher.safeInteger(record.totalBirths);
      hasher.safeInteger(record.totalDeaths);
      hasher.safeInteger(record.totalKills);
      hasher.safeInteger(record.plantEnergyConsumed);
      hasher.safeInteger(record.meatEnergyConsumed);
      const candidate = record.candidate;
      if (candidate === null) {
        hasher.word(0);
      } else {
        hasher.word(1);
        hasher.word(candidate.passes);
        hasher.array(HASH_TAG.i32, candidate.centroidA);
        hasher.array(HASH_TAG.i32, candidate.centroidB);
      }
      hasher.word(record.carnivoreDetected ? 1 : 0);
      hasher.word(record.carnivoreStreak);
      hasher.safeInteger(record.prevPlantConsumedSample);
      hasher.safeInteger(record.prevMeatConsumedSample);
    }
  }

  /** Capture the registry for a snapshot. Arrays are copied. */
  capture(): SpeciesSnapshot {
    for (const record of this.#records) {
      // The snapshot encodes "has a candidate" as candidatePasses > 0, so a
      // candidate at zero passes would be silently DROPPED across save/load —
      // a split delayed by one analysis, exactly the divergence M8 forbids.
      // Today a candidate is born at one pass and only ever incremented; this
      // makes any future violation fail loudly at save time (M8 review).
      assert(
        record.candidate === null || record.candidate.passes >= 1,
        `species ${record.id} has a split candidate with ${record.candidate?.passes ?? 0} passes; ` +
          "the snapshot encoding cannot represent it",
      );
    }
    return {
      nextSpeciesId: this.#nextSpeciesId,
      records: this.#records.map((record) => ({
        id: record.id,
        parentSpeciesId: record.parentSpeciesId,
        originTick: record.originTick,
        endTick: record.endTick,
        endReason: record.endReason,
        population: record.population,
        centroidTraits: new Int32Array(record.centroidTraits),
        originCentroid: new Int32Array(record.originCentroid),
        founderEntityId: record.founderEntityId,
        generationAtOrigin: record.generationAtOrigin,
        totalBirths: record.totalBirths,
        totalDeaths: record.totalDeaths,
        totalKills: record.totalKills,
        plantEnergyConsumed: record.plantEnergyConsumed,
        meatEnergyConsumed: record.meatEnergyConsumed,
        candidatePasses: record.candidate === null ? 0 : record.candidate.passes,
        candidateCentroidA:
          record.candidate === null
            ? new Int32Array(0)
            : new Int32Array(record.candidate.centroidA),
        candidateCentroidB:
          record.candidate === null
            ? new Int32Array(0)
            : new Int32Array(record.candidate.centroidB),
        carnivoreDetected: record.carnivoreDetected ? 1 : 0,
        carnivoreStreak: record.carnivoreStreak,
        prevPlantConsumedSample: record.prevPlantConsumedSample,
        prevMeatConsumedSample: record.prevMeatConsumedSample,
      })),
    };
  }

  /** Drop everything and restore from a snapshot, validating shape and identity. */
  restore(snapshot: SpeciesSnapshot): void {
    if (!Number.isSafeInteger(snapshot.nextSpeciesId) || snapshot.nextSpeciesId < 1) {
      throw new SpeciesSnapshotError(
        `restored nextSpeciesId out of range: ${snapshot.nextSpeciesId}`,
      );
    }
    if (snapshot.records.length !== snapshot.nextSpeciesId - 1) {
      throw new SpeciesSnapshotError(
        `species snapshot has ${snapshot.records.length} records but nextSpeciesId ` +
          `${snapshot.nextSpeciesId} implies ${snapshot.nextSpeciesId - 1}`,
      );
    }

    this.#records.length = 0;
    this.#nextSpeciesId = snapshot.nextSpeciesId;
    this.#activeCount = 0;

    for (let i = 0; i < snapshot.records.length; i += 1) {
      const saved = snapshot.records[i] as SpeciesSnapshot["records"][number];
      if (saved.id !== i + 1) {
        throw new SpeciesSnapshotError(
          `species record ${i} carries id ${saved.id}, expected ${i + 1}`,
        );
      }
      if (saved.parentSpeciesId >= saved.id) {
        // Parents always precede children; this is what makes the Tree of Life
        // acyclic by construction rather than by traversal (docs/05 §19).
        throw new SpeciesSnapshotError(
          `species ${saved.id} claims parent ${saved.parentSpeciesId}, which is not older`,
        );
      }
      if (
        saved.centroidTraits.length !== TRAIT_DIMENSIONS ||
        saved.originCentroid.length !== TRAIT_DIMENSIONS
      ) {
        throw new SpeciesSnapshotError(`species ${saved.id} centroids have the wrong dimension`);
      }
      const hasCandidate = saved.candidatePasses > 0;
      if (
        hasCandidate &&
        (saved.candidateCentroidA.length !== TRAIT_DIMENSIONS ||
          saved.candidateCentroidB.length !== TRAIT_DIMENSIONS)
      ) {
        throw new SpeciesSnapshotError(
          `species ${saved.id} has a split candidate with malformed centroids`,
        );
      }
      const endReason = saved.endReason as SpeciesEndReason;
      if (
        endReason !== SpeciesEndReason.Active &&
        endReason !== SpeciesEndReason.Split &&
        endReason !== SpeciesEndReason.Extinct
      ) {
        throw new SpeciesSnapshotError(
          `species ${saved.id} has unknown end reason ${saved.endReason}`,
        );
      }
      if ((endReason === SpeciesEndReason.Active) !== (saved.endTick === 0)) {
        throw new SpeciesSnapshotError(
          `species ${saved.id} end state is inconsistent: reason ${saved.endReason}, tick ${saved.endTick}`,
        );
      }
      if (endReason !== SpeciesEndReason.Active && saved.population !== 0) {
        throw new SpeciesSnapshotError(
          `ended species ${saved.id} claims ${saved.population} live members`,
        );
      }

      const record: SpeciesRecord = {
        id: saved.id,
        parentSpeciesId: saved.parentSpeciesId,
        originTick: saved.originTick,
        endTick: saved.endTick,
        endReason,
        population: saved.population,
        centroidTraits: new Int32Array(saved.centroidTraits),
        originCentroid: new Int32Array(saved.originCentroid),
        founderEntityId: saved.founderEntityId,
        generationAtOrigin: saved.generationAtOrigin,
        totalBirths: saved.totalBirths,
        totalDeaths: saved.totalDeaths,
        totalKills: saved.totalKills,
        plantEnergyConsumed: saved.plantEnergyConsumed,
        meatEnergyConsumed: saved.meatEnergyConsumed,
        candidate: hasCandidate
          ? {
              passes: saved.candidatePasses,
              centroidA: new Int32Array(saved.candidateCentroidA),
              centroidB: new Int32Array(saved.candidateCentroidB),
            }
          : null,
        carnivoreDetected: saved.carnivoreDetected === 1,
        carnivoreStreak: saved.carnivoreStreak,
        prevPlantConsumedSample: saved.prevPlantConsumedSample,
        prevMeatConsumedSample: saved.prevMeatConsumedSample,
      };
      this.#records.push(record);
      if (endReason === SpeciesEndReason.Active) {
        this.#activeCount += 1;
      }
    }
  }
}
