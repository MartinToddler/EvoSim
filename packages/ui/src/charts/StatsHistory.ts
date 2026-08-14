import type { TelemetryDto } from "@eon/protocol";

/**
 * Bounded time series over the telemetry stream (task H04, docs/05 §§10-11,
 * docs/06 §§15, 31).
 *
 * ## Why this exists
 *
 * Charts need history; telemetry is a stream of "now". Something has to
 * accumulate — and docs/05 §11 is explicit that it must not accumulate raw
 * samples forever, and docs/07 §11 lists "unbounded stats" as a memory bug
 * class. This class is that bound.
 *
 * ## The bounding rule: multiresolution tiers (docs/05 §11)
 *
 * Samples land in the finest tier. When a tier overflows, its *oldest*
 * `aggregationFactor` samples are merged into one sample of the next tier up —
 * levels take the group mean, cumulative counters take the group's last value,
 * and the merged sample sits at the group's last tick. Recent history is
 * always raw; older history gets geometrically coarser; nothing ever falls off
 * the left edge. Only the oldest samples of a tier are ever merged, so a
 * bucket's resolution is decided once — this is what keeps early history at a
 * fixed (coarse) resolution instead of endlessly re-merging it into a single
 * point.
 *
 * Retention is `bucketsPerTier × maxTiers` samples, a hard bound: if the run
 * outlives even the coarsest tier, that tier compacts itself. With the
 * defaults (240 × 6, factor 8) the coarsest tier is only reached after
 * 240·8⁵ ≈ 7.9 million fine samples — about six weeks of continuous 2 Hz
 * telemetry.
 *
 * ## The x-axis is the tick, never the sample index
 *
 * Telemetry arrives on a wall-clock cadence, so one sample can span 10 ticks
 * at 1× and 5 000 at MAX (ADR 0010 §6). Samples therefore record their tick
 * and charts must plot against it; plotting against index would stretch MAX
 * runs and squash pauses. Samples whose tick did not advance (paused worlds
 * re-reporting) are skipped outright rather than plotted as duplicates.
 *
 * ## Reads, not references
 *
 * `push` copies the scalar fields it needs out of the DTO and never stores or
 * mutates the DTO itself, so a frozen telemetry object works and no chart can
 * write back into transport state.
 */

/** One accumulated point. All values are as defined on `TelemetryDto`. */
export interface StatsSample {
  tick: number;
  population: number;
  carcassCount: number;
  plantBiomass: number;
  organismMass: number;
  meanEnergyFraction: number;
  /** Cumulative counters, so rates can be derived between any two samples. */
  totalBirths: number;
  totalDeaths: number;
  /** Selected trait means (docs/05 §10 "selected mean traits"). */
  meanDiet: number;
  meanSpeedLUPerTick: number;
  meanVisionLU: number;
  meanAdultRadiusLU: number;
}

/** A polyline point: x is the authoritative tick, y the plotted value. */
export interface SeriesPoint {
  x: number;
  y: number;
}

/** Merge a group into one sample: mean levels, last counters, last tick. */
function aggregate(group: readonly StatsSample[]): StatsSample {
  const last = group[group.length - 1] as StatsSample;
  let population = 0;
  let carcassCount = 0;
  let plantBiomass = 0;
  let organismMass = 0;
  let meanEnergyFraction = 0;
  let meanDiet = 0;
  let meanSpeed = 0;
  let meanVision = 0;
  let meanRadius = 0;
  for (const sample of group) {
    population += sample.population;
    carcassCount += sample.carcassCount;
    plantBiomass += sample.plantBiomass;
    organismMass += sample.organismMass;
    meanEnergyFraction += sample.meanEnergyFraction;
    meanDiet += sample.meanDiet;
    meanSpeed += sample.meanSpeedLUPerTick;
    meanVision += sample.meanVisionLU;
    meanRadius += sample.meanAdultRadiusLU;
  }
  const n = group.length;
  return {
    tick: last.tick,
    population: population / n,
    carcassCount: carcassCount / n,
    plantBiomass: plantBiomass / n,
    organismMass: organismMass / n,
    meanEnergyFraction: meanEnergyFraction / n,
    totalBirths: last.totalBirths,
    totalDeaths: last.totalDeaths,
    meanDiet: meanDiet / n,
    meanSpeedLUPerTick: meanSpeed / n,
    meanVisionLU: meanVision / n,
    meanAdultRadiusLU: meanRadius / n,
  };
}

export class StatsHistory {
  /** Samples a tier holds before its oldest are promoted upward. */
  readonly bucketsPerTier: number;
  /** How many fine samples merge into one coarse one. */
  readonly aggregationFactor: number;
  /** Hard ceiling on tier count; the coarsest tier self-compacts past it. */
  readonly maxTiers: number;

  /** `#tiers[0]` is the finest (newest); higher indices are coarser (older). */
  #tiers: StatsSample[][] = [[]];
  #promotions = 0;
  #lastTick = -1;

  constructor(bucketsPerTier = 240, aggregationFactor = 8, maxTiers = 6) {
    if (!Number.isSafeInteger(bucketsPerTier) || bucketsPerTier < aggregationFactor * 2) {
      throw new Error(
        `stats history needs at least ${aggregationFactor * 2} buckets per tier, ` +
          `got ${bucketsPerTier}`,
      );
    }
    if (!Number.isSafeInteger(aggregationFactor) || aggregationFactor < 2) {
      throw new Error(
        `aggregation factor must be an integer of at least 2, got ${aggregationFactor}`,
      );
    }
    if (!Number.isSafeInteger(maxTiers) || maxTiers < 1) {
      throw new Error(`stats history needs at least one tier, got ${maxTiers}`);
    }
    this.bucketsPerTier = bucketsPerTier;
    this.aggregationFactor = aggregationFactor;
    this.maxTiers = maxTiers;
  }

  /** Hard memory bound: the buffer can never exceed this many samples. */
  get capacity(): number {
    return this.bucketsPerTier * this.maxTiers;
  }

  get length(): number {
    let total = 0;
    for (const tier of this.#tiers) {
      total += tier.length;
    }
    return total;
  }

  /** How many promote/compact merges have happened. Diagnostic and tests. */
  get downsamplePasses(): number {
    return this.#promotions;
  }

  /** The retained samples, oldest first. Callers must treat this as read-only. */
  get samples(): readonly StatsSample[] {
    const ordered: StatsSample[] = [];
    for (let tier = this.#tiers.length - 1; tier >= 0; tier -= 1) {
      ordered.push(...(this.#tiers[tier] as StatsSample[]));
    }
    return ordered;
  }

  /** Record one telemetry frame. Frames whose tick did not advance are skipped. */
  push(telemetry: TelemetryDto): void {
    if (telemetry.tick <= this.#lastTick) {
      return;
    }
    this.#lastTick = telemetry.tick;
    (this.#tiers[0] as StatsSample[]).push({
      tick: telemetry.tick,
      population: telemetry.population,
      carcassCount: telemetry.carcassCount,
      plantBiomass: telemetry.plantBiomass,
      organismMass: telemetry.organismMass,
      meanEnergyFraction: telemetry.meanEnergyFraction,
      totalBirths: telemetry.totalBirths,
      totalDeaths: telemetry.totalDeaths,
      meanDiet: telemetry.traitMeans.diet,
      meanSpeedLUPerTick: telemetry.traitMeans.maxSpeedLUPerTick,
      meanVisionLU: telemetry.traitMeans.visionRangeLU,
      meanAdultRadiusLU: telemetry.traitMeans.adultRadiusLU,
    });
    this.#settle();
  }

  /** Forget everything, e.g. when a new world replaces the old one. */
  clear(): void {
    this.#tiers = [[]];
    this.#lastTick = -1;
    this.#promotions = 0;
  }

  /** Extract one level-valued field as chart points, oldest first. */
  series(field: keyof Omit<StatsSample, "tick">): SeriesPoint[] {
    return this.samples.map((sample) => ({ x: sample.tick, y: sample[field] }));
  }

  /**
   * Per-tick rate of a cumulative counter, scaled to events per `perTicks`.
   *
   * Derived between consecutive samples, so it works across tier boundaries
   * and at every resolution. One fewer point than the buffer holds.
   */
  rateSeries(field: "totalBirths" | "totalDeaths", perTicks: number): SeriesPoint[] {
    const samples = this.samples;
    const points: SeriesPoint[] = [];
    for (let i = 1; i < samples.length; i += 1) {
      const previous = samples[i - 1] as StatsSample;
      const current = samples[i] as StatsSample;
      const ticks = current.tick - previous.tick;
      if (ticks <= 0) {
        continue;
      }
      points.push({
        x: current.tick,
        y: ((current[field] - previous[field]) * perTicks) / ticks,
      });
    }
    return points;
  }

  /** Promote overflow up the tiers; compact the top tier at the ceiling. */
  #settle(): void {
    for (let tier = 0; tier < this.#tiers.length; tier += 1) {
      const samples = this.#tiers[tier] as StatsSample[];
      if (samples.length <= this.bucketsPerTier) {
        continue;
      }
      const group = samples.splice(0, this.aggregationFactor);
      const merged = aggregate(group);
      this.#promotions += 1;
      if (tier + 1 < this.maxTiers) {
        if (this.#tiers.length === tier + 1) {
          this.#tiers.push([]);
        }
        // Promotion always takes a tier's oldest samples, so the merged sample
        // is newer than everything already in the coarser tier: appending
        // keeps every tier — and therefore `samples` — in ascending tick order.
        (this.#tiers[tier + 1] as StatsSample[]).push(merged);
      } else {
        // The run outlived the coarsest tier. Self-compact: the merged sample
        // rejoins this tier at the front, shrinking it by factor−1. The very
        // oldest history keeps coarsening in place, and the bound holds
        // forever.
        samples.unshift(merged);
      }
    }
  }
}
