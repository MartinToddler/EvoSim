import { clamp, qmul } from "../math/fixed";
import type { EngineContext } from "../EngineContext";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "../organisms/phenotype";
import { type NearestTarget, findCarcassInMouthRange } from "../spatial/queries";

/**
 * Feeding — phases 8 and 9 of the authoritative tick order (docs/03 §§21, 23–24,
 * docs/04 §20, docs/10 §12, tasks D10/F02/F03).
 *
 * Feeding is deliberately NOT applied inside the organism loop. If it were,
 * the organism with the lowest slot index would eat first and could empty a
 * cell or a carcass before its neighbours were asked, making slot order — an
 * internal storage detail — decide who starves (docs/10 §25 lists this as a
 * mistake to avoid).
 *
 * Instead every eater states a claim, claims are aggregated per food source, and
 * the resolution allocates:
 *
 * - if total demand fits in what the source holds, everyone is satisfied;
 * - otherwise each claimant gets `floor(request × available / demand)`, and the
 *   integer remainder goes one unit at a time to the claimants with the lowest
 *   entity IDs (docs/03 §21).
 *
 * Plant biomass and carcass meat use the *same* rule, deliberately: a body being
 * eaten by four scavengers is the same allocation problem as a cell being grazed
 * by four herbivores, and giving carrion its own policy would be a hidden
 * advantage for whoever happened to be stored first.
 *
 * Both resources are conserved exactly: the sum of allocations always equals
 * either the total demand or everything the source had, never more.
 */

/** What a feeding claim targets. */
export const FeedingTarget = {
  None: 0,
  Plant: 1,
  Carcass: 2,
} as const;

export type FeedingTarget = (typeof FeedingTarget)[keyof typeof FeedingTarget];

/** Reused across the claim loop so the hot path allocates nothing. */
const mouthCarcass: NearestTarget = { slot: -1, distSq: 0 };

/**
 * Maximum units one organism can take in a tick (docs/08 §12):
 * `biteBase + mass × biteMassCoeff × pace`, capped by config.
 *
 * Bigger and faster-metabolizing bodies process more per bite, which is the
 * upside that pays for their higher basal cost. Plants and meat share the
 * formula and differ only in their cap.
 */
function biteUnits(ctx: EngineContext, slot: number, mass: number, maxUnits: number): number {
  const feeding = ctx.config.organism.feeding;
  const bite =
    feeding.biteBaseUnits + qmul(mass, ctx.phenotypes.biteMassPaceCoeffQ[slot] as number);
  return clamp(bite, 0, maxUnits);
}

/** Maximum plant biomass one organism can take in a tick. */
export function plantBiteUnits(ctx: EngineContext, slot: number, mass: number): number {
  return biteUnits(ctx, slot, mass, ctx.config.organism.feeding.maxPlantBiteUnits);
}

/** Maximum carcass meat one organism can take in a tick. */
export function meatBiteUnits(ctx: EngineContext, slot: number, mass: number): number {
  return biteUnits(ctx, slot, mass, ctx.config.organism.feeding.maxMeatBiteUnits);
}

/**
 * Phase 8 — every organism whose eat intent clears the threshold states one
 * claim, against one food source.
 *
 * ## The food-target policy (docs/04 §20)
 *
 * > If a carcass is in mouth range and meat efficiency >= plant efficiency,
 * > attempt the carcass; otherwise attempt the plant cell.
 *
 * This is implemented exactly as specified, and the specification asks for it to
 * be documented because it shapes the ecology:
 *
 * - there is one `eat` output, so the *engine* picks the target, not the brain.
 *   A second output would be a brain format change (docs/04 §10);
 * - the comparison is between the organism's own two digestion efficiencies,
 *   which come from the single signed diet gene (docs/03 §24). A herbivore-leaning
 *   organism therefore ignores carrion it is standing on and grazes instead —
 *   even on a stripped cell, where it gets nothing. That is a real cost of
 *   specialization and it is the doc's intent: meat is not a free fallback that
 *   every genome gets to keep;
 * - a carnivore-leaning organism prefers meat when it is under its mouth and
 *   grazes at its poor plant efficiency the rest of the time. Nothing declares it
 *   a carnivore: `dietQ > 0` is what makes `meatEfficiency >= plantEfficiency`
 *   true, and mutation is what moves `dietQ`.
 */
export function buildFeedingClaims(ctx: EngineContext): void {
  const { organisms, phenotypes, environment, scratch, config } = ctx;
  const thresholdQ = config.organism.feeding.eatOutputThresholdQ;
  const massScale = config.organism.massScalePerRadiusSquared;

  scratch.clearPlantDemand();
  scratch.clearCarcassDemand();

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    scratch.feedingRequest[slot] = 0;
    scratch.feedingAllocated[slot] = 0;
    scratch.feedingTargetType[slot] = FeedingTarget.None;
    scratch.feedingTargetIndex[slot] = -1;

    if (organisms.alive[slot] !== 1 || (scratch.eatQ[slot] as number) < thresholdQ) {
      continue;
    }

    const radius = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const mass = massFromRadiusPos(radius, massScale);

    if (
      (phenotypes.meatEfficiencyQ[slot] as number) >= (phenotypes.plantEfficiencyQ[slot] as number)
    ) {
      findCarcassInMouthRange(ctx, slot, radius, mouthCarcass);
      const carcassSlot = mouthCarcass.slot;
      if (carcassSlot !== -1) {
        const request = meatBiteUnits(ctx, slot, mass);
        if (request > 0) {
          scratch.feedingRequest[slot] = request;
          scratch.feedingTargetType[slot] = FeedingTarget.Carcass;
          scratch.feedingTargetIndex[slot] = carcassSlot;
          const previousDemand = scratch.carcassDemand[carcassSlot] as number;
          if (previousDemand === 0) {
            scratch.noteDemandedCarcass(carcassSlot);
          }
          scratch.carcassDemand[carcassSlot] = previousDemand + request;
          scratch.claimNext[slot] = scratch.carcassClaimHead[carcassSlot] as number;
          scratch.carcassClaimHead[carcassSlot] = slot;
        }
        continue;
      }
    }

    const cell = environment.cellIndexFromPosition(
      organisms.x[slot] as number,
      organisms.y[slot] as number,
    );
    if ((environment.plantBiomass[cell] as number) <= 0) {
      continue;
    }

    const request = plantBiteUnits(ctx, slot, mass);
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
 * Phase 9 — allocate the claims, remove the food and convert it to energy.
 *
 * Energy gained is `allocated × energyPerUnit × digestion efficiency`
 * (docs/03 §§21, 24), where the efficiency comes from the single signed diet
 * gene: a herbivore specialist converts far more of the same mouthful of grass
 * than a carnivore does, and the reverse holds for meat.
 */
export function resolveFeedingClaims(ctx: EngineContext): void {
  const { organisms, phenotypes, environment, carcasses, species, scratch, config } = ctx;
  const plantEnergyPerUnit = config.plants.plantEnergyPerBiomass;
  const meatEnergyPerUnit = config.plants.meatEnergyPerUnit;
  const massScale = config.organism.massScalePerRadiusSquared;

  // Proportional share, before the remainder pass.
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    const request = scratch.feedingRequest[slot] as number;
    if (request <= 0) {
      continue;
    }
    const target = scratch.feedingTargetType[slot];
    const index = scratch.feedingTargetIndex[slot] as number;
    let available: number;
    let demand: number;
    if (target === FeedingTarget.Plant) {
      available = environment.plantBiomass[index] as number;
      demand = scratch.plantDemandPerCell[index] as number;
    } else if (target === FeedingTarget.Carcass) {
      available = carcasses.remainingMeat[index] as number;
      demand = scratch.carcassDemand[index] as number;
    } else {
      continue;
    }
    scratch.feedingAllocated[slot] =
      demand <= available ? request : Math.trunc((request * available) / demand);
  }

  distributePlantRemainders(ctx);
  distributeCarcassRemainders(ctx);

  // Apply: take the food, convert it, and clamp to the eater's own capacity.
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    const allocated = scratch.feedingAllocated[slot] as number;
    if (allocated <= 0) {
      continue;
    }
    const target = scratch.feedingTargetType[slot];
    const index = scratch.feedingTargetIndex[slot] as number;

    let gained: number;
    if (target === FeedingTarget.Plant) {
      environment.plantBiomass[index] = (environment.plantBiomass[index] as number) - allocated;
      gained = qmul(allocated * plantEnergyPerUnit, phenotypes.plantEfficiencyQ[slot] as number);
      organisms.plantEnergyEaten[slot] = (organisms.plantEnergyEaten[slot] as number) + gained;
      // Species-level intake mirrors the per-organism counter exactly; the
      // carnivore-lineage detector reads OBSERVED intake, never the diet gene
      // (docs/05 §§5, 15).
      species.recordConsumption(organisms.speciesId[slot] as number, gained, 0);
    } else {
      carcasses.consume(index, allocated);
      gained = qmul(allocated * meatEnergyPerUnit, phenotypes.meatEfficiencyQ[slot] as number);
      organisms.meatEnergyEaten[slot] = (organisms.meatEnergyEaten[slot] as number) + gained;
      species.recordConsumption(organisms.speciesId[slot] as number, 0, gained);
    }

    const radius = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const maxEnergy = maxEnergyForMass(massFromRadiusPos(radius, massScale), config);
    organisms.energy[slot] = Math.min((organisms.energy[slot] as number) + gained, maxEnergy);
  }

  // A carcass eaten to nothing stops existing. Done after the whole apply pass
  // rather than inside it, so no claimant can find its target released
  // mid-allocation.
  for (let i = 0; i < scratch.demandedCarcassCount; i += 1) {
    const carcass = scratch.demandedCarcasses[i] as number;
    if (carcasses.active[carcass] === 1 && (carcasses.remainingMeat[carcass] as number) <= 0) {
      carcasses.release(carcass);
    }
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
 * Claimants are reached through the per-source chain built in phase 8, so the
 * total work is proportional to the number of eaters rather than to
 * sources × population. Only contested sources reach the sort, and a contested
 * source holds a handful of claimants, so an insertion sort over the scratch
 * buffer is the right shape: no allocation, and no cost for the overwhelming
 * majority of sources.
 */
function distributeRemainder(ctx: EngineContext, headSlot: number, available: number): void {
  const { organisms, scratch } = ctx;

  let count = 0;
  let allocated = 0;
  for (let slot = headSlot; slot !== -1; slot = scratch.claimNext[slot] as number) {
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

  let remainder = available - allocated;
  for (let c = 0; c < count && remainder > 0; c += 1) {
    const slot = scratch.claimants[c] as number;
    // Never hand anyone more than they asked for.
    if ((scratch.feedingAllocated[slot] as number) < (scratch.feedingRequest[slot] as number)) {
      scratch.feedingAllocated[slot] = (scratch.feedingAllocated[slot] as number) + 1;
      remainder -= 1;
    }
  }
}

function distributePlantRemainders(ctx: EngineContext): void {
  const { environment, scratch } = ctx;
  for (let i = 0; i < scratch.demandedCellCount; i += 1) {
    const cell = scratch.demandedCells[i] as number;
    const biomass = environment.plantBiomass[cell] as number;
    if ((scratch.plantDemandPerCell[cell] as number) <= biomass) {
      continue;
    }
    distributeRemainder(ctx, scratch.plantClaimHead[cell] as number, biomass);
  }
}

function distributeCarcassRemainders(ctx: EngineContext): void {
  const { carcasses, scratch } = ctx;
  for (let i = 0; i < scratch.demandedCarcassCount; i += 1) {
    const carcass = scratch.demandedCarcasses[i] as number;
    const meat = carcasses.remainingMeat[carcass] as number;
    if ((scratch.carcassDemand[carcass] as number) <= meat) {
      continue;
    }
    distributeRemainder(ctx, scratch.carcassClaimHead[carcass] as number, meat);
  }
}

/** Total units allocated this tick against one food kind; conservation tests. */
function totalAllocated(ctx: EngineContext, target: FeedingTarget): number {
  let total = 0;
  for (let slot = 0; slot < ctx.organisms.slotHighWater; slot += 1) {
    if (ctx.scratch.feedingTargetType[slot] === target) {
      total += ctx.scratch.feedingAllocated[slot] as number;
    }
  }
  return total;
}

/**
 * Total plant biomass allocated this tick.
 *
 * Filtered by target kind rather than summing the allocation array, because
 * biomass units and meat units are different quantities and a single total over
 * both would be a number with no meaning.
 */
export function totalAllocatedBiomass(ctx: EngineContext): number {
  return totalAllocated(ctx, FeedingTarget.Plant);
}

/** Total carcass meat allocated this tick. */
export function totalAllocatedMeat(ctx: EngineContext): number {
  return totalAllocated(ctx, FeedingTarget.Carcass);
}
