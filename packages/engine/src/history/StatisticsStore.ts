import { assert } from "@eon/shared";

/**
 * Authoritative-cadence statistics time series (docs/05 §§10–11, task I06
 * support; the chart contract is docs/06 §15).
 *
 * Samples are taken by phase 17 every `time.statisticsInterval` ticks and kept
 * in a multiresolution structure: a bounded ring of raw samples whose oldest
 * entries are aggregated upward into coarser tiers, so total memory is fixed
 * however long the world runs (docs/05 §11).
 *
 * ## Derived, serialized, deliberately NOT hashed
 *
 * Every value here is a pure function of authoritative state at past sample
 * ticks, and NOTHING reads it back into simulation or event detection —
 * detectors keep their own compact state in EventDetectors. The series is
 * therefore derived history, like a chart: it is serialized so reloading a
 * world does not amputate its charts, but it is not part of the state hash,
 * so retention tuning (a presentation concern) can never move a golden hash.
 * A round-trip test pins that serialization is exact.
 */

/** World sample metrics, one column each (docs/05 §10 world sample). */
export const WorldStatMetric = {
  /** Live organisms at the sample tick. */
  Population: 0,
  /** Active species at the sample tick. */
  ActiveSpecies: 1,
  /** Cumulative extinct species. */
  ExtinctSpecies: 2,
  /** Total plant biomass over the world. */
  PlantBiomass: 3,
  /** Total carcass meat lying in the world. */
  CarcassMeat: 4,
  /** Births since the previous sample. */
  BirthsInterval: 5,
  /** Deaths since the previous sample. */
  DeathsInterval: 6,
  /** Combat deaths (== kills landed) since the previous sample. */
  CombatDeathsInterval: 7,
  /** Mean live energy/maxEnergy in Q. */
  MeanEnergyRatioQ: 8,
  /** Mean signed diet in Q (-Q herbivore … +Q carnivore). */
  MeanDietQ: 9,
  /** Plant energy consumed since the previous sample. */
  PlantEnergyInterval: 10,
  /** Meat energy consumed since the previous sample. */
  MeatEnergyInterval: 11,
} as const;

export type WorldStatMetric = (typeof WorldStatMetric)[keyof typeof WorldStatMetric];

export const WORLD_STAT_METRIC_COUNT = 12;

/** Metric names, indexed by WorldStatMetric. Diagnostics and DTOs. */
export const WORLD_STAT_METRIC_NAMES: readonly string[] = [
  "population",
  "activeSpecies",
  "extinctSpecies",
  "plantBiomass",
  "carcassMeat",
  "birthsInterval",
  "deathsInterval",
  "combatDeathsInterval",
  "meanEnergyRatioQ",
  "meanDietQ",
  "plantEnergyInterval",
  "meatEnergyInterval",
];

/**
 * How ten fine buckets collapse into one coarse bucket per metric
 * (docs/05 §11): level metrics take the truncated mean, interval counters sum
 * (so "births in bucket" stays true at every resolution), and cumulative
 * levels take the last value of the group.
 */
const enum AggregationKind {
  Mean,
  Sum,
  Last,
}

const METRIC_AGGREGATION: readonly AggregationKind[] = [
  AggregationKind.Mean, // Population
  AggregationKind.Mean, // ActiveSpecies
  AggregationKind.Last, // ExtinctSpecies
  AggregationKind.Mean, // PlantBiomass
  AggregationKind.Mean, // CarcassMeat
  AggregationKind.Sum, // BirthsInterval
  AggregationKind.Sum, // DeathsInterval
  AggregationKind.Sum, // CombatDeathsInterval
  AggregationKind.Mean, // MeanEnergyRatioQ
  AggregationKind.Mean, // MeanDietQ
  AggregationKind.Sum, // PlantEnergyInterval
  AggregationKind.Sum, // MeatEnergyInterval
];

/**
 * Retention shape. Three tiers of 240 buckets aggregating by 10 cover
 * 240 samples raw (24k ticks at the default 100-tick cadence), 240 ten-sample
 * buckets (240k ticks) and 240 hundred-sample buckets (2.4M ticks) before the
 * top tier self-compacts. Named engine constants rather than config: retention
 * is presentation capacity, not biology, and must not move world hashes
 * (which config fields do, through the config digest).
 */
export const STATS_TIER_COUNT = 3;
export const STATS_TIER_RATIO = 10;
export const STATS_TIER_CAPACITY = 240;

/** Per-species series metrics (docs/06 §15 species charts). */
export const SpeciesStatMetric = {
  Population: 0,
  /** Mean normalized adult size in [0, Q]. */
  MeanSizeQ: 1,
  /** Mean normalized effective speed in [0, Q]. */
  MeanSpeedQ: 2,
  /** Mean signed diet in [-Q, Q]. */
  MeanDietQ: 3,
} as const;

export type SpeciesStatMetric = (typeof SpeciesStatMetric)[keyof typeof SpeciesStatMetric];

export const SPECIES_STAT_METRIC_COUNT = 4;

export const SPECIES_STAT_METRIC_NAMES: readonly string[] = [
  "population",
  "meanSizeQ",
  "meanSpeedQ",
  "meanDietQ",
];

/**
 * Per-species sample retention: one plain ring, no tiering. 120 samples cover
 * 12k ticks of recent history for the species inspector chart; a species that
 * ends keeps its ring frozen forever, so the memory cost of all history is
 * `speciesCount × ~5 KB`, growing only when speciation happens.
 */
export const SPECIES_SERIES_CAPACITY = 120;

interface Tier {
  /** Bucket values, `bucket * WORLD_STAT_METRIC_COUNT + metric`. */
  values: Float64Array;
  /** Last authoritative tick covered by each bucket. */
  ticks: Float64Array;
  /** Buckets in use, oldest first (tiers are compacted, never circular). */
  length: number;
}

/** One species' sample ring. */
interface SpeciesSeries {
  ticks: Float64Array;
  /** `index * SPECIES_STAT_METRIC_COUNT + metric`. */
  values: Float64Array;
  /** Samples stored (saturates at capacity). */
  length: number;
  /** Ring start index once saturated. */
  start: number;
}

/** Serializable statistics state. */
export interface StatisticsSnapshot {
  worldSampleCount: number;
  tiers: { values: Float64Array; ticks: Float64Array; length: number }[];
  speciesSeries: {
    speciesId: number;
    ticks: Float64Array;
    values: Float64Array;
    length: number;
    start: number;
  }[];
}

/** Error thrown when a statistics snapshot cannot be restored. */
export class StatisticsSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatisticsSnapshotError";
  }
}

/** A time/value series extracted for one metric, oldest first. */
export interface ExtractedSeries {
  ticks: number[];
  values: number[];
}

export class StatisticsStore {
  readonly #tiers: Tier[] = [];
  /** Species series, index = speciesId - 1; sparse until a species samples. */
  #speciesSeries: (SpeciesSeries | null)[] = [];
  #worldSampleCount = 0;

  constructor() {
    for (let t = 0; t < STATS_TIER_COUNT; t += 1) {
      this.#tiers.push({
        values: new Float64Array(STATS_TIER_CAPACITY * WORLD_STAT_METRIC_COUNT),
        ticks: new Float64Array(STATS_TIER_CAPACITY),
        length: 0,
      });
    }
  }

  /** World samples taken since the world began (not the retained count). */
  get worldSampleCount(): number {
    return this.#worldSampleCount;
  }

  /** Append one world sample; values indexed by WorldStatMetric. */
  pushWorldSample(tick: number, values: readonly number[]): void {
    assert(
      values.length === WORLD_STAT_METRIC_COUNT,
      `world sample has ${values.length} metrics, expected ${WORLD_STAT_METRIC_COUNT}`,
    );
    this.#worldSampleCount += 1;
    this.#pushIntoTier(0, tick, values);
  }

  #pushIntoTier(tierIndex: number, tick: number, values: readonly number[]): void {
    const tier = this.#tiers[tierIndex] as Tier;
    if (tier.length === STATS_TIER_CAPACITY) {
      this.#promoteOldest(tierIndex);
    }
    const bucket = tier.length;
    tier.ticks[bucket] = tick;
    const base = bucket * WORLD_STAT_METRIC_COUNT;
    for (let m = 0; m < WORLD_STAT_METRIC_COUNT; m += 1) {
      tier.values[base + m] = values[m] as number;
    }
    tier.length += 1;
  }

  /**
   * Collapse the oldest `STATS_TIER_RATIO` buckets of a full tier into one
   * bucket of the next tier (the top tier compacts into itself), then shift
   * the remainder down.
   */
  #promoteOldest(tierIndex: number): void {
    const tier = this.#tiers[tierIndex] as Tier;
    const group = STATS_TIER_RATIO;
    const aggregated = new Array<number>(WORLD_STAT_METRIC_COUNT).fill(0);
    for (let m = 0; m < WORLD_STAT_METRIC_COUNT; m += 1) {
      const kind = METRIC_AGGREGATION[m] as AggregationKind;
      let accumulator = 0;
      for (let b = 0; b < group; b += 1) {
        const value = tier.values[b * WORLD_STAT_METRIC_COUNT + m] as number;
        if (kind === AggregationKind.Sum) {
          accumulator += value;
        } else if (kind === AggregationKind.Mean) {
          accumulator += value;
        } else {
          accumulator = value; // Last: the final assignment survives the loop.
        }
      }
      aggregated[m] = kind === AggregationKind.Mean ? Math.trunc(accumulator / group) : accumulator;
    }
    const groupLastTick = tier.ticks[group - 1] as number;

    // Shift the surviving buckets down.
    tier.values.copyWithin(
      0,
      group * WORLD_STAT_METRIC_COUNT,
      tier.length * WORLD_STAT_METRIC_COUNT,
    );
    tier.ticks.copyWithin(0, group, tier.length);
    tier.length -= group;

    if (tierIndex + 1 < STATS_TIER_COUNT) {
      this.#pushIntoTier(tierIndex + 1, groupLastTick, aggregated);
    } else {
      // Top tier: absorb into itself. Compacting the top tier loses resolution,
      // never data-window coverage; it keeps the store bounded forever.
      this.#insertOldestIntoTopTier(groupLastTick, aggregated);
    }
  }

  /** Insert one aggregated bucket as the OLDEST bucket of the top tier. */
  #insertOldestIntoTopTier(tick: number, values: readonly number[]): void {
    const tier = this.#tiers[STATS_TIER_COUNT - 1] as Tier;
    assert(tier.length < STATS_TIER_CAPACITY, "top tier must have been compacted before insert");
    tier.values.copyWithin(WORLD_STAT_METRIC_COUNT, 0, tier.length * WORLD_STAT_METRIC_COUNT);
    tier.ticks.copyWithin(1, 0, tier.length);
    tier.ticks[0] = tick;
    for (let m = 0; m < WORLD_STAT_METRIC_COUNT; m += 1) {
      tier.values[m] = values[m] as number;
    }
    tier.length += 1;
  }

  /**
   * One metric's full retained series, coarsest history first, raw tail last —
   * chronological order for charts and the timeline backdrop.
   */
  worldSeries(metric: WorldStatMetric): ExtractedSeries {
    const ticks: number[] = [];
    const values: number[] = [];
    for (let t = STATS_TIER_COUNT - 1; t >= 0; t -= 1) {
      const tier = this.#tiers[t] as Tier;
      for (let b = 0; b < tier.length; b += 1) {
        ticks.push(tier.ticks[b] as number);
        values.push(tier.values[b * WORLD_STAT_METRIC_COUNT + metric] as number);
      }
    }
    return { ticks, values };
  }

  /** Append one species sample; values indexed by SpeciesStatMetric. */
  pushSpeciesSample(speciesId: number, tick: number, values: readonly number[]): void {
    assert(
      values.length === SPECIES_STAT_METRIC_COUNT,
      `species sample has ${values.length} metrics, expected ${SPECIES_STAT_METRIC_COUNT}`,
    );
    while (this.#speciesSeries.length < speciesId) {
      this.#speciesSeries.push(null);
    }
    let series = this.#speciesSeries[speciesId - 1] as SpeciesSeries | null;
    if (series === null) {
      series = {
        ticks: new Float64Array(SPECIES_SERIES_CAPACITY),
        values: new Float64Array(SPECIES_SERIES_CAPACITY * SPECIES_STAT_METRIC_COUNT),
        length: 0,
        start: 0,
      };
      this.#speciesSeries[speciesId - 1] = series;
    }
    let index: number;
    if (series.length < SPECIES_SERIES_CAPACITY) {
      index = (series.start + series.length) % SPECIES_SERIES_CAPACITY;
      series.length += 1;
    } else {
      index = series.start;
      series.start = (series.start + 1) % SPECIES_SERIES_CAPACITY;
    }
    series.ticks[index] = tick;
    const base = index * SPECIES_STAT_METRIC_COUNT;
    for (let m = 0; m < SPECIES_STAT_METRIC_COUNT; m += 1) {
      series.values[base + m] = values[m] as number;
    }
  }

  /** One species' retained series, oldest first; empty when never sampled. */
  speciesSeries(speciesId: number, metric: SpeciesStatMetric): ExtractedSeries {
    const series = this.#speciesSeries[speciesId - 1] ?? null;
    const ticks: number[] = [];
    const values: number[] = [];
    if (series === null) {
      return { ticks, values };
    }
    for (let i = 0; i < series.length; i += 1) {
      const index = (series.start + i) % SPECIES_SERIES_CAPACITY;
      ticks.push(series.ticks[index] as number);
      values.push(series.values[index * SPECIES_STAT_METRIC_COUNT + metric] as number);
    }
    return { ticks, values };
  }

  /** Capture for a snapshot. All arrays copied. */
  capture(): StatisticsSnapshot {
    return {
      worldSampleCount: this.#worldSampleCount,
      tiers: this.#tiers.map((tier) => ({
        values: new Float64Array(tier.values.subarray(0, tier.length * WORLD_STAT_METRIC_COUNT)),
        ticks: new Float64Array(tier.ticks.subarray(0, tier.length)),
        length: tier.length,
      })),
      speciesSeries: this.#speciesSeries.flatMap((series, index) =>
        series === null
          ? []
          : [
              {
                speciesId: index + 1,
                ticks: new Float64Array(series.ticks),
                values: new Float64Array(series.values),
                length: series.length,
                start: series.start,
              },
            ],
      ),
    };
  }

  /** Drop everything and restore from a snapshot. */
  restore(snapshot: StatisticsSnapshot): void {
    if (snapshot.tiers.length !== STATS_TIER_COUNT) {
      throw new StatisticsSnapshotError(
        `snapshot has ${snapshot.tiers.length} tiers, expected ${STATS_TIER_COUNT}`,
      );
    }
    this.#worldSampleCount = snapshot.worldSampleCount;
    for (let t = 0; t < STATS_TIER_COUNT; t += 1) {
      const saved = snapshot.tiers[t] as StatisticsSnapshot["tiers"][number];
      const tier = this.#tiers[t] as Tier;
      if (
        saved.length < 0 ||
        saved.length > STATS_TIER_CAPACITY ||
        saved.ticks.length !== saved.length ||
        saved.values.length !== saved.length * WORLD_STAT_METRIC_COUNT
      ) {
        throw new StatisticsSnapshotError(`tier ${t} snapshot shape is inconsistent`);
      }
      tier.values.fill(0);
      tier.ticks.fill(0);
      tier.values.set(saved.values);
      tier.ticks.set(saved.ticks);
      tier.length = saved.length;
    }
    this.#speciesSeries = [];
    for (const saved of snapshot.speciesSeries) {
      if (
        saved.ticks.length !== SPECIES_SERIES_CAPACITY ||
        saved.values.length !== SPECIES_SERIES_CAPACITY * SPECIES_STAT_METRIC_COUNT ||
        saved.length < 0 ||
        saved.length > SPECIES_SERIES_CAPACITY ||
        saved.start < 0 ||
        saved.start >= SPECIES_SERIES_CAPACITY
      ) {
        throw new StatisticsSnapshotError(
          `species ${saved.speciesId} series snapshot shape is inconsistent`,
        );
      }
      while (this.#speciesSeries.length < saved.speciesId) {
        this.#speciesSeries.push(null);
      }
      this.#speciesSeries[saved.speciesId - 1] = {
        ticks: new Float64Array(saved.ticks),
        values: new Float64Array(saved.values),
        length: saved.length,
        start: saved.start,
      };
    }
  }
}
