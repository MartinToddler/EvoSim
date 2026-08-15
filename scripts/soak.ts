/**
 * Long-run release soak (task L06, docs/07 §6).
 *
 * Usage:
 *   pnpm soak:long                       # 1 000 000 ticks, the release soak
 *   pnpm soak:long --ticks 200000        # a shorter manual run
 *   pnpm soak:long --check-every 4999    # sweep cadence
 *   pnpm soak:long --json
 *
 * docs/07 §6 asks for 100 000 ticks routinely and 1 000 000 nightly or manually
 * before release. The 100 000-tick run is a Vitest test (`soak.test.ts`) because
 * it fits in `pnpm verify`; this one is a CLI because it does not — an hours-long
 * test inside the gate would make the gate unrunnable, and docs/07 §8 forbids
 * turning a wall clock into a pass/fail signal anyway.
 *
 * Both run the SAME world and the SAME invariant sweep, from
 * `@eon/engine`'s `fixtures/soakWorld`. This process only decides how far to run
 * and how loudly to report; every rule it checks is the rule the short soak
 * checks.
 *
 * What is proven here (docs/07 §6's list):
 *   - no invalid numbers, no count corruption, no ID collision, no dead-entity
 *     leak — the sweep, every `--check-every` ticks rather than once at the end;
 *   - snapshot round trips — serialized at the end, restored, hash compared, and
 *     both continued 500 ticks to prove the restore continues identically;
 *   - repeat hash deterministic — the run prints checkpoint hashes at every
 *     power-of-ten tick, so a second run is comparable line by line without
 *     re-running the whole million.
 *
 * Exit code is 1 if any sweep found a violation or the snapshot did not restore
 * identically, so this is usable as a nightly job.
 */
import {
  ENGINE_VERSION,
  GOLDEN_SOAK_HASH,
  SOAK_CONFIG,
  SOAK_GOLDEN_TICKS,
  SOAK_SEED,
  SimulationEngine,
  checkSoakInvariants,
  deathsByCauseTotal,
  estimateEngineMemory,
  formatBytes,
  hashConfig,
  measureBrainDrift,
  soakIsHealthy,
  engineFromSnapshot,
  totalPlantBiomass,
  totalPlantCapacity,
  type SoakViolations,
} from "@eon/engine";
import { makeFail, parseIntStrict } from "./cliArgs";

/* See `benchmark.ts`: the annotation is what makes `fail` narrow control flow. */
const fail: (message: string) => never = makeFail("soak");

/** docs/07 §6's release length. */
const DEFAULT_TICKS = 1_000_000;

/**
 * Default sweep cadence.
 *
 * Prime, so samples never line up with the 20-tick environment cadence or the
 * 40-tick reproduction cooldown — the same reasoning as the short soak's 997,
 * scaled up because a full sweep at a million ticks would otherwise dominate the
 * run: 1 000 sweeps of the whole population and grid is the budget this trades
 * for ten times the tick count.
 */
const DEFAULT_CHECK_EVERY = 997;

interface CliOptions {
  ticks: number;
  checkEvery: number;
  seed: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    ticks: DEFAULT_TICKS,
    checkEvery: DEFAULT_CHECK_EVERY,
    seed: SOAK_SEED,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--ticks": {
        const raw = argv[++i];
        if (raw === undefined) fail("--ticks requires a value");
        options.ticks = parseIntStrict(raw, "ticks", fail);
        if (options.ticks <= 0) fail("--ticks must be > 0");
        break;
      }
      case "--check-every": {
        const raw = argv[++i];
        if (raw === undefined) fail("--check-every requires a value");
        options.checkEvery = parseIntStrict(raw, "check-every", fail);
        if (options.checkEvery <= 0) fail("--check-every must be > 0");
        break;
      }
      case "--seed": {
        const raw = argv[++i];
        if (raw === undefined) fail("--seed requires a value");
        options.seed = parseIntStrict(raw, "seed", fail) >>> 0;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "usage: pnpm soak:long [--ticks 1000000] [--check-every 997] [--seed 0xE0A12026] [--json]",
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

interface Checkpoint {
  tick: number;
  population: number;
  hash: string;
  maxGeneration: number;
  carcasses: number;
  speciesActive: number;
  wallSeconds: number;
}

interface SoakReport {
  engineVersion: string;
  configHash: string;
  seed: number;
  ticks: number;
  checkEvery: number;
  sweeps: number;
  healthy: boolean;
  firstViolation: { tick: number; violations: SoakViolations } | null;
  peakPopulation: number;
  troughPopulation: number;
  peakGeneration: number;
  finalPopulation: number;
  totalBirths: number;
  totalDeaths: number;
  deathsAttributed: boolean;
  entityIdsMonotonic: boolean;
  biomassWithinCapacity: boolean;
  brainMeanSimilarity: number;
  brainClampedFraction: number;
  snapshotRoundTrips: boolean;
  snapshotContinuesIdentically: boolean;
  /**
   * Whether this run passed {@link SOAK_GOLDEN_TICKS} and reproduced the hash
   * the Vitest soak asserts; null when it did not reach that tick, or ran a
   * different seed. This is what makes the long soak provably the short soak at
   * scale rather than a similar run.
   */
  reproducedGoldenHash: boolean | null;
  checkpoints: Checkpoint[];
  finalHash: string;
  engineBytes: number;
  wallSeconds: number;
}

/**
 * Checkpoint ticks: every power of ten up to the run length, plus the end.
 *
 * Powers of ten rather than a fixed stride so a 200 000-tick manual run and a
 * 1 000 000-tick release run print comparable lines, and so a mismatch between
 * two runs can be bisected in a handful of steps.
 */
function checkpointTicks(ticks: number): number[] {
  const points: number[] = [];
  for (let power = 1; power < ticks; power *= 10) {
    points.push(power);
  }
  points.push(ticks);
  return points;
}

function run(options: CliOptions): SoakReport {
  const engine = new SimulationEngine({ seed: options.seed, config: SOAK_CONFIG });
  const { organisms, environment } = engine;
  const capacity = totalPlantCapacity(environment);
  const seenIds = new Set<number>();

  const startedAt = performance.now();
  const pendingCheckpoints = checkpointTicks(options.ticks);
  const checkpoints: Checkpoint[] = [];

  let peakPopulation = organisms.liveCount;
  let troughPopulation = organisms.liveCount;
  let peakGeneration = 0;
  let sweeps = 0;
  let firstViolation: SoakReport["firstViolation"] = null;
  let reproducedGoldenHash: boolean | null = null;

  // Next tick a sweep is due at, tracked rather than derived from `tick %
  // checkEvery`: a checkpoint lands the engine on an arbitrary tick, and a
  // modulo would then sweep twice in quick succession around every multiple.
  let nextSweep = Math.min(options.checkEvery, options.ticks);

  while (engine.tick < options.ticks) {
    // Stop at whichever comes first: the next sweep, or the next checkpoint.
    // Neither may be skipped, and a sweep that ran "near" a checkpoint would
    // report a hash for a tick nobody asked about.
    const nextCheckpoint = pendingCheckpoints[0];
    let target = Math.min(options.ticks, nextSweep);
    if (nextCheckpoint !== undefined && nextCheckpoint < target) {
      target = nextCheckpoint;
    }
    engine.stepMany(target - engine.tick);
    if (engine.tick >= nextSweep) {
      nextSweep = Math.min(engine.tick + options.checkEvery, options.ticks);
    }

    const violations = checkSoakInvariants(engine, seenIds);
    sweeps += 1;
    if (!soakIsHealthy(violations) && firstViolation === null) {
      firstViolation = { tick: engine.tick, violations };
      console.error(`soak: VIOLATION at tick ${engine.tick}: ${JSON.stringify(violations)}`);
    }

    const live = organisms.liveCount;
    peakPopulation = Math.max(peakPopulation, live);
    troughPopulation = Math.min(troughPopulation, live);
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] === 1) {
        const generation = organisms.generation[slot] as number;
        if (generation > peakGeneration) peakGeneration = generation;
      }
    }

    if (nextCheckpoint !== undefined && engine.tick >= nextCheckpoint) {
      pendingCheckpoints.shift();
      const checkpoint: Checkpoint = {
        tick: engine.tick,
        population: live,
        hash: engine.computeStateHash(),
        maxGeneration: peakGeneration,
        carcasses: engine.carcasses.liveCount,
        speciesActive: engine.species.activeCount,
        wallSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)),
      };
      checkpoints.push(checkpoint);
      // The 100 000-tick checkpoint is the Vitest soak's finish line. Comparing
      // it here costs nothing and turns "these two runs look alike" into
      // "these two runs are the same run".
      if (checkpoint.tick === SOAK_GOLDEN_TICKS && options.seed === SOAK_SEED) {
        reproducedGoldenHash = checkpoint.hash === GOLDEN_SOAK_HASH;
        if (!reproducedGoldenHash) {
          console.error(
            `soak: hash at tick ${SOAK_GOLDEN_TICKS} is ${checkpoint.hash}, ` +
              `expected ${GOLDEN_SOAK_HASH}`,
          );
        }
      }
      if (!options.json) {
        console.log(
          `tick ${String(checkpoint.tick).padStart(9)} | pop ${String(checkpoint.population).padStart(5)}` +
            ` | gen ${String(checkpoint.maxGeneration).padStart(4)}` +
            ` | carrion ${String(checkpoint.carcasses).padStart(5)}` +
            ` | species ${String(checkpoint.speciesActive).padStart(3)}` +
            ` | ${checkpoint.hash} | ${checkpoint.wallSeconds}s`,
        );
      }
    }

    // A world that went extinct stops testing anything; say so rather than
    // burning the remaining ticks on an empty grid.
    if (live === 0) {
      console.error(`soak: population reached zero at tick ${engine.tick}; stopping`);
      break;
    }
  }

  const finalHash = engine.computeStateHash();
  const drift = measureBrainDrift(engine);
  const biomass = totalPlantBiomass(environment);
  // Read every reported figure BEFORE the continuation check below steps the
  // engine another 500 ticks — otherwise the report would describe a world 500
  // ticks past the one whose hash it prints.
  const finalPopulation = organisms.liveCount;
  const totalBirths = organisms.totalBirths;
  const totalDeaths = organisms.totalDeaths;
  const deathsAttributed = deathsByCauseTotal(engine) === totalDeaths;
  const entityIdsMonotonic = organisms.nextEntityId === totalBirths + 1;
  const engineBytes = estimateEngineMemory(engine).bytes.total;

  // Snapshot round trip, and — the part a hash at the snapshot tick cannot
  // prove — that the restored world CONTINUES identically.
  const restored = engineFromSnapshot(engine.serialize());
  const snapshotRoundTrips = restored.computeStateHash() === finalHash;
  restored.stepMany(500);
  engine.stepMany(500);
  const snapshotContinuesIdentically = restored.computeStateHash() === engine.computeStateHash();

  return {
    engineVersion: ENGINE_VERSION,
    configHash: hashConfig(SOAK_CONFIG),
    seed: options.seed,
    ticks: options.ticks,
    checkEvery: options.checkEvery,
    sweeps,
    healthy: firstViolation === null,
    firstViolation,
    peakPopulation,
    troughPopulation,
    peakGeneration,
    finalPopulation,
    totalBirths,
    totalDeaths,
    deathsAttributed,
    entityIdsMonotonic,
    biomassWithinCapacity: biomass >= 0 && biomass <= capacity,
    brainMeanSimilarity: Number(drift.meanSimilarity.toFixed(4)),
    brainClampedFraction: Number(drift.clampedFraction.toFixed(6)),
    snapshotRoundTrips,
    snapshotContinuesIdentically,
    reproducedGoldenHash,
    checkpoints,
    finalHash,
    engineBytes,
    wallSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)),
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.json) {
    console.log(`engine     ${ENGINE_VERSION}`);
    console.log(`world      soak (96x96, 64 founders), config hash ${hashConfig(SOAK_CONFIG)}`);
    console.log(
      `run        seed 0x${options.seed.toString(16).toUpperCase().padStart(8, "0")}, ` +
        `${options.ticks} ticks, invariant sweep every ${options.checkEvery}`,
    );
    console.log("");
  }

  const report = run(options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("");
    console.log(`sweeps          ${report.sweeps}, all clean: ${report.healthy}`);
    console.log(
      `population      final ${report.finalPopulation} | peak ${report.peakPopulation} | ` +
        `trough ${report.troughPopulation} | max generation ${report.peakGeneration}`,
    );
    console.log(
      `lineage         ${report.totalBirths} births, ${report.totalDeaths} deaths, ` +
        `attribution ${report.deathsAttributed ? "complete" : "BROKEN"}, ` +
        `entity IDs ${report.entityIdsMonotonic ? "monotonic" : "BROKEN"}`,
    );
    console.log(
      `brains          mean similarity to founder ${report.brainMeanSimilarity}, ` +
        `${(report.brainClampedFraction * 100).toFixed(4)}% of weights on the clamp`,
    );
    console.log(
      `snapshot        round trip ${report.snapshotRoundTrips ? "exact" : "MISMATCH"}, ` +
        `continuation ${report.snapshotContinuesIdentically ? "identical" : "MISMATCH"}`,
    );
    console.log(
      `golden          tick ${SOAK_GOLDEN_TICKS}: ` +
        (report.reproducedGoldenHash === null
          ? "not reached by this run"
          : report.reproducedGoldenHash
            ? `reproduced ${GOLDEN_SOAK_HASH}`
            : "MISMATCH"),
    );
    console.log(`memory          ${formatBytes(report.engineBytes)} engine total`);
    console.log(`final hash      ${report.finalHash}`);
    console.log(`wall            ${(report.wallSeconds / 60).toFixed(1)} min`);
  }

  const failed =
    report.reproducedGoldenHash === false ||
    !report.healthy ||
    !report.snapshotRoundTrips ||
    !report.snapshotContinuesIdentically ||
    !report.deathsAttributed ||
    !report.entityIdsMonotonic ||
    !report.biomassWithinCapacity;
  if (failed) {
    console.error("soak: FAILED — see the report above");
    process.exit(1);
  }
}

main();
