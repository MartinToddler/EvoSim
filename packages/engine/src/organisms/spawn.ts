import { ANGLE_STEPS, POS_SCALE, Q, clamp, qmul } from "../math/fixed";
import type { EngineContext } from "../EngineContext";
import { BRAIN_INPUT_COUNT } from "../brain/BrainLayout";
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

/**
 * How much energy a newborn starts with.
 *
 * There are genuinely two cases and conflating them would hide a bug. A founder
 * is endowed as a *fraction of its own* maximum (docs/04 §5) because nothing
 * paid for it. A child is endowed with an *absolute* amount that its parent paid
 * out of its own reserves (docs/04 §19), and that amount is set by the parent's
 * body, not the child's — so it can exceed what the child can hold.
 *
 * Both forms are clamped to the newborn's own maximum energy in exactly one
 * place, {@link spawnOrganism}, and the caller learns what was actually granted
 * by reading `organisms.energy[slot]` back.
 */
export type SpawnEnergy =
  | { readonly kind: "fractionOfMax"; readonly fractionQ: number }
  | { readonly kind: "absolute"; readonly units: number };

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
  energy: SpawnEnergy;
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
  const { organisms, genomes, phenotypes, scratch, config } = ctx;

  const slot = organisms.allocateSlot();
  if (slot < 0) {
    return -1;
  }

  // Clear the slot's per-tick scratch. Authoritatively this is redundant —
  // sensing, brain and movement rewrite every one of these before anything
  // reads them on the newborn's first full tick — but `queryEntity` reads the
  // retained sensor/intent blocks between ticks for the inspector, and a
  // reused slot would otherwise show the previous occupant's last thoughts as
  // the newborn's. Scratch is never hashed, so this cannot move a golden hash.
  scratch.sensorValues.fill(
    0,
    slot * BRAIN_INPUT_COUNT,
    slot * BRAIN_INPUT_COUNT + BRAIN_INPUT_COUNT,
  );
  scratch.throttleQ[slot] = 0;
  scratch.turnQ[slot] = 0;
  scratch.eatQ[slot] = 0;
  scratch.attackQ[slot] = 0;
  scratch.reproduceQ[slot] = 0;
  scratch.speedFractionQ[slot] = 0;
  scratch.accelFractionQ[slot] = 0;
  scratch.inWater[slot] = 0;

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
  // A newborn starts off cooldown. It still cannot reproduce for a long while —
  // maturity age and 90% development are far away — so this is a statement about
  // the counter, not a head start.
  organisms.reproductionCooldown[slot] = 0;
  organisms.plantEnergyEaten[slot] = 0;
  organisms.meatEnergyEaten[slot] = 0;
  organisms.kills[slot] = 0;

  organisms.generation[slot] = request.generation;
  organisms.parentEntityId[slot] = request.parentEntityId;
  organisms.speciesId[slot] = request.speciesId;

  // Energy is capped by the NEWBORN's body, not by its adult potential. A parent
  // that over-invests loses the surplus (see ecology/reproduction.ts); energy is
  // never created here.
  const radius = currentRadiusPos(phenotypes.adultRadiusPos[slot] as number, developmentQ);
  const mass = massFromRadiusPos(radius, config.organism.massScalePerRadiusSquared);
  const maxEnergy = maxEnergyForMass(mass, config);
  const requested =
    request.energy.kind === "fractionOfMax"
      ? qmul(maxEnergy, request.energy.fractionQ)
      : request.energy.units;
  organisms.energy[slot] = clamp(requested, 0, maxEnergy);

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
      energy: { kind: "fractionOfMax", fractionQ: config.organism.initialEnergyFractionQ },
    });
    if (slot < 0) {
      break;
    }
    spawned += 1;
  }

  return spawned;
}
