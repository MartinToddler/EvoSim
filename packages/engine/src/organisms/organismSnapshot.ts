import type { DeepReadonly } from "@eon/shared";
import { BRAIN_WEIGHT_COUNT } from "../brain/BrainLayout";
import type { SimulationConfig } from "../config/SimulationConfig";
import { GENE_COUNT } from "../genetics/genes";
import { DEATH_CAUSE_COUNT } from "./death";
import type { GenomeStore } from "./GenomeStore";
import type { OrganismStore } from "./OrganismStore";
import { type PhenotypeStore, derivePhenotype } from "./phenotype";

/**
 * Serializable organism state (docs/10 §18).
 *
 * Only the used slot prefix `[0, slotHighWater)` is stored, together with the
 * free-list state. That is the minimum that still restores *exactly*: a
 * deserializer that rebuilt the free list by scanning for dead slots would
 * produce a different reuse order, and the first birth after the load would
 * land in a different slot and diverge (docs/10 §18).
 *
 * The derived phenotype cache is not stored. It is recomputed from the genomes
 * on restore, which is smaller and safer — a stale cache in a save could not
 * then disagree with the genome it claims to describe (docs/10 §8).
 */
export interface OrganismSnapshot {
  capacity: number;
  slotHighWater: number;
  freeSlots: Int32Array;
  nextEntityId: number;
  totalBirths: number;
  totalDeaths: number;
  capRejectedBirths: number;
  birthEnergyDiscarded: number;
  deathsByCause: Uint32Array;

  alive: Uint8Array;
  entityId: Uint32Array;
  parentEntityId: Uint32Array;
  generation: Uint32Array;
  speciesId: Uint32Array;
  x: Int32Array;
  y: Int32Array;
  posFracX: Uint8Array;
  posFracY: Uint8Array;
  vx: Int32Array;
  vy: Int32Array;
  angle: Uint16Array;
  energy: Int32Array;
  healthQ: Uint16Array;
  ageTicks: Uint32Array;
  developmentQ: Uint16Array;
  waterTicks: Uint16Array;
  lastDamageQ: Uint16Array;
  attackCooldown: Uint16Array;
  reproductionCooldown: Uint16Array;
  plantEnergyEaten: Uint32Array;
  meatEnergyEaten: Uint32Array;
  kills: Uint16Array;

  genes: Uint16Array;
  brainWeights: Int16Array;
}

/** Error thrown when an organism snapshot cannot be restored. */
export class OrganismSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganismSnapshotError";
  }
}

export function captureOrganisms(organisms: OrganismStore, genomes: GenomeStore): OrganismSnapshot {
  const used = organisms.slotHighWater;
  return {
    capacity: organisms.capacity,
    slotHighWater: used,
    freeSlots: new Int32Array(organisms.freeSlots.subarray(0, organisms.freeCount)),
    nextEntityId: organisms.nextEntityId,
    totalBirths: organisms.totalBirths,
    totalDeaths: organisms.totalDeaths,
    capRejectedBirths: organisms.capRejectedBirths,
    birthEnergyDiscarded: organisms.birthEnergyDiscarded,
    deathsByCause: new Uint32Array(organisms.deathsByCause),

    alive: new Uint8Array(organisms.alive.subarray(0, used)),
    entityId: new Uint32Array(organisms.entityId.subarray(0, used)),
    parentEntityId: new Uint32Array(organisms.parentEntityId.subarray(0, used)),
    generation: new Uint32Array(organisms.generation.subarray(0, used)),
    speciesId: new Uint32Array(organisms.speciesId.subarray(0, used)),
    x: new Int32Array(organisms.x.subarray(0, used)),
    y: new Int32Array(organisms.y.subarray(0, used)),
    posFracX: new Uint8Array(organisms.posFracX.subarray(0, used)),
    posFracY: new Uint8Array(organisms.posFracY.subarray(0, used)),
    vx: new Int32Array(organisms.vx.subarray(0, used)),
    vy: new Int32Array(organisms.vy.subarray(0, used)),
    angle: new Uint16Array(organisms.angle.subarray(0, used)),
    energy: new Int32Array(organisms.energy.subarray(0, used)),
    healthQ: new Uint16Array(organisms.healthQ.subarray(0, used)),
    ageTicks: new Uint32Array(organisms.ageTicks.subarray(0, used)),
    developmentQ: new Uint16Array(organisms.developmentQ.subarray(0, used)),
    waterTicks: new Uint16Array(organisms.waterTicks.subarray(0, used)),
    lastDamageQ: new Uint16Array(organisms.lastDamageQ.subarray(0, used)),
    attackCooldown: new Uint16Array(organisms.attackCooldown.subarray(0, used)),
    reproductionCooldown: new Uint16Array(organisms.reproductionCooldown.subarray(0, used)),
    plantEnergyEaten: new Uint32Array(organisms.plantEnergyEaten.subarray(0, used)),
    meatEnergyEaten: new Uint32Array(organisms.meatEnergyEaten.subarray(0, used)),
    kills: new Uint16Array(organisms.kills.subarray(0, used)),

    genes: new Uint16Array(genomes.genes.subarray(0, used * GENE_COUNT)),
    brainWeights: new Int16Array(genomes.brainWeights.subarray(0, used * BRAIN_WEIGHT_COUNT)),
  };
}

function checkLength(actual: number, expected: number, name: string): void {
  if (actual !== expected) {
    throw new OrganismSnapshotError(
      `organism snapshot array ${name} has ${actual} entries, expected ${expected}`,
    );
  }
}

/**
 * Rebuild live organism state from a snapshot, validating shape before
 * trusting any of it, then recompute every live slot's phenotype.
 */
export function restoreOrganisms(
  snapshot: OrganismSnapshot,
  organisms: OrganismStore,
  genomes: GenomeStore,
  phenotypes: PhenotypeStore,
  config: DeepReadonly<SimulationConfig>,
): void {
  if (snapshot.capacity !== organisms.capacity) {
    throw new OrganismSnapshotError(
      `organism snapshot capacity ${snapshot.capacity} does not match config ${organisms.capacity}`,
    );
  }
  const used = snapshot.slotHighWater;
  if (!Number.isSafeInteger(used) || used < 0 || used > organisms.capacity) {
    throw new OrganismSnapshotError(`organism snapshot slotHighWater out of range: ${used}`);
  }
  checkLength(snapshot.deathsByCause.length, DEATH_CAUSE_COUNT, "deathsByCause");
  checkLength(snapshot.genes.length, used * GENE_COUNT, "genes");
  checkLength(snapshot.brainWeights.length, used * BRAIN_WEIGHT_COUNT, "brainWeights");

  organisms.reset();

  const perSlot: readonly [ArrayLike<number>, { set(v: ArrayLike<number>): void }, string][] = [
    [snapshot.alive, organisms.alive, "alive"],
    [snapshot.entityId, organisms.entityId, "entityId"],
    [snapshot.parentEntityId, organisms.parentEntityId, "parentEntityId"],
    [snapshot.generation, organisms.generation, "generation"],
    [snapshot.speciesId, organisms.speciesId, "speciesId"],
    [snapshot.x, organisms.x, "x"],
    [snapshot.y, organisms.y, "y"],
    [snapshot.posFracX, organisms.posFracX, "posFracX"],
    [snapshot.posFracY, organisms.posFracY, "posFracY"],
    [snapshot.vx, organisms.vx, "vx"],
    [snapshot.vy, organisms.vy, "vy"],
    [snapshot.angle, organisms.angle, "angle"],
    [snapshot.energy, organisms.energy, "energy"],
    [snapshot.healthQ, organisms.healthQ, "healthQ"],
    [snapshot.ageTicks, organisms.ageTicks, "ageTicks"],
    [snapshot.developmentQ, organisms.developmentQ, "developmentQ"],
    [snapshot.waterTicks, organisms.waterTicks, "waterTicks"],
    [snapshot.lastDamageQ, organisms.lastDamageQ, "lastDamageQ"],
    [snapshot.attackCooldown, organisms.attackCooldown, "attackCooldown"],
    [snapshot.reproductionCooldown, organisms.reproductionCooldown, "reproductionCooldown"],
    [snapshot.plantEnergyEaten, organisms.plantEnergyEaten, "plantEnergyEaten"],
    [snapshot.meatEnergyEaten, organisms.meatEnergyEaten, "meatEnergyEaten"],
    [snapshot.kills, organisms.kills, "kills"],
  ];
  for (const [source, target, name] of perSlot) {
    checkLength(source.length, used, name);
    target.set(source);
  }

  genomes.genes.set(snapshot.genes);
  genomes.brainWeights.set(snapshot.brainWeights);
  organisms.deathsByCause.set(snapshot.deathsByCause);
  organisms.totalBirths = snapshot.totalBirths;
  organisms.totalDeaths = snapshot.totalDeaths;
  organisms.capRejectedBirths = snapshot.capRejectedBirths;
  organisms.birthEnergyDiscarded = snapshot.birthEnergyDiscarded;

  organisms.adoptSlotState(
    used,
    snapshot.freeSlots,
    snapshot.freeSlots.length,
    snapshot.nextEntityId,
  );

  for (let slot = 0; slot < used; slot += 1) {
    if (organisms.alive[slot] === 1) {
      derivePhenotype(phenotypes, genomes, slot, config);
    }
  }
}
