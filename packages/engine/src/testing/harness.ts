import { BRAIN_WEIGHT_COUNT } from "../brain/BrainLayout";
import { createFounderBrainWeights } from "../brain/founderBrain";
import type { SimulationConfig } from "../config/SimulationConfig";
import { cloneConfig, type ReadonlySimulationConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { validateConfig } from "../config/validateConfig";
import type { EngineContext } from "../EngineContext";
import { EngineScratch } from "../EngineScratch";
import { GENE_COUNT, geneFromQ } from "../genetics/genes";
import { createFounderGenes } from "../genetics/founderGenome";
import { POS_SCALE, Q } from "../math/fixed";
import { GenomeStore } from "../organisms/GenomeStore";
import { OrganismStore } from "../organisms/OrganismStore";
import { PhenotypeStore } from "../organisms/phenotype";
import { type SpawnRequest, spawnOrganism } from "../organisms/spawn";
import { Xoshiro128 } from "../random/Xoshiro128";
import { SpatialGrid } from "../spatial/SpatialGrid";
import { EnvironmentStore } from "../world/EnvironmentStore";
import { Biome } from "../world/biomes";

/**
 * Synthetic engine context for unit tests.
 *
 * Procedurally generated worlds are the right subject for the environment and
 * acceptance tests, but they are the wrong subject for a movement or feeding
 * unit test: the terrain is whatever the seed produced, so an assertion about
 * walking into water has to first go looking for water. This harness builds a
 * flat, uniform, fully specified world instead, so each test states exactly the
 * conditions it is about.
 *
 * It uses the real stores, the real phases and the real config — only world
 * generation and the tick loop are bypassed.
 */

export interface TestWorldOptions {
  /** Environment grid resolution per axis. */
  gridSize?: number;
  /** Uniform plant capacity per land cell. */
  plantCapacity?: number;
  /** Uniform starting biomass per land cell. */
  plantBiomass?: number;
  /** Uniform temperature. */
  temperatureCentiC?: number;
  /** Config overrides applied to a copy of DEFAULT_CONFIG. */
  configure?: (config: SimulationConfig) => void;
  seed?: number;
}

export interface TestWorld {
  ctx: EngineContext;
  config: ReadonlySimulationConfig;
  environment: EnvironmentStore;
  organisms: OrganismStore;
  /** World size in sub-units, for placing organisms. */
  worldSizePos: number;
  /** Turn a grid cell into a centre position in sub-units. */
  cellCenter(gridX: number, gridY: number): { xPos: number; yPos: number };
  /** Flood one cell with water and refresh the derived caches. */
  makeWater(gridX: number, gridY: number): void;
}

export function createTestWorld(options: TestWorldOptions = {}): TestWorld {
  const gridSize = options.gridSize ?? 64;
  const config = cloneConfig(DEFAULT_CONFIG);
  const cellSizeLU = config.world.envCellSizeLU;
  config.world.envGridSize = gridSize;
  config.world.sizeLU = gridSize * cellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(gridSize / 8));
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 2,
  );
  config.world.validity.minFounderRegionCells = Math.min(
    config.world.validity.minFounderRegionCells,
    gridSize * gridSize,
  );
  options.configure?.(config);
  validateConfig(config);

  const environment = new EnvironmentStore(gridSize, cellSizeLU);
  const capacity = config.plants.baseCapacityByBiome[Biome.Grassland] as number;
  const plantCapacity = options.plantCapacity ?? capacity;
  const plantBiomass = options.plantBiomass ?? plantCapacity >> 1;
  environment.biome.fill(Biome.Grassland);
  environment.plantCapacity.fill(plantCapacity);
  environment.plantBiomass.fill(plantBiomass);
  environment.baseTemperatureCentiC.fill(options.temperatureCentiC ?? 1800);
  environment.baseMoistureQ.fill(Q >> 1);
  environment.fertilityQ.fill(Q >> 1);
  environment.elevationQ.fill(Q >> 1);
  environment.recomputePassability();

  const organisms = new OrganismStore(config.limits.maxOrganisms);
  const ctx: EngineContext = {
    seed: options.seed ?? 0x1234_5678,
    config,
    environment,
    organisms,
    genomes: new GenomeStore(config.limits.maxOrganisms),
    phenotypes: new PhenotypeStore(config.limits.maxOrganisms),
    spatialPre: new SpatialGrid(
      config.world.sizeLU,
      config.world.spatialCellSizeLU,
      config.limits.maxOrganisms,
    ),
    spatialPost: new SpatialGrid(
      config.world.sizeLU,
      config.world.spatialCellSizeLU,
      config.limits.maxOrganisms,
    ),
    scratch: new EngineScratch(config.limits.maxOrganisms, environment.cellCount),
    rng: Xoshiro128.fromSeed(options.seed ?? 0x1234_5678),
  };

  const cellSizePos = cellSizeLU * POS_SCALE;
  return {
    ctx,
    config,
    environment,
    organisms,
    worldSizePos: config.world.sizeLU * POS_SCALE,
    cellCenter(gridX: number, gridY: number) {
      return {
        xPos: gridX * cellSizePos + (cellSizePos >> 1),
        yPos: gridY * cellSizePos + (cellSizePos >> 1),
      };
    },
    makeWater(gridX: number, gridY: number) {
      const index = environment.cellIndex(gridX, gridY);
      environment.biome[index] = Biome.Water;
      environment.plantCapacity[index] = 0;
      environment.plantBiomass[index] = 0;
      environment.recomputePassability();
    },
  };
}

export interface TestOrganismOptions {
  xPos: number;
  yPos: number;
  angle?: number;
  /** Normalized gene overrides, keyed by Gene index. */
  genesQ?: Partial<Record<number, number>>;
  /** Brain weight overrides, keyed by packed weight index. */
  weights?: Partial<Record<number, number>>;
  /** Use an all-zero brain instead of the founder controller. */
  silentBrain?: boolean;
  energyFractionQ?: number;
}

/** Spawn one organism into a test world and return its slot. */
export function spawnTestOrganism(world: TestWorld, options: TestOrganismOptions): number {
  const { ctx, config } = world;
  const genes = createFounderGenes();
  for (const [gene, valueQ] of Object.entries(options.genesQ ?? {})) {
    genes[Number(gene) % GENE_COUNT] = geneFromQ(valueQ as number);
  }

  const weights = options.silentBrain
    ? new Int16Array(BRAIN_WEIGHT_COUNT)
    : createFounderBrainWeights(
        config.brain.weightScale,
        config.brain.weightMin,
        config.brain.weightMax,
      );
  for (const [index, value] of Object.entries(options.weights ?? {})) {
    weights[Number(index)] = value as number;
  }

  const request: SpawnRequest = {
    xPos: options.xPos,
    yPos: options.yPos,
    angle: options.angle ?? 0,
    genes,
    brainWeights: weights,
    generation: 0,
    parentEntityId: 0,
    speciesId: 1,
    energyFractionQ: options.energyFractionQ ?? config.organism.initialEnergyFractionQ,
  };
  return spawnOrganism(ctx, request);
}
