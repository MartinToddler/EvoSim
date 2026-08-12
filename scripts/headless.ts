/**
 * Headless engine runner (task B07, docs/10 §19).
 *
 * Runs the pure engine in Node without any rendering and prints canonical
 * state hashes — the primary tool for golden fixture generation and
 * determinism spot checks.
 *
 * Usage:
 *   pnpm headless [--seed 0xE0A12026] [--ticks 10000] [--checkpoints 0,1,10,100,1000,10000]
 *
 * Wall-clock timing printed at the end is diagnostic output only; it never
 * influences the simulation (engine purity rules).
 */
import {
  BIOME_COUNT,
  BIOME_NAMES,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  CONFIG_SCHEMA_VERSION,
  SimulationEngine,
  hashConfig,
  totalPlantBiomass,
  totalPlantCapacity,
} from "@eon/engine";

interface CliOptions {
  seed: number;
  ticks: number;
  checkpoints: number[];
}

const FIXTURE_SEED = 0xe0a12026;

function fail(message: string): never {
  console.error(`headless: ${message}`);
  process.exit(1);
}

const DECIMAL_PATTERN = /^-?\d+$/;
const HEX_PATTERN = /^0[xX][0-9a-fA-F]+$/;

/**
 * Strictly parse a CLI integer.
 *
 * `Number.parseInt` is deliberately NOT trusted on its own: it accepts trailing
 * garbage ("100abc" -> 100) and silently truncates ("1.5" -> 1). This CLI feeds
 * golden fixtures, benchmarks and sweeps, so malformed input must fail loudly
 * rather than quietly run a different experiment than the operator asked for.
 */
function parseIntStrict(raw: string, name: string): number {
  const isHex = HEX_PATTERN.test(raw);
  if (!isHex && !DECIMAL_PATTERN.test(raw)) {
    fail(`invalid ${name}: ${JSON.stringify(raw)} is not an integer (use 123 or 0x7B)`);
  }
  const value = isHex ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    fail(`invalid ${name}: ${raw} is outside the safe integer range`);
  }
  return value;
}

/**
 * Practical ceiling for a single headless run.
 *
 * The engine allows ticks up to MAX_TICK (2^53-1), but a run of that length
 * would never finish; a CLI that silently spins forever on a typo is worse than
 * one that refuses. Ten billion ticks is far beyond any real fixture or soak
 * run (docs/07 §6 asks for 1M) while still catching fat-finger input.
 */
const MAX_CLI_TICKS = 10_000_000_000;

function checkTickBound(value: number, name: string): number {
  if (value < 0) {
    fail(`${name} must be >= 0, got ${value}`);
  }
  if (value > MAX_CLI_TICKS) {
    fail(`${name} must not exceed ${MAX_CLI_TICKS} for a single run, got ${value}`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { seed: FIXTURE_SEED, ticks: 10_000, checkpoints: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--seed": {
        const raw = argv[++i];
        if (raw === undefined) fail("--seed requires a value");
        const seed = parseIntStrict(raw, "seed");
        // The engine coerces seeds with >>> 0; rejecting out-of-range values
        // here keeps "the seed I typed" and "the seed that ran" identical.
        if (seed < 0 || seed > 0xffffffff) {
          fail(`--seed must be a uint32 in [0, 4294967295], got ${seed}`);
        }
        options.seed = seed;
        break;
      }
      case "--ticks": {
        const raw = argv[++i];
        if (raw === undefined) fail("--ticks requires a value");
        options.ticks = checkTickBound(parseIntStrict(raw, "ticks"), "--ticks");
        break;
      }
      case "--checkpoints": {
        const raw = argv[++i];
        if (raw === undefined) fail("--checkpoints requires a comma-separated list");
        options.checkpoints = raw
          .split(",")
          .map((part) => checkTickBound(parseIntStrict(part.trim(), "checkpoint"), "checkpoint"));
        break;
      }
      case "--help":
      case "-h":
        console.log(
          "usage: pnpm headless [--seed <int|0xHEX>] [--ticks <n>] [--checkpoints t0,t1,...]",
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * World summary after generation (docs/10 §26: a headless command should be
 * able to show that the simulation is real without any rendering).
 */
function printWorldSummary(engine: SimulationEngine): void {
  const { environment, founderRegion } = engine;
  const counts = new Array<number>(BIOME_COUNT).fill(0);
  for (let i = 0; i < environment.cellCount; i += 1) {
    const biome = environment.biome[i] as number;
    counts[biome] = (counts[biome] ?? 0) + 1;
  }

  const landCells = environment.cellCount - (counts[0] as number);

  console.log(
    `world      ${environment.size}x${environment.size} cells, generation attempt ${engine.generationAttempt}`,
  );
  console.log(
    `land       ${((landCells / environment.cellCount) * 100).toFixed(1)}%  biomes ` +
      counts
        .map(
          (count, biome) =>
            `${BIOME_NAMES[biome]}=${((count / environment.cellCount) * 100).toFixed(1)}%`,
        )
        .join(" "),
  );
  printPlantTotals(engine, "plants    ");
  console.log(
    `founders   cell ${founderRegion.centerCellIndex} at (${founderRegion.centerGridX}, ` +
      `${founderRegion.centerGridY}) in a ${founderRegion.componentCells}-cell landmass`,
  );
}

/**
 * Plant capacity and current biomass.
 *
 * Printed twice when a run advances the world: the summary above describes the
 * world as generated, and biomass is the one line in it that a run changes. A
 * diagnostic that showed tick-0 biomass under a "ticks 10000" header would be
 * describing a state nobody asked about.
 */
function printPlantTotals(engine: SimulationEngine, label: string): void {
  const capacity = totalPlantCapacity(engine.environment);
  const biomass = totalPlantBiomass(engine.environment);
  console.log(
    `${label} capacity ${(capacity / 1e6).toFixed(1)}M, biomass ${(biomass / 1e6).toFixed(1)}M ` +
      `(${capacity > 0 ? ((biomass / capacity) * 100).toFixed(1) : "0.0"}% of capacity)`,
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const checkpoints = [...new Set(options.checkpoints)].sort((a, b) => a - b);
  const lastCheckpoint =
    checkpoints.length > 0 ? (checkpoints[checkpoints.length - 1] as number) : 0;
  const totalTicks = Math.max(options.ticks, lastCheckpoint);

  console.log(
    `engine     ${ENGINE_VERSION} (snapshot schema ${SNAPSHOT_SCHEMA_VERSION}, config schema ${CONFIG_SCHEMA_VERSION})`,
  );
  console.log(
    `seed       0x${options.seed.toString(16).toUpperCase().padStart(8, "0")} (${options.seed})`,
  );
  console.log(`config     DEFAULT_CONFIG (hash ${hashConfig(DEFAULT_CONFIG)})`);
  console.log(`ticks      ${totalTicks}`);

  const engine = new SimulationEngine({ seed: options.seed, config: DEFAULT_CONFIG });
  printWorldSummary(engine);

  const startedAt = performance.now();
  let nextCheckpointIndex = 0;

  const reportCheckpoint = (): void => {
    while (
      nextCheckpointIndex < checkpoints.length &&
      checkpoints[nextCheckpointIndex] === engine.tick
    ) {
      console.log(
        `hash @ tick ${String(engine.tick).padStart(6, " ")}: ${engine.computeStateHash()}`,
      );
      nextCheckpointIndex += 1;
    }
  };

  reportCheckpoint();
  for (let t = 0; t < totalTicks; t += 1) {
    engine.step();
    reportCheckpoint();
  }
  const elapsedMs = performance.now() - startedAt;

  if (totalTicks > 0) {
    printPlantTotals(engine, `plants @${totalTicks}`);
  }
  console.log(`final tick ${engine.tick}`);
  console.log(`final hash ${engine.computeStateHash()}`);
  console.log(`wall time  ${elapsedMs.toFixed(1)} ms (diagnostic only, outside engine)`);
}

main();
