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
  BrushFalloff,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  Gene,
  InterventionKind,
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
  grid: number;
  equatorCentiC: number;
  dropCentiC: number;
  splitThresholdQ: number;
  continuityQ: number;
  capacityFactorPct: number;
  /** Tick at which LowerTerrain commands flood an equatorial channel; 0 = never. */
  channelTick: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    seed: 0xe0a12026,
    ticks: 40_000,
    interval: 2_000,
    flat: false,
    grid: 96,
    equatorCentiC: 6_000,
    dropCentiC: 7_000,
    splitThresholdQ: DEFAULT_CONFIG.species.splitDistanceThresholdQ,
    continuityQ: DEFAULT_CONFIG.species.candidateCentroidContinuityThresholdQ,
    capacityFactorPct: 100,
    channelTick: 0,
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
      case "--grid":
        options.grid = next();
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
      case "--channel":
        options.channelTick = next();
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
  const grid = options.grid;
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

  config.plants.baseCapacityByBiome = config.plants.baseCapacityByBiome.map((base, biome) =>
    biome === 0 ? base : Math.floor((base * options.capacityFactorPct) / 100),
  );

  config.species.splitDistanceThresholdQ = options.splitThresholdQ;
  config.species.candidateCentroidContinuityThresholdQ = options.continuityQ;
  validateConfig(config);
  return config;
}

/** Names for {@link GENE_DIMS}, for the widest-separation diagnostic. */
const GENE_DIM_NAMES: readonly string[] = [
  "size",
  "speed",
  "accel",
  "turn",
  "visRange",
  "visFov",
  "diet",
  "attack",
  "armor",
  "pace",
  "thermalOpt",
  "thermalTol",
  "maturity",
  "maxAge",
  "invest",
];

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
  /** Mean diet gene per cluster, in Q (0 herbivore … Q carnivore; founder ~819). */
  dietA: number;
  dietB: number;
  /** The dimension with the largest centroid separation, and that separation. */
  widestDim: string;
  widestDeltaQ: number;
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
  let widestDim = 0;
  let widestDelta = 0;
  for (let d = 0; d < dims; d += 1) {
    const delta = (centroidA[d] as number) - (centroidB[d] as number);
    sumSq += delta * delta;
    if (Math.abs(delta) > widestDelta) {
      widestDelta = Math.abs(delta);
      widestDim = d;
    }
  }
  const dietIndex = GENE_DIMS.indexOf(Gene.Diet);
  const sizeA = assign.filter((bucket) => bucket === 0).length;
  return {
    separationRmsQ: Math.round(Math.sqrt(sumSq / dims)),
    sizeA,
    sizeB: rows.length - sizeA,
    thermalA: Math.round(centroidA[thermalIndex] as number),
    thermalB: Math.round(centroidB[thermalIndex] as number),
    dietA: Math.round(centroidA[dietIndex] as number),
    dietB: Math.round(centroidB[dietIndex] as number),
    widestDim: GENE_DIM_NAMES[widestDim] as string,
    widestDeltaQ: Math.round(widestDelta),
  };
}

interface HemisphereReport {
  northPop: number;
  southPop: number;
  /** Mean thermal-optimum gene per hemisphere, Q-normalized. */
  northThermal: number;
  southThermal: number;
  /** Mean signed diet per hemisphere, Q-normalized (0..Q; founder ~819). */
  northDiet: number;
  southDiet: number;
}

/** Where the population actually lives, split at the equator row. */
function hemispheres(engine: SimulationEngine): HemisphereReport {
  const organisms = engine.organisms;
  const genomes = engine.genomes;
  const halfPos = (engine.config.world.sizeLU / 2) * 256; // POS_SCALE
  const report: HemisphereReport = {
    northPop: 0,
    southPop: 0,
    northThermal: 0,
    southThermal: 0,
    northDiet: 0,
    southDiet: 0,
  };
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) continue;
    const thermal = geneToQ(genomes.gene(slot, Gene.ThermalOptimum));
    const diet = geneToQ(genomes.gene(slot, Gene.Diet));
    if ((organisms.y[slot] as number) < halfPos) {
      report.northPop += 1;
      report.northThermal += thermal;
      report.northDiet += diet;
    } else {
      report.southPop += 1;
      report.southThermal += thermal;
      report.southDiet += diet;
    }
  }
  report.northThermal = Math.round(report.northThermal / Math.max(1, report.northPop));
  report.southThermal = Math.round(report.southThermal / Math.max(1, report.southPop));
  report.northDiet = Math.round(report.northDiet / Math.max(1, report.northPop));
  report.southDiet = Math.round(report.southDiet / Math.max(1, report.southPop));
  return report;
}

/**
 * Flood a full-width channel along the equator with ordinary LowerTerrain
 * commands — the product's own geological intervention, deterministic and
 * replayable. Repeated hard-falloff passes sink the strip below sea level; the
 * engine's region recompute turns it into water, splitting one continent into
 * two isolated demes with the population already living on both sides.
 */
function queueChannelCommands(engine: SimulationEngine, targetTick: number): number {
  const config = engine.config;
  const sizeLU = config.world.sizeLU;
  const yLU = Math.floor(sizeLU / 2);
  const spacing = 16;
  const radiusLU = 48;
  const strength = config.interventions.maxTerrainBrushStrengthQ;
  const maxSamples = config.interventions.maxBrushSamplesPerCommand;
  // Enough cumulative lowering to sink any plausible land elevation: mountains
  // sit near Q; sea level is ~0.46 Q; 16 passes x 256 Q covers the whole range.
  const passes = 16;
  let queued = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    for (let fromLU = 0; fromLU < sizeLU; fromLU += spacing * maxSamples) {
      const samplesXLU: number[] = [];
      const samplesYLU: number[] = [];
      for (let s = 0; s < maxSamples; s += 1) {
        const x = fromLU + s * spacing;
        if (x > sizeLU) break;
        samplesXLU.push(x);
        samplesYLU.push(yLU);
      }
      if (samplesXLU.length === 0) continue;
      const result = engine.queueCommand({
        kind: InterventionKind.LowerTerrain,
        radiusLU,
        strength,
        falloff: BrushFalloff.Hard,
        samplesXLU,
        samplesYLU,
        targetTick,
      });
      if (!result.accepted) {
        fail(`channel command rejected: ${result.detail}`);
      }
      queued += 1;
    }
  }
  return queued;
}

/** RMS distance between the two hemispheres' mean gene vectors, in Q. */
function demeRmsQ(engine: SimulationEngine): number {
  const organisms = engine.organisms;
  const genomes = engine.genomes;
  const halfPos = (engine.config.world.sizeLU / 2) * 256;
  const dims = GENE_DIMS.length;
  const sums = [new Array<number>(dims).fill(0), new Array<number>(dims).fill(0)];
  const counts = [0, 0];
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) continue;
    const bucket = (organisms.y[slot] as number) < halfPos ? 0 : 1;
    counts[bucket] = (counts[bucket] as number) + 1;
    const sum = sums[bucket] as number[];
    for (let d = 0; d < dims; d += 1) {
      sum[d] = (sum[d] as number) + geneToQ(genomes.gene(slot, GENE_DIMS[d] as number));
    }
  }
  if (counts[0] === 0 || counts[1] === 0) return 0;
  let sumSq = 0;
  for (let d = 0; d < dims; d += 1) {
    const delta =
      (sums[0] as number[])[d]! / (counts[0] as number) -
      (sums[1] as number[])[d]! / (counts[1] as number);
    sumSq += delta * delta;
  }
  return Math.round(Math.sqrt(sumSq / dims));
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
  if (options.channelTick > 0) {
    const queued = queueChannelCommands(engine, options.channelTick);
    console.log(
      `channel    ${queued} LowerTerrain commands queued for tick ${options.channelTick}`,
    );
  }

  for (let done = 0; done < options.ticks; done += options.interval) {
    engine.stepMany(Math.min(options.interval, options.ticks - done));
    const live = engine.organisms.liveCount;
    const clusters = live >= 8 ? twoMeans(engine) : null;
    const bands = hemispheres(engine);
    const line =
      `tick ${String(engine.tick).padStart(7)} | pop ${String(live).padStart(5)} ` +
      `| species ${engine.species.activeCount}` +
      ` | N ${String(bands.northPop).padStart(5)} (th ${bands.northThermal}, diet ${bands.northDiet})` +
      ` S ${String(bands.southPop).padStart(5)} (th ${bands.southThermal}, diet ${bands.southDiet})` +
      ` | deme rms ${String(demeRmsQ(engine)).padStart(4)}Q` +
      (clusters === null
        ? " | clusters n/a"
        : ` | 2-means rms ${String(clusters.separationRmsQ).padStart(4)}Q ` +
          `(${clusters.sizeA}/${clusters.sizeB}) ` +
          `thermal ${clusters.thermalA}/${clusters.thermalB} ` +
          `diet ${clusters.dietA}/${clusters.dietB} ` +
          `widest ${clusters.widestDim} Δ${clusters.widestDeltaQ}`);
    console.log(line);
    if (live === 0) {
      console.log("extinct — scenario over");
      break;
    }
  }
}

main();
