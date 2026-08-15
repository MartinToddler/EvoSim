import { describe, expect, it } from "vitest";
import type { TelemetryDto } from "@eon/protocol";
import { StatsHistory } from "./StatsHistory";

/**
 * The chart-memory contract (task H04, docs/05 §11, docs/07 §11): history is
 * bounded whatever the run length, spans the whole run, and never mutates the
 * DTOs it reads.
 */

function telemetryAt(tick: number, overrides: Partial<TelemetryDto> = {}): TelemetryDto {
  const telemetry: TelemetryDto = {
    tick,
    population: 100 + (tick % 7),
    totalBirths: tick * 2,
    totalDeaths: tick,
    capRejectedBirths: 0,
    deathsByCause: [0, 0, 0, 0, 0, 0, 0, 0],
    carcassCount: 3,
    plantBiomass: 1_000_000 + tick,
    plantCapacity: 2_000_000,
    maxGeneration: 5,
    organismMass: 50_000,
    meanEnergyFraction: 0.5,
    traitMeans: {
      diet: -0.4,
      maxSpeedLUPerTick: 0.3,
      adultRadiusLU: 1.5,
      visionRangeLU: 40,
      attack: 0.2,
      armor: 0.1,
      metabolicPace: 0.5,
      thermalOptimumC: 18,
    },
    activeSpeciesCount: 1,
    totalSpeciesCount: 1,
    extinctSpeciesCount: 0,
    latestEventId: 1,
    pendingCommandCount: 0,
    speed: "x1",
    achievedTicksPerSecond: 20,
    targetTicksPerSecond: 20,
    behindTarget: false,
    renderBuffersInFlight: 1,
    droppedRenderSnapshots: 0,
    phaseMillis: [],
    ...overrides,
  };
  return telemetry;
}

describe("StatsHistory", () => {
  it("stays bounded while spanning the whole run at degrading resolution", () => {
    const history = new StatsHistory(32, 8, 6);
    for (let i = 1; i <= 10_000; i += 1) {
      history.push(telemetryAt(i * 10));
    }
    expect(history.length).toBeLessThanOrEqual(history.capacity);
    expect(history.downsamplePasses).toBeGreaterThan(0);

    const samples = history.samples;
    // The oldest retained sample is still from early in the run: range is
    // preserved, resolution is what degraded (docs/05 §11).
    expect((samples[0]?.tick ?? 0) / 100_000).toBeLessThan(0.1);
    expect(samples[samples.length - 1]?.tick).toBe(100_000);
    // Ticks stay strictly ascending through every tier boundary.
    for (let i = 1; i < samples.length; i += 1) {
      expect((samples[i]?.tick ?? 0) > (samples[i - 1]?.tick ?? 0)).toBe(true);
    }
    // The newest history is raw: the last two samples are adjacent pushes.
    const last = samples[samples.length - 1] as { tick: number };
    const beforeLast = samples[samples.length - 2] as { tick: number };
    expect(last.tick - beforeLast.tick).toBe(10);
  });

  it("holds its hard bound even when the run outlives the coarsest tier", () => {
    const history = new StatsHistory(16, 2, 2);
    for (let i = 1; i <= 5_000; i += 1) {
      history.push(telemetryAt(i * 10));
      expect(history.length).toBeLessThanOrEqual(history.capacity);
    }
    const samples = history.samples;
    for (let i = 1; i < samples.length; i += 1) {
      expect((samples[i]?.tick ?? 0) > (samples[i - 1]?.tick ?? 0)).toBe(true);
    }
    expect(samples[samples.length - 1]?.tick).toBe(50_000);
  });

  it("skips samples whose tick did not advance (paused worlds)", () => {
    const history = new StatsHistory(64);
    history.push(telemetryAt(100));
    history.push(telemetryAt(100));
    history.push(telemetryAt(100));
    expect(history.length).toBe(1);
    history.push(telemetryAt(120));
    expect(history.length).toBe(2);
  });

  it("keeps cumulative counters exact and levels averaged through a merge", () => {
    const history = new StatsHistory(16, 4, 3);
    for (let i = 1; i <= 17; i += 1) {
      history.push(telemetryAt(i * 10, { population: i * 10, totalBirths: i * 20 }));
    }
    // The 17th push overflowed the fine tier: its oldest four samples merged
    // into one coarse sample.
    expect(history.length).toBe(14);
    const first = history.samples[0];
    expect(first?.tick).toBe(40);
    expect(first?.population).toBe(25); // mean of 10, 20, 30, 40
    expect(first?.totalBirths).toBe(80); // last of 20, 40, 60, 80
    // The next sample after the merged one is the raw fifth push.
    expect(history.samples[1]?.tick).toBe(50);
  });

  it("derives rates that survive downsampling", () => {
    const history = new StatsHistory(16, 4, 4);
    // Constant birth rate: 2 births per tick (tick advances 50 per push).
    for (let i = 1; i <= 300; i += 1) {
      history.push(telemetryAt(i * 50));
    }
    const rates = history.rateSeries("totalBirths", 1000);
    expect(rates.length).toBeGreaterThan(0);
    for (const point of rates) {
      expect(point.y).toBeCloseTo(2000, 6);
    }
  });

  it("reads frozen telemetry without mutating it", () => {
    const history = new StatsHistory(64);
    const frozen = telemetryAt(10);
    Object.freeze(frozen);
    Object.freeze(frozen.traitMeans);
    expect(() => {
      history.push(frozen);
    }).not.toThrow();
    expect(frozen.tick).toBe(10);
  });

  it("clears for a new world", () => {
    const history = new StatsHistory(64);
    history.push(telemetryAt(500));
    history.clear();
    expect(history.length).toBe(0);
    // Ticks restart from zero in a new world; the old high-water must not
    // suppress them.
    history.push(telemetryAt(10));
    expect(history.length).toBe(1);
  });

  it("exposes chart series in tick space", () => {
    const history = new StatsHistory(64);
    history.push(telemetryAt(10, { population: 5 }));
    history.push(telemetryAt(30, { population: 7 }));
    expect(history.series("population")).toEqual([
      { x: 10, y: 5 },
      { x: 30, y: 7 },
    ]);
  });
});
