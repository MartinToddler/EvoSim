import { describe, expect, it } from "vitest";
import {
  SPECIES_SERIES_CAPACITY,
  SPECIES_STAT_METRIC_COUNT,
  STATS_TIER_CAPACITY,
  STATS_TIER_RATIO,
  SpeciesStatMetric,
  StatisticsStore,
  WORLD_STAT_METRIC_COUNT,
  WorldStatMetric,
} from "./StatisticsStore";

/**
 * Multiresolution statistics retention (docs/05 §11): bounded memory, correct
 * per-kind aggregation, chronological extraction, exact serialization.
 */

function worldSample(population: number, births: number): number[] {
  const values = new Array<number>(WORLD_STAT_METRIC_COUNT).fill(0);
  values[WorldStatMetric.Population] = population;
  values[WorldStatMetric.BirthsInterval] = births;
  values[WorldStatMetric.ExtinctSpecies] = Math.trunc(population / 100);
  return values;
}

describe("world tiers", () => {
  it("keeps raw samples until the tier fills, then aggregates the oldest upward", () => {
    const stats = new StatisticsStore();
    for (let i = 0; i < STATS_TIER_CAPACITY; i += 1) {
      stats.pushWorldSample(i * 100, worldSample(100 + i, 2));
    }
    let series = stats.worldSeries(WorldStatMetric.Population);
    expect(series.ticks).toHaveLength(STATS_TIER_CAPACITY);
    expect(series.ticks[0]).toBe(0);

    // One more sample promotes the ten oldest into one tier-1 bucket.
    stats.pushWorldSample(STATS_TIER_CAPACITY * 100, worldSample(999, 5));
    series = stats.worldSeries(WorldStatMetric.Population);
    expect(series.ticks).toHaveLength(STATS_TIER_CAPACITY - STATS_TIER_RATIO + 2);
    // The first extracted point is the aggregate: mean population of samples
    // 0..9 (100..109 -> trunc mean 104), stamped with the group's LAST tick.
    expect(series.ticks[0]).toBe(900);
    expect(series.values[0]).toBe(104);

    // Interval counters SUM across the group instead of averaging.
    const births = stats.worldSeries(WorldStatMetric.BirthsInterval);
    expect(births.values[0]).toBe(2 * STATS_TIER_RATIO);
    // Cumulative levels take the LAST value of the group.
    const extinct = stats.worldSeries(WorldStatMetric.ExtinctSpecies);
    expect(extinct.values[0]).toBe(Math.trunc(109 / 100));
  });

  it("total retention is bounded whatever the sample count", () => {
    const stats = new StatisticsStore();
    for (let i = 0; i < 30_000; i += 1) {
      stats.pushWorldSample(i * 100, worldSample(50, 1));
    }
    const series = stats.worldSeries(WorldStatMetric.Population);
    expect(series.ticks.length).toBeLessThanOrEqual(3 * STATS_TIER_CAPACITY);
    // Chronological: strictly increasing ticks across the tier boundary.
    for (let i = 1; i < series.ticks.length; i += 1) {
      expect(series.ticks[i]).toBeGreaterThan(series.ticks[i - 1] as number);
    }
    expect(stats.worldSampleCount).toBe(30_000);
  });
});

describe("species series ring", () => {
  it("keeps the newest SPECIES_SERIES_CAPACITY samples in order", () => {
    const stats = new StatisticsStore();
    const total = SPECIES_SERIES_CAPACITY + 25;
    for (let i = 0; i < total; i += 1) {
      const values = new Array<number>(SPECIES_STAT_METRIC_COUNT).fill(0);
      values[SpeciesStatMetric.Population] = i;
      stats.pushSpeciesSample(3, i * 100, values);
    }
    const series = stats.speciesSeries(3, SpeciesStatMetric.Population);
    expect(series.ticks).toHaveLength(SPECIES_SERIES_CAPACITY);
    expect(series.ticks[0]).toBe(25 * 100);
    expect(series.values.at(-1)).toBe(total - 1);
    // A species that never sampled reads as empty, not as an error.
    expect(stats.speciesSeries(1, SpeciesStatMetric.Population).ticks).toEqual([]);
  });
});

describe("serialization", () => {
  it("capture/restore round-trips exactly, including ring positions", () => {
    const stats = new StatisticsStore();
    for (let i = 0; i < 2_600; i += 1) {
      stats.pushWorldSample(i * 100, worldSample(60 + (i % 7), i % 3));
      if (i % 2 === 0) {
        const values = new Array<number>(SPECIES_STAT_METRIC_COUNT).fill(i % 11);
        stats.pushSpeciesSample(2, i * 100, values);
      }
    }
    const snapshot = stats.capture();
    const restored = new StatisticsStore();
    restored.restore(snapshot);
    expect(restored.capture()).toEqual(snapshot);

    // Continued sampling after restore behaves exactly like the original.
    stats.pushWorldSample(999_999, worldSample(42, 1));
    restored.pushWorldSample(999_999, worldSample(42, 1));
    expect(restored.capture()).toEqual(stats.capture());
  });
});
