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
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  CONFIG_SCHEMA_VERSION,
  SimulationEngine,
  hashConfig,
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

function parseIntStrict(raw: string, name: string): number {
  const value =
    raw.startsWith("0x") || raw.startsWith("0X")
      ? Number.parseInt(raw, 16)
      : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    fail(`invalid ${name}: ${raw}`);
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
        options.seed = parseIntStrict(raw, "seed") >>> 0;
        break;
      }
      case "--ticks": {
        const raw = argv[++i];
        if (raw === undefined) fail("--ticks requires a value");
        const ticks = parseIntStrict(raw, "ticks");
        if (ticks < 0) fail("--ticks must be >= 0");
        options.ticks = ticks;
        break;
      }
      case "--checkpoints": {
        const raw = argv[++i];
        if (raw === undefined) fail("--checkpoints requires a comma-separated list");
        options.checkpoints = raw.split(",").map((part) => {
          const tick = parseIntStrict(part.trim(), "checkpoint");
          if (tick < 0) fail(`checkpoint must be >= 0: ${part}`);
          return tick;
        });
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

  console.log(`final tick ${engine.tick}`);
  console.log(`final hash ${engine.computeStateHash()}`);
  console.log(`wall time  ${elapsedMs.toFixed(1)} ms (diagnostic only, outside engine)`);
}

main();
