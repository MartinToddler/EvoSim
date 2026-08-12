import { clamp, qmul } from "../math/fixed";
import type { EngineContext } from "../EngineContext";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "../organisms/phenotype";

/**
 * Plant feeding — phases 8 and 9 of the authoritative tick order
 * (docs/03 §21, docs/10 §12, task D10).
 *
 * Feeding is deliberately NOT applied inside the organism loop. If it were,
 * the organism with the lowest slot index would eat first and could empty a
 * cell before its neighbours were asked, making slot order — an internal
 * storage detail — decide who starves (docs/10 §25 lists this as a mistake to
 * avoid).
 *
 * Instead every eater states a claim, claims are aggregated per environment
 * cell, and the resolution allocates:
 *
 * - if total demand fits in the cell's biomass, everyone is satisfied;
 * - otherwise each claimant gets `floor(request × biomass / demand)`, and the
 *   integer remainder goes one unit at a time to the claimants with the lowest
 *   entity IDs (docs/03 §21).
 *
 * Biomass is conserved exactly: the sum of allocations always equals either
 * the total demand or the cell's entire biomass, never more.
 */

/** What a feeding claim targets. Carcasses arrive with Milestone 5. */
export const FeedingTarget = {
  None: 0,
  Plant: 1,
} as const;

export type FeedingTarget = (typeof FeedingTarget)[keyof typeof FeedingTarget];

/**
 * Maximum biomass one organism can take in a tick (docs/08 §12):
 * `biteBase + mass × biteMassCoeff × pace`, capped by config.
 *
 * Bigger and faster-metabolizing bodies process more per bite, which is the
 * upside that pays for their higher basal cost.
 */
export function plantBiteUnits(ctx: EngineContext, slot: number, mass: number): number {
  const feeding = ctx.config.organism.feeding;
  const bite =
    feeding.biteBaseUnits + qmul(mass, ctx.phenotypes.biteMassPaceCoeffQ[slot] as number);
  return clamp(bite, 0, feeding.maxPlantBiteUnits);
}

/** Phase 8 — every organism whose eat intent clears the threshold states a claim. */
export function buildFeedingClaims(ctx: EngineContext): void {
  const { organisms, phenotypes, environment, scratch, config } = ctx;
  const thresholdQ = config.organism.feeding.eatOutputThresholdQ;
  const massScale = config.organism.massScalePerRadiusSquared;

  scratch.clearPlantDemand();

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    scratch.feedingRequest[slot] = 0;
    scratch.feedingAllocated[slot] = 0;
    scratch.feedingTargetType[slot] = FeedingTarget.None;
    scratch.feedingTargetIndex[slot] = -1;

    if (organisms.alive[slot] !== 1 || (scratch.eatQ[slot] as number) < thresholdQ) {
      continue;
    }

    const cell = environment.cellIndexFromPosition(
      organisms.x[slot] as number,
      organisms.y[slot] as number,
    );
    if ((environment.plantBiomass[cell] as number) <= 0) {
      continue;
    }

    const radius = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const request = plantBiteUnits(ctx, slot, massFromRadiusPos(radius, massScale));
    if (request <= 0) {
      continue;
    }

    scratch.feedingRequest[slot] = request;
    scratch.feedingTargetType[slot] = FeedingTarget.Plant;
    scratch.feedingTargetIndex[slot] = cell;
    const previousDemand = scratch.plantDemandPerCell[cell] as number;
    if (previousDemand === 0) {
      scratch.noteDemandedCell(cell);
    }
    scratch.plantDemandPerCell[cell] = previousDemand + request;
    scratch.claimNext[slot] = scratch.plantClaimHead[cell] as number;
    scratch.plantClaimHead[cell] = slot;
  }
}

/**
 * Phase 9 — allocate the claims, remove the biomass and convert it to energy.
 *
 * Energy gained is `allocated × plantEnergyPerBiomass × plant digestion
 * efficiency` (docs/03 §21), where the efficiency comes from the single signed
 * diet gene: a herbivore specialist converts far more of the same mouthful
 * than a carnivore does (docs/03 §24).
 */
export function resolveFeedingClaims(ctx: EngineContext): void {
  const { organisms, phenotypes, environment, scratch, config } = ctx;
  const energyPerBiomass = config.plants.plantEnergyPerBiomass;
  const massScale = config.organism.massScalePerRadiusSquared;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    const request = scratch.feedingRequest[slot] as number;
    if (request <= 0 || scratch.feedingTargetType[slot] !== FeedingTarget.Plant) {
      continue;
    }
    const cell = scratch.feedingTargetIndex[slot] as number;
    const biomass = environment.plantBiomass[cell] as number;
    const demand = scratch.plantDemandPerCell[cell] as number;
    scratch.feedingAllocated[slot] =
      demand <= biomass ? request : Math.trunc((request * biomass) / demand);
  }

  distributeRemainders(ctx);

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    const allocated = scratch.feedingAllocated[slot] as number;
    if (allocated <= 0) {
      continue;
    }
    const cell = scratch.feedingTargetIndex[slot] as number;
    environment.plantBiomass[cell] = (environment.plantBiomass[cell] as number) - allocated;

    const gained = qmul(allocated * energyPerBiomass, phenotypes.plantEfficiencyQ[slot] as number);
    const radius = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const maxEnergy = maxEnergyForMass(massFromRadiusPos(radius, massScale), config);
    organisms.energy[slot] = Math.min((organisms.energy[slot] as number) + gained, maxEnergy);
    organisms.plantEnergyEaten[slot] = (organisms.plantEnergyEaten[slot] as number) + gained;
  }
}

/**
 * Hand out the units that proportional rounding left over, one per claimant in
 * ascending entity ID order (docs/03 §21).
 *
 * Ascending ENTITY ID, not ascending slot: slots are recycled, so slot order
 * carries the accident of who died recently, while entity IDs are a stable
 * birth order. The two coincide until the first death, which is exactly why
 * this has to be written down rather than discovered later.
 *
 * Claimants are reached through the per-cell chain built in phase 8, so the
 * total work is proportional to the number of eaters rather than to
 * cells × population. Only contested cells reach the sort, and a contested
 * cell holds a handful of claimants, so an insertion sort over the scratch
 * buffer is the right shape: no allocation, and no cost for the overwhelming
 * majority of cells.
 */
function distributeRemainders(ctx: EngineContext): void {
  const { organisms, environment, scratch } = ctx;

  for (let i = 0; i < scratch.demandedCellCount; i += 1) {
    const cell = scratch.demandedCells[i] as number;
    const biomass = environment.plantBiomass[cell] as number;
    const demand = scratch.plantDemandPerCell[cell] as number;
    if (demand <= biomass) {
      continue;
    }

    // Collect this cell's claimants, ordered by entity ID as they are inserted.
    let count = 0;
    let allocated = 0;
    for (
      let slot = scratch.plantClaimHead[cell] as number;
      slot !== -1;
      slot = scratch.claimNext[slot] as number
    ) {
      allocated += scratch.feedingAllocated[slot] as number;
      const id = organisms.entityId[slot] as number;
      let insertAt = count;
      while (
        insertAt > 0 &&
        (organisms.entityId[scratch.claimants[insertAt - 1] as number] as number) > id
      ) {
        scratch.claimants[insertAt] = scratch.claimants[insertAt - 1] as number;
        insertAt -= 1;
      }
      scratch.claimants[insertAt] = slot;
      count += 1;
    }

    let remainder = biomass - allocated;
    for (let c = 0; c < count && remainder > 0; c += 1) {
      const slot = scratch.claimants[c] as number;
      // Never hand anyone more than they asked for.
      if ((scratch.feedingAllocated[slot] as number) < (scratch.feedingRequest[slot] as number)) {
        scratch.feedingAllocated[slot] = (scratch.feedingAllocated[slot] as number) + 1;
        remainder -= 1;
      }
    }
  }
}

/** Total biomass allocated this tick; diagnostics and conservation tests. */
export function totalAllocatedBiomass(ctx: EngineContext): number {
  let total = 0;
  for (let slot = 0; slot < ctx.organisms.slotHighWater; slot += 1) {
    total += ctx.scratch.feedingAllocated[slot] as number;
  }
  return total;
}
