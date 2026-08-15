/**
 * Engine benchmark CLI (task L01, docs/07 §9).
 *
 * Usage:
 *   pnpm benchmark:engine [--seed 0xE0A12026] [--population 5000] [--ticks 10000]
 *                         [--warmup-max 200000] [--json]
 *
 * docs/07 §9 specifies exactly what a benchmark run must report: version,
 * runtime/hardware metadata, ticks per second, mean/p50/p95 tick, phase totals,
 * peak population, final hash and estimated memory. All of it is here, and none
 * of it can reach the simulation:
 *
 * - the engine never reads a clock, so the timings come from a host-side
 *   profiler attached through the documented `setProfiler` boundary;
 * - `performance.now()` is called only in this file, between `step()` calls;
 * - the final hash is printed so a benchmark run can be checked against the
 *   headless runner — a fast engine that computes a different world is a
 *   regression, not an optimization.
 *
 * ## `--population` is a warm-up target, not a spawn count
 *
 * There is no way to conjure 5 000 organisms into a world: the population is an
 * ecological outcome. So `--population N` steps the world until it holds at
 * least N live organisms, and only then starts measuring. If the world never
 * reaches N within `--warmup-max` ticks the run says so loudly and measures
 * whatever population it did reach, because a benchmark that silently measured
 * 300 organisms while its header claimed 5 000 would be worse than no benchmark.
 */
import { cpus, totalmem } from "node:os";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  SimulationEngine,
  TICK_PHASE_COUNT,
  TICK_PHASE_NAMES,
  TickPhase,
  type TickPhaseId,
  type TickProfiler,
  estimateEngineMemory,
  formatBytes,
  hashConfig,
  memoryCategories,
} from "@eon/engine";
import { makeFail, parseIntStrict } from "./cliArgs";
import { summarizePopulation } from "./populationStats";

/*
 * The explicit annotation is load-bearing: TypeScript only treats a call as
 * control-flow-terminating when the callee is a name with a declared type, so
 * without it every `if (raw === undefined) fail(...)` below would fail to
 * narrow.
 */
const fail: (message: string) => never = makeFail("benchmark");

const FIXTURE_SEED = 0xe0a12026;

/**
 * Host-side phase profiler for the benchmark.
 *
 * The engine reports phase boundaries and this decides what time it was — the
 * split CLAUDE.md requires. Phases nest (`Total` wraps everything), so each
 * phase keeps its own open timestamp rather than a single stack; a phase that
 * opens twice in one tick (the spatial rebuild does) accumulates both.
 */
class BenchProfiler implements TickProfiler {
  readonly totalMillis = new Float64Array(TICK_PHASE_COUNT);
  readonly calls = new Uint32Array(TICK_PHASE_COUNT);
  readonly #openedAt = new Float64Array(TICK_PHASE_COUNT);

  begin(phase: TickPhaseId): void {
    this.#openedAt[phase] = performance.now();
  }

  end(phase: TickPhaseId): void {
    const elapsed = performance.now() - (this.#openedAt[phase] as number);
    this.totalMillis[phase] = (this.totalMillis[phase] as number) + elapsed;
    this.calls[phase] = (this.calls[phase] as number) + 1;
  }

  reset(): void {
    this.totalMillis.fill(0);
    this.calls.fill(0);
    this.#openedAt.fill(0);
  }
}

interface CliOptions {
  seed: number;
  /** Warm-up target population; 0 measures from tick 0. */
  population: number;
  ticks: number;
  warmupMax: number;
  json: boolean;
}

/**
 * Practical ceiling for a benchmark run, matching the headless runner's guard:
 * a CLI that silently spins forever on a typo is worse than one that refuses.
 */
const MAX_CLI_TICKS = 10_000_000_000;

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    seed: FIXTURE_SEED,
    population: 0,
    ticks: 10_000,
    warmupMax: 200_000,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--seed": {
        const raw = argv[++i];
        if (raw === undefined) fail("--seed requires a value");
        options.seed = parseIntStrict(raw, "seed", fail) >>> 0;
        break;
      }
      case "--population": {
        const raw = argv[++i];
        if (raw === undefined) fail("--population requires a value");
        options.population = parseIntStrict(raw, "population", fail);
        if (options.population < 0) fail("--population must be >= 0");
        break;
      }
      case "--ticks": {
        const raw = argv[++i];
        if (raw === undefined) fail("--ticks requires a value");
        options.ticks = parseIntStrict(raw, "ticks", fail);
        if (options.ticks <= 0) fail("--ticks must be > 0");
        if (options.ticks > MAX_CLI_TICKS) fail(`--ticks must be <= ${MAX_CLI_TICKS}`);
        break;
      }
      case "--warmup-max": {
        const raw = argv[++i];
        if (raw === undefined) fail("--warmup-max requires a value");
        options.warmupMax = parseIntStrict(raw, "warmup-max", fail);
        if (options.warmupMax < 0) fail("--warmup-max must be >= 0");
        if (options.warmupMax > MAX_CLI_TICKS) fail(`--warmup-max must be <= ${MAX_CLI_TICKS}`);
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "usage: pnpm benchmark:engine [--seed 0xE0A12026] [--population 5000] " +
            "[--ticks 10000] [--warmup-max 200000] [--json]",
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return options;
}

/** Percentile of an already-sorted sample, by nearest rank. */
function percentile(sorted: Float64Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] as number;
}

interface BenchmarkResult {
  engineVersion: string;
  configSchemaVersion: number;
  snapshotSchemaVersion: number;
  configHash: string;
  runtime: {
    node: string;
    platform: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryBytes: number;
  };
  seed: number;
  warmup: {
    targetPopulation: number;
    ticks: number;
    reachedTarget: boolean;
    populationAtStart: number;
  };
  measured: {
    ticks: number;
    wallMillis: number;
    ticksPerSecond: number;
    meanTickMillis: number;
    p50TickMillis: number;
    p95TickMillis: number;
    maxTickMillis: number;
  };
  phaseMillis: Record<string, number>;
  population: {
    atStart: number;
    atEnd: number;
    peak: number;
    peakLiveCarcasses: number;
    maxGeneration: number;
    speciesCount: number;
  };
  finalTick: number;
  finalHash: string;
  memory: ReturnType<typeof estimateEngineMemory> & {
    processHeapUsedBytes: number;
    processRssBytes: number;
  };
}

function run(options: CliOptions): BenchmarkResult {
  const engine = new SimulationEngine({ seed: options.seed, config: DEFAULT_CONFIG });

  // --- Warm-up: reach the requested population before measuring anything ----
  let warmupTicks = 0;
  if (options.population > 0) {
    while (
      engine.organisms.liveCount < options.population &&
      warmupTicks < options.warmupMax &&
      engine.organisms.liveCount > 0
    ) {
      engine.step();
      warmupTicks += 1;
    }
  }
  const populationAtStart = engine.organisms.liveCount;
  const reachedTarget = options.population === 0 || populationAtStart >= options.population;

  // --- Measurement ----------------------------------------------------------
  const profiler = new BenchProfiler();
  engine.setProfiler(profiler);

  const tickMillis = new Float64Array(options.ticks);
  let peakPopulation = engine.organisms.liveCount;
  let peakCarcasses = engine.carcasses.liveCount;

  const startedAt = performance.now();
  for (let i = 0; i < options.ticks; i += 1) {
    const tickStart = performance.now();
    engine.step();
    tickMillis[i] = performance.now() - tickStart;
    const live = engine.organisms.liveCount;
    if (live > peakPopulation) peakPopulation = live;
    const carcasses = engine.carcasses.liveCount;
    if (carcasses > peakCarcasses) peakCarcasses = carcasses;
  }
  const wallMillis = performance.now() - startedAt;
  engine.setProfiler(null);

  const sorted = tickMillis.slice().sort();
  let sum = 0;
  for (const value of tickMillis) sum += value;

  const phaseMillis: Record<string, number> = {};
  for (let phase = 0; phase < TICK_PHASE_COUNT; phase += 1) {
    // Two phases are deliberately absent rather than reported as zero.
    // RenderSnapshot is measured by a host that produces snapshots and this
    // benchmark produces none; Total is opened by a host around the whole tick,
    // and here the per-tick wall clock below IS that measurement.
    if (phase === TickPhase.RenderSnapshot || phase === TickPhase.Total) continue;
    phaseMillis[TICK_PHASE_NAMES[phase] as string] = Number(
      (profiler.totalMillis[phase] as number).toFixed(3),
    );
  }

  const stats = summarizePopulation(engine);
  const memory = estimateEngineMemory(engine);
  const processMemory = process.memoryUsage();

  return {
    engineVersion: ENGINE_VERSION,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    configHash: hashConfig(DEFAULT_CONFIG),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    seed: options.seed,
    warmup: {
      targetPopulation: options.population,
      ticks: warmupTicks,
      reachedTarget,
      populationAtStart,
    },
    measured: {
      ticks: options.ticks,
      wallMillis: Number(wallMillis.toFixed(1)),
      ticksPerSecond: Number(((options.ticks * 1000) / Math.max(wallMillis, 1e-6)).toFixed(1)),
      meanTickMillis: Number((sum / options.ticks).toFixed(4)),
      p50TickMillis: Number(percentile(sorted, 0.5).toFixed(4)),
      p95TickMillis: Number(percentile(sorted, 0.95).toFixed(4)),
      maxTickMillis: Number(percentile(sorted, 1).toFixed(4)),
    },
    phaseMillis,
    population: {
      atStart: populationAtStart,
      atEnd: engine.organisms.liveCount,
      peak: peakPopulation,
      peakLiveCarcasses: peakCarcasses,
      maxGeneration: stats.maxGeneration,
      speciesCount: engine.species.count,
    },
    finalTick: engine.tick,
    finalHash: engine.computeStateHash(),
    memory: {
      ...memory,
      processHeapUsedBytes: processMemory.heapUsed,
      processRssBytes: processMemory.rss,
    },
  };
}

function report(result: BenchmarkResult): void {
  console.log(
    `engine        ${result.engineVersion} (config schema ${result.configSchemaVersion}, ` +
      `snapshot schema ${result.snapshotSchemaVersion})`,
  );
  console.log(`config        DEFAULT_CONFIG (hash ${result.configHash})`);
  console.log(
    `runtime       node ${result.runtime.node} ${result.runtime.platform}/${result.runtime.arch}, ` +
      `${result.runtime.cpuCount}x ${result.runtime.cpuModel}, ` +
      `${formatBytes(result.runtime.totalMemoryBytes)} RAM`,
  );
  console.log(`seed          0x${result.seed.toString(16).toUpperCase().padStart(8, "0")}`);

  if (result.warmup.targetPopulation > 0) {
    const verdict = result.warmup.reachedTarget
      ? "reached"
      : `NOT REACHED after ${result.warmup.ticks} ticks — measurements below are for ` +
        `${result.warmup.populationAtStart} organisms, not ${result.warmup.targetPopulation}`;
    console.log(
      `warm-up       target ${result.warmup.targetPopulation} organisms, ` +
        `${result.warmup.ticks} ticks, ${verdict}`,
    );
  }

  console.log("");
  console.log(
    `measured      ${result.measured.ticks} ticks in ${(result.measured.wallMillis / 1000).toFixed(1)}s ` +
      `= ${result.measured.ticksPerSecond} ticks/s`,
  );
  console.log(
    `tick cost     mean ${result.measured.meanTickMillis.toFixed(3)} ms | ` +
      `p50 ${result.measured.p50TickMillis.toFixed(3)} ms | ` +
      `p95 ${result.measured.p95TickMillis.toFixed(3)} ms | ` +
      `max ${result.measured.maxTickMillis.toFixed(3)} ms`,
  );
  console.log(
    `population    start ${result.population.atStart} | end ${result.population.atEnd} | ` +
      `peak ${result.population.peak} | peak carcasses ${result.population.peakLiveCarcasses} | ` +
      `max generation ${result.population.maxGeneration} | species ${result.population.speciesCount}`,
  );
  console.log(`final         tick ${result.finalTick}, hash ${result.finalHash}`);

  console.log("");
  console.log("phase totals over the measured window (ms, and % of measured wall)");
  const entries = Object.entries(result.phaseMillis).sort((a, b) => b[1] - a[1]);
  for (const [name, millis] of entries) {
    const share = (millis / Math.max(result.measured.wallMillis, 1e-6)) * 100;
    console.log(
      `  ${name.padEnd(18)} ${millis.toFixed(1).padStart(12)} ms  ${share.toFixed(1).padStart(5)}%`,
    );
  }

  console.log("");
  console.log("estimated engine memory (docs/07 §11)");
  for (const [name, bytes] of memoryCategories(result.memory.bytes)) {
    console.log(`  ${name.padEnd(18)} ${formatBytes(bytes).padStart(12)}`);
  }
  console.log(`  ${"TOTAL".padEnd(18)} ${formatBytes(result.memory.bytes.total).padStart(12)}`);
  console.log(
    `  ${"per organism slot".padEnd(18)} ` +
      `${formatBytes(Math.round(result.memory.context.bytesPerOrganismSlot)).padStart(12)} ` +
      `x ${result.memory.context.organismCapacity} slots`,
  );
  console.log(
    `  process heap ${formatBytes(result.memory.processHeapUsedBytes)}, ` +
      `RSS ${formatBytes(result.memory.processRssBytes)}`,
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const result = run(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  report(result);
}

main();
