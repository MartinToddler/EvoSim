import { Q, clamp, clampQ, qmul } from "../math/fixed";
import type { EngineContext } from "../EngineContext";
import { bodyMass, currentRadiusPos, maxEnergyForOrganism } from "../organisms/phenotype";
import { contactRadiusPos } from "../morphology/physicalPhenotype";
import { type NearestTarget, findCarcassInMouthRange } from "../spatial/queries";
import { PLANT_RESOURCE_COUNT, RESOURCE_COUNT, Resource } from "../world/resources";

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
 * upside that pays for their higher basal cost. Every channel shares the
 * formula and differs only in its cap and its access factor.
 */
function biteUnits(ctx: EngineContext, slot: number, mass: number, maxUnits: number): number {
  const feeding = ctx.config.organism.feeding;
  const bite =
    feeding.biteBaseUnits + qmul(mass, ctx.phenotypes.biteMassPaceCoeffQ[slot] as number);
  return clamp(bite, 0, maxUnits);
}

/** Maximum plant biomass one organism can take in a tick, before access. */
export function plantBiteUnits(ctx: EngineContext, slot: number, mass: number): number {
  return biteUnits(ctx, slot, mass, ctx.config.organism.feeding.maxPlantBiteUnits);
}

/** Maximum carcass meat one organism can take in a tick. */
export function meatBiteUnits(ctx: EngineContext, slot: number, mass: number): number {
  return biteUnits(ctx, slot, mass, ctx.config.organism.feeding.maxMeatBiteUnits);
}

/**
 * How much of a bite this body can actually apply to one channel (M17).
 *
 * Physical access, as docs/11 §M17 requires — and a *multiplier*, never a gate.
 * Browse is dense material that has to be sheared, so it scales with the mouth
 * M15 already derives; roots have to be excavated, so they scale with the limb
 * investment M15 already bills for. The other three channels are physically
 * easy and their cost lies elsewhere: fruit in travel, defended growth in
 * damage, foliage in nothing at all.
 *
 * Returning a factor rather than a boolean is the whole point. A body with no
 * mouth to speak of still browses, badly, so every intermediate on the way to a
 * browsing lineage has a positive return — which is precisely what the
 * categorical carcass gate got wrong before ADR 0025 removed it.
 */
function accessFactorQ(ctx: EngineContext, slot: number, resource: number): number {
  const { physical } = ctx;
  if (resource === Resource.Browse) {
    return physical.biteFactorQ[slot] as number;
  }
  if (resource === Resource.Roots) {
    return physical.digFactorQ[slot] as number;
  }
  return Q;
}

/**
 * Processing efficiency of one organism for one channel, `[0, Q]`.
 *
 * Every organism has one for every channel, always above zero. There is no
 * lookup that can fail and no organism that "is" one kind of eater.
 */
export function processEfficiencyQ(ctx: EngineContext, slot: number, resource: number): number {
  return ctx.phenotypes.processEfficiencyQ[slot * RESOURCE_COUNT + resource] as number;
}

export function buildFeedingClaims(ctx: EngineContext): void {
  const { organisms, phenotypes, physical, environment, carcasses, scratch, config } = ctx;
  const thresholdQ = config.organism.feeding.eatOutputThresholdQ;
  const massScale = config.organism.massScalePerRadiusSquared;
  const meatEnergyPerUnit = config.plants.meatEnergyPerUnit;
  const { cellCount } = environment;

  scratch.clearPlantDemand();
  scratch.clearCarcassDemand();

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    scratch.feedingRequest[slot] = 0;
    scratch.feedingAllocated[slot] = 0;
    scratch.feedingTargetType[slot] = FeedingTarget.None;
    scratch.feedingTargetIndex[slot] = -1;
    scratch.feedingResource[slot] = Resource.Foliage;
    // Cleared by the phase that fills it, so a slot recycled by a birth cannot
    // inherit the previous occupant's poisoning — the same discipline M16's
    // memory registers needed for the same reason.
    scratch.toxinDamageQ[slot] = 0;

    if (organisms.alive[slot] !== 1 || (scratch.eatQ[slot] as number) < thresholdQ) {
      continue;
    }

    const radius = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const mass = bodyMass(physical, slot, radius, massScale);
    const cell = environment.cellIndexFromPosition(
      organisms.x[slot] as number,
      organisms.y[slot] as number,
    );
    const plantBite = plantBiteUnits(ctx, slot, mass);

    // Rank every channel underfoot by what this body would actually get out of
    // it. Ascending resource order with a strict `>` makes the tie-break the
    // lowest channel index — explicit, as CLAUDE.md requires, and stable.
    let bestResource = -1;
    let bestGain = 0;
    let bestUnits = 0;
    if (plantBite > 0) {
      for (let resource = 0; resource < PLANT_RESOURCE_COUNT; resource += 1) {
        const available = environment.resourceBiomass[resource * cellCount + cell] as number;
        if (available <= 0) {
          continue;
        }
        const reach = qmul(plantBite, accessFactorQ(ctx, slot, resource));
        if (reach <= 0) {
          continue;
        }
        const units = reach < available ? reach : available;
        const profile = config.plants.resources[resource];
        if (profile === undefined) {
          continue;
        }
        const gain = qmul(units * profile.energyPerUnit, processEfficiencyQ(ctx, slot, resource));
        if (gain > bestGain) {
          bestGain = gain;
          bestResource = resource;
          bestUnits = reach;
        }
      }
    }

    // Meat, on the same expected-gain footing as the plant channels (ADR 0025).
    // The gate is an upper bound on what meat could be worth, so skipping the
    // spatial query below it cannot change the decision.
    const meatBite = meatBiteUnits(ctx, slot, mass);
    const meatEfficiencyQ = processEfficiencyQ(ctx, slot, Resource.Meat);
    let carcassSlot = -1;
    if (meatBite > 0 && qmul(meatBite * meatEnergyPerUnit, meatEfficiencyQ) > bestGain) {
      findCarcassInMouthRange(ctx, slot, contactRadiusPos(physical, slot, radius), mouthCarcass);
      if (mouthCarcass.slot !== -1) {
        const remaining = carcasses.remainingMeat[mouthCarcass.slot] as number;
        const meatUnits = meatBite < remaining ? meatBite : remaining;
        const meatGain = qmul(meatUnits * meatEnergyPerUnit, meatEfficiencyQ);
        if (meatGain > bestGain) {
          carcassSlot = mouthCarcass.slot;
        }
      }
    }

    if (carcassSlot !== -1) {
      scratch.feedingRequest[slot] = meatBite;
      scratch.feedingTargetType[slot] = FeedingTarget.Carcass;
      scratch.feedingTargetIndex[slot] = carcassSlot;
      scratch.feedingResource[slot] = Resource.Meat;
      const previousDemand = scratch.carcassDemand[carcassSlot] as number;
      if (previousDemand === 0) {
        scratch.noteDemandedCarcass(carcassSlot);
      }
      scratch.carcassDemand[carcassSlot] = previousDemand + meatBite;
      scratch.claimNext[slot] = scratch.carcassClaimHead[carcassSlot] as number;
      scratch.carcassClaimHead[carcassSlot] = slot;
      continue;
    }

    if (bestResource < 0 || bestUnits <= 0) {
      continue;
    }

    // Demand is aggregated per channel per cell: four organisms grazing the
    // foliage of one cell compete with each other and not with the one digging
    // its roots, because they are taking from different stores.
    const demandIndex = bestResource * cellCount + cell;
    scratch.feedingRequest[slot] = bestUnits;
    scratch.feedingTargetType[slot] = FeedingTarget.Plant;
    scratch.feedingTargetIndex[slot] = demandIndex;
    scratch.feedingResource[slot] = bestResource;
    const previousDemand = scratch.plantDemandPerCell[demandIndex] as number;
    if (previousDemand === 0) {
      scratch.noteDemandedCell(demandIndex);
    }
    scratch.plantDemandPerCell[demandIndex] = previousDemand + bestUnits;
    scratch.claimNext[slot] = scratch.plantClaimHead[demandIndex] as number;
    scratch.plantClaimHead[demandIndex] = slot;
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
  const { organisms, phenotypes, physical, environment, carcasses, species, scratch, config } = ctx;
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
      available = environment.resourceBiomass[index] as number;
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
      const resource = scratch.feedingResource[slot] as number;
      const profile = config.plants.resources[resource];
      if (profile === undefined) {
        continue;
      }
      environment.resourceBiomass[index] =
        (environment.resourceBiomass[index] as number) - allocated;
      gained = qmul(allocated * profile.energyPerUnit, processEfficiencyQ(ctx, slot, resource));
      organisms.plantEnergyEaten[slot] = (organisms.plantEnergyEaten[slot] as number) + gained;
      organisms.resourceEnergyEaten[slot * RESOURCE_COUNT + resource] =
        (organisms.resourceEnergyEaten[slot * RESOURCE_COUNT + resource] as number) + gained;
      // Species-level intake mirrors the per-organism counter exactly; the
      // carnivore-lineage detector reads OBSERVED intake, never a gene
      // (docs/05 §§5, 15).
      species.recordConsumption(organisms.speciesId[slot] as number, gained, 0);

      // Chemically defended growth costs health, reduced by whatever resistance
      // the body carries and never below zero. Damage rather than a refusal to
      // eat: an organism with no resistance CAN take defended growth, and will
      // when nothing better is underfoot — it simply pays for it. That is the
      // trade the channel exists to offer.
      if (profile.toxicityQ > 0) {
        const exposureQ = Q - (phenotypes.toxinResistanceQ[slot] as number);
        const damageQ = qmul(allocated * profile.toxicityQ, clampQ(exposureQ));
        if (damageQ > 0) {
          scratch.toxinDamageQ[slot] = (scratch.toxinDamageQ[slot] as number) + damageQ;
        }
      }
    } else {
      carcasses.consume(index, allocated);
      gained = qmul(allocated * meatEnergyPerUnit, processEfficiencyQ(ctx, slot, Resource.Meat));
      organisms.meatEnergyEaten[slot] = (organisms.meatEnergyEaten[slot] as number) + gained;
      organisms.resourceEnergyEaten[slot * RESOURCE_COUNT + Resource.Meat] =
        (organisms.resourceEnergyEaten[slot * RESOURCE_COUNT + Resource.Meat] as number) + gained;
      species.recordConsumption(organisms.speciesId[slot] as number, 0, gained);
    }

    const radius = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const maxEnergy = maxEnergyForOrganism(
      physical,
      slot,
      bodyMass(physical, slot, radius, massScale),
      config,
    );
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
    // A channel-keyed index (`resource * cellCount + cell`), not a cell (M17).
    // The whole demand pipeline shares this key, so the contested store is one
    // channel of one cell — which is what makes a grazer and a digger standing
    // on the same ground not competitors.
    const demandIndex = scratch.demandedCells[i] as number;
    const biomass = environment.resourceBiomass[demandIndex] as number;
    if ((scratch.plantDemandPerCell[demandIndex] as number) <= biomass) {
      continue;
    }
    distributeRemainder(ctx, scratch.plantClaimHead[demandIndex] as number, biomass);
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
