/**
 * Ecological speciation scenario — calibration probe (ADR 0025; docs/07 §16
 * third bullet; MVP release gate 6).
 *
 * Runs a small world with a STEEP latitudinal temperature cline and a hot,
 * barren equatorial band, and measures what actually diverges: population,
 * per-gene spread, the thermal-optimum distribution by latitude, and — the
 * number the split threshold must be calibrated against — the RMS separation of
 * a deterministic 2-means clustering over the same fifteen normalized gene
 * dimensions the engine's trait vector uses.
 *
 * This script DECIDES nothing and asserts nothing; it exists to put numbers
 * behind two choices the scenario fixture then hard-codes:
 *
 *   1. how steep the cline must be for persistent phenotype clusters to form
 *      through ordinary mutation + selection + local dispersal;
 *   2. what `species.splitDistanceThresholdQ` cleanly separates that ecological
 *      signal from mutation noise (measured on the same world with the cline
 *      flattened).
 *
 * Usage:
 *   pnpm exec tsx scripts/speciationScenario.ts --ticks 40000 --interval 2000
 *   pnpm exec tsx scripts/speciationScenario.ts --flat        # noise control
 */
import {
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  Gene,
  Q,
  SimulationEngine,
  cloneConfig,
  geneToQ,
  validateConfig,
} from "@eon/engine";
import { makeFail, parseIntStrict } from "./cliArgs";

const fail: (message: string) => never = makeFail("speciationScenario");

interface Options {
  seed: number;
  ticks: number;
  interval: number;
  /** Flatten the cline: the noise-control world. */
  flat: boolean;
  equatorCentiC: number;
  dropCentiC: number;
  splitThresholdQ: number;
  continuityQ: number;
  capacityFactorPct: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    seed: 0xe0a12026,
    ticks: 40_000,
    interval: 2_000,
    flat: false,
    equatorCentiC: 6_000,
    dropCentiC: 7_000,
    splitThresholdQ: DEFAULT_CONFIG.species.splitDistanceThresholdQ,
    continuityQ: DEFAULT_CONFIG.species.candidateCentroidContinuityThresholdQ,
    capacityFactorPct: 100,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): number => parseIntStrict(argv[++i] ?? fail(`${arg} needs a value`), arg, fail);
    switch (arg) {
      case "--seed":
        options.seed = next();
        break;
      case "--ticks":
        options.ticks = next();
        break;
      case "--interval":
        options.interval = next();
        break;
      case "--flat":
        options.flat = true;
        break;
      case "--equator":
        options.equatorCentiC = next();
        break;
      case "--drop":
        options.dropCentiC = next();
        break;
      case "--threshold":
        options.splitThresholdQ = next();
        break;
      case "--continuity":
        options.continuityQ = next();
        break;
      case "--capacity":
        options.capacityFactorPct = next();
        break;
      default:
        fail(`unknown argument ${arg}`);
    }
  }
  return options;
}

/** Build the scenario config: soak-world geometry plus the climate forcing. */
function scenarioConfig(options: Options) {
  const config = cloneConfig(DEFAULT_CONFIG);
  const grid = 96;
  config.world.envGridSize = grid;
  config.world.sizeLU = grid * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(grid / 8));
  config.world.initialOrganisms = 64;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = Math.floor((grid * grid) / 16);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 32,
  );

  if (!options.flat) {
    // The forcing: hot equator, cold poles. Plants die where temperature
    // suitability reaches zero, so the hot band is also a barren band and the
    // two hemispheres exchange organisms rarely.
    config.world.climate.equatorTemperatureCentiC = options.equatorCentiC;
    config.world.climate.poleTemperatureDropCentiC = options.dropCentiC;
  }

  for (let biome = 1; biome < config.plants.baseCapacityByBiome.length; biome += 1) {
    config.plants.baseCapacityByBiome[biome] = Math.floor(
      ((config.plants.baseCapacityByBiome[biome] as number) * options.capacityFactorPct) / 100,
    );
  }

  config.species.splitDistanceThresholdQ = options.splitThresholdQ;
  config.species.candidateCentroidContinuityThresholdQ = options.continuityQ;
  validateConfig(config);
  return config;
}

/** The fifteen gene dimensions mirroring the engine's trait vector, normalized 0..Q. */
const GENE_DIMS: readonly number[] = [
  Gene.AdultSize,
  Gene.MaxSpeed,
  Gene.Acceleration,
  Gene.TurnRate,
  Gene.VisionRange,
  Gene.VisionFov,
  Gene.Diet,
  Gene.AttackPower,
  Gene.Armor,
  Gene.MetabolicPace,
  Gene.ThermalOptimum,
  Gene.ThermalTolerance,
  Gene.MaturityAge,
  Gene.MaxAge,
  Gene.OffspringInvestment,
] as const;

interface ClusterReport {
  separationRmsQ: number;
  sizeA: number;
  sizeB: number;
  /** Mean thermal-optimum gene per cluster, in Q. */
  thermalA: number;
  thermalB: number;
}

/**
 * Deterministic 2-means over the live population's gene vectors.
 *
 * Initialized from the extremes of the thermal-optimum dimension (the axis the
 * scenario forces), then iterated a fixed number of rounds — the same shape as
 * the engine's own detector, reimplemented here only so a DIAGNOSTIC can be
 * read without touching engine internals.
 */
function twoMeans(engine: SimulationEngine): ClusterReport | null {
  const organisms = engine.organisms;
  const genomes = engine.genomes;
  const dims = GENE_DIMS.length;
  const rows: number[][] = [];
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) continue;
    const row: number[] = [];
    for (const gene of GENE_DIMS) {
      row.push(geneToQ(genomes.gene(slot, gene)));
    }
    rows.push(row);
  }
  if (rows.length < 8) return null;

  const thermalIndex = GENE_DIMS.indexOf(Gene.ThermalOptimum);
  let lo = rows[0] as number[];
  let hi = rows[0] as number[];
  for (const row of rows) {
    if ((row[thermalIndex] as number) < (lo[thermalIndex] as number)) lo = row;
    if ((row[thermalIndex] as number) > (hi[thermalIndex] as number)) hi = row;
  }
  let centroidA = [...lo];
  let centroidB = [...hi];

  const assign = new Array<number>(rows.length).fill(0);
  for (let round = 0; round < 8; round += 1) {
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r] as number[];
      let da = 0;
      let db = 0;
      for (let d = 0; d < dims; d += 1) {
        const va = (row[d] as number) - (centroidA[d] as number);
        const vb = (row[d] as number) - (centroidB[d] as number);
        da += va * va;
        db += vb * vb;
      }
      assign[r] = db < da ? 1 : 0;
    }
    const sums = [new Array<number>(dims).fill(0), new Array<number>(dims).fill(0)];
    const counts = [0, 0];
    for (let r = 0; r < rows.length; r += 1) {
      const bucket = assign[r] as number;
      counts[bucket] = (counts[bucket] as number) + 1;
      const row = rows[r] as number[];
      const sum = sums[bucket] as number[];
      for (let d = 0; d < dims; d += 1) {
        sum[d] = (sum[d] as number) + (row[d] as number);
      }
    }
    if (counts[0] === 0 || counts[1] === 0) return null;
    centroidA = (sums[0] as number[]).map((value) => value / (counts[0] as number));
    centroidB = (sums[1] as number[]).map((value) => value / (counts[1] as number));
  }

  let sumSq = 0;
  for (let d = 0; d < dims; d += 1) {
    const delta = (centroidA[d] as number) - (centroidB[d] as number);
    sumSq += delta * delta;
  }
  const sizeA = assign.filter((bucket) => bucket === 0).length;
  return {
    separationRmsQ: Math.round(Math.sqrt(sumSq / dims)),
    sizeA,
    sizeB: rows.length - sizeA,
    thermalA: Math.round(centroidA[thermalIndex] as number),
    thermalB: Math.round(centroidB[thermalIndex] as number),
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const config = scenarioConfig(options);
  const engine = new SimulationEngine({ seed: options.seed, config });

  console.log(`engine     ${ENGINE_VERSION}`);
  console.log(
    `scenario   ${options.flat ? "FLAT (noise control)" : `cline equator ${options.equatorCentiC / 100}°C, pole drop ${options.dropCentiC / 100}°C`}`,
  );
  console.log(
    `species    threshold ${options.splitThresholdQ}/${Q} rms, continuity ${options.continuityQ}, capacity ${options.capacityFactorPct}%`,
  );
  console.log(`seed       0x${options.seed.toString(16).toUpperCase()}`);

  for (let done = 0; done < options.ticks; done += options.interval) {
    engine.stepMany(Math.min(options.interval, options.ticks - done));
    const live = engine.organisms.liveCount;
    const clusters = live >= 8 ? twoMeans(engine) : null;
    const line =
      `tick ${String(engine.tick).padStart(7)} | pop ${String(live).padStart(5)} ` +
      `| species ${engine.species.activeCount}` +
      (clusters === null
        ? " | clusters n/a"
        : ` | 2-means rms ${String(clusters.separationRmsQ).padStart(4)}Q ` +
          `(${clusters.sizeA}/${clusters.sizeB}) ` +
          `thermal ${clusters.thermalA} vs ${clusters.thermalB}`);
    console.log(line);
    if (live === 0) {
      console.log("extinct — scenario over");
      break;
    }
  }
}

main();
