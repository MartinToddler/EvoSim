/**
 * Multi-seed parameter sweep harness (task E08, docs/07 §14).
 *
 * docs/07 §14's rule is the point of this tool: "Run 10-30 seeds for important
 * tuning conclusions. Do not tune from one lucky seed." A single seed can starve,
 * boom, crash or coast for reasons that have nothing to do with the parameter
 * under test, so any calibration claim has to be a distribution.
 *
 * Usage:
 *   pnpm sweep --seeds 1,2,3 --ticks 20000
 *   pnpm sweep --config experiments/mutation-rate.json
 *   pnpm sweep --seeds 1,2,3 --ticks 20000 --set mutation.brain.perWeightMutationProbabilityQ=164
 *   pnpm sweep --seeds 1,2,3 --ticks 20000 --csv
 *
 * An experiment file is JSON:
 *   {
 *     "name": "mutation-rate",
 *     "seeds": [1, 2, 3],
 *     "ticks": 20000,
 *     "variants": [
 *       { "label": "baseline", "set": {} },
 *       { "label": "double-brain", "set": { "mutation.brain.perWeightMutationProbabilityQ": 164 } }
 *     ]
 *   }
 *
 * Every number printed is derived, never authoritative. Wall-clock timings are
 * diagnostics that live entirely outside the engine (engine purity rules).
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  Q,
  type SimulationConfig,
  SimulationEngine,
  cloneConfig,
  hashConfig,
  totalPlantBiomass,
  totalPlantCapacity,
  validateConfig,
} from "@eon/engine";
import { summarizePopulation, traitStdDevFraction } from "./populationStats";
import { makeFail, parseIntStrict } from "./cliArgs";

/* See `benchmark.ts`: the annotation is what makes `fail` narrow control flow. */
const fail: (message: string) => never = makeFail("sweep");

interface Variant {
  label: string;
  set: Record<string, number>;
}

interface Experiment {
  name: string;
  seeds: number[];
  ticks: number;
  variants: Variant[];
}

/**
 * Apply `a.b.c=42` overrides to a mutable config.
 *
 * Only existing leaf fields may be set. A typo must fail here rather than be
 * silently added: `validateConfig` requires the config to have exactly the
 * schema's shape, and an unknown field would otherwise change the world hash
 * without changing a single rule (ADR 0004 §4 on the foundation branch made the
 * same point about the engine's own entry point).
 */
function applyOverrides(config: SimulationConfig, overrides: Record<string, number>): void {
  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split(".");
    const leaf = parts.pop();
    if (leaf === undefined) {
      fail(`empty override path`);
    }
    let cursor: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (const part of parts) {
      const next = cursor[part];
      if (typeof next !== "object" || next === null) {
        fail(`override path ${path} does not exist in SimulationConfig`);
      }
      cursor = next as Record<string, unknown>;
    }
    if (!(leaf in cursor)) {
      fail(`override path ${path} does not exist in SimulationConfig`);
    }
    if (typeof cursor[leaf] !== "number") {
      fail(`override path ${path} is not a numeric field`);
    }
    if (!Number.isFinite(value)) {
      fail(`override ${path} must be a finite number, got ${value}`);
    }
    cursor[leaf] = value;
  }
}

function parseSetArgument(raw: string): [string, number] {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    fail(`--set expects path=value, got ${JSON.stringify(raw)}`);
  }
  return [raw.slice(0, eq), parseIntStrict(raw.slice(eq + 1), `--set ${raw.slice(0, eq)}`, fail)];
}

function loadExperiment(path: string): Experiment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read experiment ${path}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    fail(`experiment ${path} must be a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  const seeds = raw.seeds;
  const ticks = raw.ticks;
  if (!Array.isArray(seeds) || seeds.length === 0 || !seeds.every(Number.isSafeInteger)) {
    fail(`experiment ${path} needs a non-empty integer "seeds" array`);
  }
  if (!Number.isSafeInteger(ticks) || (ticks as number) < 0) {
    fail(`experiment ${path} needs a non-negative integer "ticks"`);
  }
  const variantsRaw = raw.variants ?? [{ label: "baseline", set: {} }];
  if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
    fail(`experiment ${path} "variants" must be a non-empty array`);
  }
  const variants = variantsRaw.map((entry, index) => {
    const variant = entry as Record<string, unknown>;
    const set = variant.set ?? {};
    if (typeof set !== "object" || set === null) {
      fail(`experiment ${path} variant ${index} "set" must be an object`);
    }
    return {
      label: typeof variant.label === "string" ? variant.label : `variant${index}`,
      set: set as Record<string, number>,
    };
  });
  return {
    name: typeof raw.name === "string" ? raw.name : path,
    seeds: seeds as number[],
    ticks: ticks as number,
    variants,
  };
}

interface CliOptions {
  experiment: Experiment;
  csv: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let seeds: number[] | undefined;
  let ticks: number | undefined;
  let experiment: Experiment | undefined;
  const set: Record<string, number> = {};
  let csv = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--config": {
        const raw = argv[++i];
        if (raw === undefined) fail("--config requires a path");
        experiment = loadExperiment(raw);
        break;
      }
      case "--seeds": {
        const raw = argv[++i];
        if (raw === undefined) fail("--seeds requires a comma-separated list");
        seeds = raw.split(",").map((part) => {
          const seed = parseIntStrict(part.trim(), "seed", fail);
          if (seed < 0 || seed > 0xffffffff) {
            fail(`--seeds entries must be uint32 values, got ${seed}`);
          }
          return seed;
        });
        break;
      }
      case "--ticks": {
        const raw = argv[++i];
        if (raw === undefined) fail("--ticks requires a value");
        ticks = parseIntStrict(raw, "ticks", fail);
        if (ticks < 0) fail("--ticks must be >= 0");
        break;
      }
      case "--set": {
        const raw = argv[++i];
        if (raw === undefined) fail("--set requires path=value");
        const [path, value] = parseSetArgument(raw);
        set[path] = value;
        break;
      }
      case "--csv":
        csv = true;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "usage: pnpm sweep [--config experiments/x.json] [--seeds a,b,c] [--ticks n] " +
            "[--set path=value]... [--csv] [--json]",
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (experiment === undefined) {
    if (seeds === undefined) fail("either --config or --seeds is required");
    experiment = {
      name: "cli",
      seeds,
      ticks: ticks ?? 20_000,
      variants: [{ label: Object.keys(set).length > 0 ? "override" : "baseline", set }],
    };
  } else {
    if (seeds !== undefined) experiment.seeds = seeds;
    if (ticks !== undefined) experiment.ticks = ticks;
    if (Object.keys(set).length > 0) {
      for (const variant of experiment.variants) {
        Object.assign(variant.set, set);
      }
    }
  }

  return { experiment, csv, json };
}

interface RunResult {
  variant: string;
  seed: number;
  ticks: number;
  survived: boolean;
  population: number;
  peakPopulation: number;
  births: number;
  deaths: number;
  capRejectedBirths: number;
  birthEnergyDiscarded: number;
  maxGeneration: number;
  meanGeneration: number;
  /** Summed normalized-gene variance, hue excluded (Q² units). */
  traitVarianceQ2: number;
  /** The same spread as a per-gene standard deviation, in fractions of a gene range. */
  traitStdDevFraction: number;
  biomassFractionOfCapacity: number;
  /**
   * Predation observables (Milestone 5). Carnivory is a calibration question
   * rather than a settled behaviour — the reference world eats no meat at all in
   * 10 000 ticks (ADR 0008 §5a) — so L07 needs to be able to see, per seed,
   * whether any lineage ever preferred a carcass and whether the carcass cap
   * bound.
   */
  meanDiet: number;
  meatEaten: number;
  kills: number;
  carcasses: number;
  carcassesSkippedAtCap: number;
  finalHash: string;
  wallMs: number;
}

function runOne(variant: Variant, seed: number, ticks: number): RunResult {
  const config = cloneConfig(DEFAULT_CONFIG);
  applyOverrides(config, variant.set);
  validateConfig(config);

  const startedAt = performance.now();
  const engine = new SimulationEngine({ seed, config });
  const capacity = totalPlantCapacity(engine.environment);

  // Peak population is sampled rather than exact: a boom that lasts fewer than
  // 100 ticks is not a fact any calibration decision should rest on.
  let peakPopulation = engine.organisms.liveCount;
  const SAMPLE_EVERY = 100;
  for (let done = 0; done < ticks; done += SAMPLE_EVERY) {
    engine.stepMany(Math.min(SAMPLE_EVERY, ticks - done));
    peakPopulation = Math.max(peakPopulation, engine.organisms.liveCount);
  }

  const stats = summarizePopulation(engine);
  return {
    variant: variant.label,
    seed,
    ticks,
    survived: engine.organisms.liveCount > 0,
    population: stats.population,
    peakPopulation,
    births: engine.organisms.totalBirths,
    deaths: engine.organisms.totalDeaths,
    capRejectedBirths: engine.organisms.capRejectedBirths,
    birthEnergyDiscarded: engine.organisms.birthEnergyDiscarded,
    maxGeneration: stats.maxGeneration,
    meanGeneration: Number(stats.meanGeneration.toFixed(2)),
    traitVarianceQ2: Math.round(stats.traitVarianceQ2),
    traitStdDevFraction: Number(traitStdDevFraction(stats).toFixed(4)),
    biomassFractionOfCapacity:
      capacity > 0 ? Number((totalPlantBiomass(engine.environment) / capacity).toFixed(4)) : 0,
    meanDiet: Number(stats.meanDiet.toFixed(4)),
    meatEaten: engine.carcasses.totalMeatEaten,
    kills: stats.kills,
    carcasses: engine.carcasses.liveCount,
    carcassesSkippedAtCap: engine.carcasses.skippedAtCap,
    finalHash: engine.computeStateHash(),
    wallMs: Math.round(performance.now() - startedAt),
  };
}

const CSV_COLUMNS: readonly (keyof RunResult)[] = [
  "variant",
  "seed",
  "ticks",
  "survived",
  "population",
  "peakPopulation",
  "births",
  "deaths",
  "capRejectedBirths",
  "birthEnergyDiscarded",
  "maxGeneration",
  "meanGeneration",
  "traitVarianceQ2",
  "traitStdDevFraction",
  "biomassFractionOfCapacity",
  "meanDiet",
  "meatEaten",
  "kills",
  "carcasses",
  "carcassesSkippedAtCap",
  "finalHash",
  "wallMs",
];

/** Median rather than mean: one crashed seed should not move the summary. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function main(): void {
  const { experiment, csv, json } = parseArgs(process.argv.slice(2));
  const results: RunResult[] = [];

  if (!csv && !json) {
    console.log(`engine     ${ENGINE_VERSION}`);
    console.log(`experiment ${experiment.name}`);
    console.log(`config     DEFAULT_CONFIG (hash ${hashConfig(DEFAULT_CONFIG)})`);
    console.log(`seeds      ${experiment.seeds.length} x ${experiment.ticks} ticks`);
    if (experiment.seeds.length < 10) {
      console.log(`note       docs/07 §14 asks for 10-30 seeds before drawing a tuning conclusion`);
    }
  }

  for (const variant of experiment.variants) {
    for (const seed of experiment.seeds) {
      const result = runOne(variant, seed, experiment.ticks);
      results.push(result);
      if (!csv && !json) {
        console.log(
          `${result.variant.padEnd(14)} seed 0x${seed.toString(16).toUpperCase().padStart(8, "0")} ` +
            `| pop ${String(result.population).padStart(5)} ` +
            `| peak ${String(result.peakPopulation).padStart(5)} ` +
            `| births ${String(result.births).padStart(7)} ` +
            `| deaths ${String(result.deaths).padStart(7)} ` +
            `| gen ${String(result.maxGeneration).padStart(4)} ` +
            `| sd ${result.traitStdDevFraction.toFixed(4)} ` +
            `| biomass ${(result.biomassFractionOfCapacity * 100).toFixed(1)}% ` +
            `| cap ${String(result.capRejectedBirths).padStart(7)} ` +
            `| diet ${result.meanDiet.toFixed(3).padStart(6)} ` +
            `| meat ${String(result.meatEaten).padStart(8)} ` +
            `| kills ${String(result.kills).padStart(5)} ` +
            `| carrion ${String(result.carcasses).padStart(5)}` +
            `${result.carcassesSkippedAtCap > 0 ? `+${result.carcassesSkippedAtCap} skipped` : ""} ` +
            `| ${result.finalHash} | ${(result.wallMs / 1000).toFixed(1)}s`,
        );
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ engineVersion: ENGINE_VERSION, experiment, results }, null, 2));
    return;
  }
  if (csv) {
    console.log(CSV_COLUMNS.join(","));
    for (const result of results) {
      console.log(CSV_COLUMNS.map((column) => String(result[column])).join(","));
    }
    return;
  }

  for (const variant of experiment.variants) {
    const rows = results.filter((row) => row.variant === variant.label);
    const survived = rows.filter((row) => row.survived).length;
    console.log(
      `\n${variant.label}: survived ${survived}/${rows.length}` +
        ` | median pop ${median(rows.map((r) => r.population))}` +
        ` | median peak ${median(rows.map((r) => r.peakPopulation))}` +
        ` | median births ${median(rows.map((r) => r.births))}` +
        ` | median deaths ${median(rows.map((r) => r.deaths))}` +
        ` | median max gen ${median(rows.map((r) => r.maxGeneration))}` +
        ` | median trait sd ${median(rows.map((r) => r.traitStdDevFraction)).toFixed(4)}` +
        ` | seeds hitting cap ${rows.filter((r) => r.capRejectedBirths > 0).length}` +
        ` | seeds eating meat ${rows.filter((r) => r.meatEaten > 0).length}` +
        ` | seeds hitting the carcass cap ${rows.filter((r) => r.carcassesSkippedAtCap > 0).length}`,
    );
    console.log(
      `${" ".repeat(variant.label.length + 1)} trait sd is per-gene standard deviation as a ` +
        `fraction of a gene range (Q = ${Q}); founders start at 0.0000`,
    );
  }
}

main();
