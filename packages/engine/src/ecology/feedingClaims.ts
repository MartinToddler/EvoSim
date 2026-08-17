import { clamp, qmul } from "../math/fixed";
import type { EngineContext } from "../EngineContext";
import { bodyMass, currentRadiusPos, maxEnergyForOrganism } from "../organisms/phenotype";
import { contactRadiusPos } from "../morphology/physicalPhenotype";
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
 * ## The food-target policy (docs/04 §20, amended by ADR 0025)
 *
 * The engine compares the **expected obtainable energy** of the two candidate
 * sources and claims the better one:
 *
 * ```text
 * expectedGain = min(bite, locally available) × sourceEnergyPerUnit × ownDigestionEfficiency
 * ```
 *
 * On an exact tie the plant is chosen — an explicit, documented tie-break that
 * keeps the herbivorous status quo (CLAUDE.md requires ties to be explicit).
 *
 * This replaces the original categorical rule ("carcass only when meat
 * efficiency >= plant efficiency"), which created a measured fitness valley:
 * a herbivore-leaning organism ignored carrion it was standing on even when the
 * cell under it was stripped bare, so twelve calibration seeds ate almost no
 * meat in 10 000 ticks and scavenging intermediates were unreachable
 * (ADR 0021 §5d). Under the expected-gain rule:
 *
 * - there is still one `eat` output, and the *engine* still picks the target,
 *   not the brain. A second output would be a brain format change (docs/04 §10);
 * - a herbivore on a rich cell still grazes: its plant gain dwarfs what its
 *   poor meat digestion could extract from a body. Specialization keeps its
 *   value — meat is a poor fallback for a herbivore, not a free lunch;
 * - a herbivore on a stripped cell beside a carcass now scavenges it,
 *   inefficiently, because a bad meal beats no meal. That is the general rule
 *   that makes scavenging intermediates evolutionarily reachable without
 *   declaring anyone a carnivore;
 * - a carnivore-leaning organism prefers meat exactly when meat is worth more
 *   to it than the grass underfoot, including abandoning a nearly-empty
 *   carcass for a rich cell. Nothing declares it a carnivore: mutation moves
 *   `dietQ`, and `dietQ` moves the two efficiencies.
 *
 * The carcass query is gated by an upper bound: a full meat bite at the eater's
 * own efficiency. When even that ceiling cannot beat the plant gain the spatial
 * query is skipped — a pure optimization that cannot change the chosen target,
 * so a herbivore surrounded by grass costs exactly what it did before.
 */
export function buildFeedingClaims(ctx: EngineContext): void {
  const { organisms, phenotypes, physical, environment, carcasses, scratch, config } = ctx;
  const thresholdQ = config.organism.feeding.eatOutputThresholdQ;
  const massScale = config.organism.massScalePerRadiusSquared;
  const plantEnergyPerUnit = config.plants.plantEnergyPerBiomass;
  const meatEnergyPerUnit = config.plants.meatEnergyPerUnit;

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
    const mass = bodyMass(physical, slot, radius, massScale);

    // Expected obtainable energy from the cell underfoot. "Obtainable" is
    // bounded by what the cell actually holds, which is exactly what the old
    // categorical rule ignored: a stripped cell promises nothing.
    const cell = environment.cellIndexFromPosition(
      organisms.x[slot] as number,
      organisms.y[slot] as number,
    );
    const cellBiomass = environment.plantBiomass[cell] as number;
    const plantBite = plantBiteUnits(ctx, slot, mass);
    const plantUnits = plantBite < cellBiomass ? plantBite : cellBiomass;
    const plantGain =
      plantUnits <= 0
        ? 0
        : qmul(plantUnits * plantEnergyPerUnit, phenotypes.plantEfficiencyQ[slot] as number);

    // The meat option's ceiling: a full bite at own efficiency. Only when the
    // ceiling could beat the plant gain is the mouth-range query worth running;
    // skipping it below the ceiling cannot change the decision.
    const meatBite = meatBiteUnits(ctx, slot, mass);
    const meatEfficiencyQ = phenotypes.meatEfficiencyQ[slot] as number;
    let carcassSlot = -1;
    if (meatBite > 0 && qmul(meatBite * meatEnergyPerUnit, meatEfficiencyQ) > plantGain) {
      findCarcassInMouthRange(ctx, slot, contactRadiusPos(physical, slot, radius), mouthCarcass);
      if (mouthCarcass.slot !== -1) {
        const remaining = carcasses.remainingMeat[mouthCarcass.slot] as number;
        const meatUnits = meatBite < remaining ? meatBite : remaining;
        const meatGain = qmul(meatUnits * meatEnergyPerUnit, meatEfficiencyQ);
        if (meatGain > plantGain) {
          carcassSlot = mouthCarcass.slot;
        }
      }
    }

    if (carcassSlot !== -1) {
      scratch.feedingRequest[slot] = meatBite;
      scratch.feedingTargetType[slot] = FeedingTarget.Carcass;
      scratch.feedingTargetIndex[slot] = carcassSlot;
      const previousDemand = scratch.carcassDemand[carcassSlot] as number;
      if (previousDemand === 0) {
        scratch.noteDemandedCarcass(carcassSlot);
      }
      scratch.carcassDemand[carcassSlot] = previousDemand + meatBite;
      scratch.claimNext[slot] = scratch.carcassClaimHead[carcassSlot] as number;
      scratch.carcassClaimHead[carcassSlot] = slot;
      continue;
    }

    if (plantUnits <= 0 || plantBite <= 0) {
      continue;
    }

    scratch.feedingRequest[slot] = plantBite;
    scratch.feedingTargetType[slot] = FeedingTarget.Plant;
    scratch.feedingTargetIndex[slot] = cell;
    const previousDemand = scratch.plantDemandPerCell[cell] as number;
    if (previousDemand === 0) {
      scratch.noteDemandedCell(cell);
    }
    scratch.plantDemandPerCell[cell] = previousDemand + plantBite;
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
  const { organisms, phenotypes, physical, environment, carcasses, species, scratch, config } = ctx;
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
