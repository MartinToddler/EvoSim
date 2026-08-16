/**
 * Diagnostic: what share of the LIVING population's ingested energy came from
 * meat, beside the diet-gene mean (docs/05 §21 analytics; never authoritative).
 *
 * The sweep reports meat units eaten but not the ratio, and the ratio is what
 * the carnivore-lineage detector actually reads (docs/05 §§5, 15): observed
 * intake, never the gene.
 */
import { DEFAULT_CONFIG, SimulationEngine } from "@eon/engine";
import { summarizePopulation } from "./populationStats";
import { makeFail, parseIntStrict } from "./cliArgs";

/* See `benchmark.ts`: the annotation is what makes `fail` narrow control flow. */
const fail: (message: string) => never = makeFail("diet-share-probe");

const seed = parseIntStrict(process.argv[2] ?? "3768655910", "seed", fail);
const ticks = parseIntStrict(process.argv[3] ?? "10000", "ticks", fail);

const engine = new SimulationEngine({ seed, config: DEFAULT_CONFIG });
engine.stepMany(ticks);
const stats = summarizePopulation(engine);
const total = stats.plantIntake + stats.meatIntake;
console.log(
  JSON.stringify({
    seed: `0x${seed.toString(16).toUpperCase()}`,
    ticks,
    population: stats.population,
    plantIntake: stats.plantIntake,
    meatIntake: stats.meatIntake,
    meatFractionOfLivingIntake: total > 0 ? Number((stats.meatIntake / total).toFixed(4)) : 0,
    meanDiet: Number(stats.meanDiet.toFixed(4)),
    kills: stats.kills,
  }),
);
