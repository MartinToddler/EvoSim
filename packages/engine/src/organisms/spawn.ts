import { ANGLE_STEPS, POS_SCALE, Q, clamp, qmul } from "../math/fixed";
import type { EngineContext } from "../EngineContext";
import { createFounderBrainWeights } from "../brain/founderBrain";
import { createFounderGenes } from "../genetics/founderGenome";
import type { FounderRegion } from "../world/validateWorld";
import {
  currentRadiusPos,
  derivePhenotype,
  massFromRadiusPos,
  maxEnergyForMass,
} from "./phenotype";

/**
 * Spawning organisms (docs/03 §26, docs/04 §5, task D07).
 */

/** Every founder starts in species 1 (docs/05 §5). */
export const FOUNDER_SPECIES_ID = 1;

/**
 * Placement attempts per founder before falling back to the region centre.
 *
 * The founder region is the most productive neighbourhood of the largest
 * landmass, so a random point inside it is nearly always land; the bound just
 * stops a pathological coastline from spinning forever. It is an engine
 * constant rather than a config value because changing it changes the number
 * of PRNG draws and therefore every subsequent world state — it is versioned
 * by ENGINE_VERSION, not tuned.
 */
export const FOUNDER_PLACEMENT_ATTEMPTS = 64;

export interface SpawnRequest {
  /** Position in world sub-units. */
  xPos: number;
  yPos: number;
  angle: number;
  genes: ArrayLike<number>;
  brainWeights: ArrayLike<number>;
  generation: number;
  parentEntityId: number;
  speciesId: number;
  /** Starting energy as a Q fraction of the newborn's maximum energy. */
  energyFractionQ: number;
}

/**
 * Create one organism and return its slot, or -1 when the population cap is
 * reached.
 *
 * A newborn is not a small adult with a full tank: it starts at the configured
 * birth size fraction of its adult radius, which sets a smaller maximum energy
 * than it will have later, and it has to pay for every unit of mass it grows
 * (docs/04 §4).
 */
export function spawnOrganism(ctx: EngineContext, request: SpawnRequest): number {
  const { organisms, genomes, phenotypes, config } = ctx;

  const slot = organisms.allocateSlot();
  if (slot < 0) {
    return -1;
  }

  genomes.writeGenome(slot, request.genes, request.brainWeights);
  derivePhenotype(phenotypes, genomes, slot, config);

  const maxPos = config.world.sizeLU * POS_SCALE - 1;
  organisms.x[slot] = clamp(Math.trunc(request.xPos), 0, maxPos);
  organisms.y[slot] = clamp(Math.trunc(request.yPos), 0, maxPos);
  organisms.posFracX[slot] = 0;
  organisms.posFracY[slot] = 0;
  organisms.vx[slot] = 0;
  organisms.vy[slot] = 0;
  organisms.angle[slot] = request.angle & (ANGLE_STEPS - 1);

  const developmentQ = config.organism.birthSizeFractionQ;
  organisms.developmentQ[slot] = developmentQ;
  organisms.healthQ[slot] = Q;
  organisms.ageTicks[slot] = 0;
  organisms.waterTicks[slot] = 0;
  organisms.lastDamageQ[slot] = 0;
  organisms.attackCooldown[slot] = 0;
  organisms.plantEnergyEaten[slot] = 0;
  organisms.meatEnergyEaten[slot] = 0;
  organisms.kills[slot] = 0;

  organisms.generation[slot] = request.generation;
  organisms.parentEntityId[slot] = request.parentEntityId;
  organisms.speciesId[slot] = request.speciesId;

  const radius = currentRadiusPos(phenotypes.adultRadiusPos[slot] as number, developmentQ);
  const mass = massFromRadiusPos(radius, config.organism.massScalePerRadiusSquared);
  organisms.energy[slot] = qmul(maxEnergyForMass(mass, config), request.energyFractionQ);

  organisms.totalBirths += 1;
  return slot;
}

/**
 * Spawn the founder population into the chosen region (docs/03 §26).
 *
 * All founders share one genome and one calibrated brain, are placed at
 * PRNG-drawn positions inside the founder radius, face PRNG-drawn headings and
 * start at the configured fraction of their maximum energy. After that they
 * are ordinary organisms: no special-case code path ever looks at whether an
 * organism was a founder (docs/07 §15 — "never add a hidden founder survival
 * bonus").
 *
 * This is the only PRNG use in Milestone 3. Every tick phase is deterministic
 * without drawing, and per-organism sensory noise is stateless, so the
 * generator's state is untouched by simulation until reproduction arrives.
 */
export function spawnFounderPopulation(ctx: EngineContext, region: FounderRegion): number {
  const { environment, config, rng } = ctx;
  const genes = createFounderGenes();
  const brainWeights = createFounderBrainWeights(
    config.brain.weightScale,
    config.brain.weightMin,
    config.brain.weightMax,
  );

  const cellSizePos = environment.cellSizeLU * POS_SCALE;
  const centerX = region.centerGridX * cellSizePos + (cellSizePos >> 1);
  const centerY = region.centerGridY * cellSizePos + (cellSizePos >> 1);
  const radiusPos = config.world.founderSpawnRadiusLU * POS_SCALE;
  const maxPos = config.world.sizeLU * POS_SCALE - 1;
  const radiusSq = radiusPos * radiusPos;

  let spawned = 0;
  for (let i = 0; i < config.world.initialOrganisms; i += 1) {
    let xPos = centerX;
    let yPos = centerY;
    for (let attempt = 0; attempt < FOUNDER_PLACEMENT_ATTEMPTS; attempt += 1) {
      const dx = rng.nextInt(2 * radiusPos + 1) - radiusPos;
      const dy = rng.nextInt(2 * radiusPos + 1) - radiusPos;
      if (dx * dx + dy * dy > radiusSq) {
        continue;
      }
      const candidateX = clamp(centerX + dx, 0, maxPos);
      const candidateY = clamp(centerY + dy, 0, maxPos);
      if (environment.isWaterCell(environment.cellIndexFromPosition(candidateX, candidateY))) {
        continue;
      }
      xPos = candidateX;
      yPos = candidateY;
      break;
    }

    const slot = spawnOrganism(ctx, {
      xPos,
      yPos,
      angle: rng.nextInt(ANGLE_STEPS),
      genes,
      brainWeights,
      generation: 0,
      parentEntityId: 0,
      speciesId: FOUNDER_SPECIES_ID,
      energyFractionQ: config.organism.initialEnergyFractionQ,
    });
    if (slot < 0) {
      break;
    }
    spawned += 1;
  }

  return spawned;
}
