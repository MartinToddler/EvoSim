import { assert, type DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import {
  ANGLE_STEPS,
  POS_SCALE,
  Q,
  TRIG_SCALE,
  clamp,
  clampQ,
  clampSignedQ,
  qmul,
} from "../math/fixed";
import { cosLut } from "../math/trigLut";
import type { PhysicalPhenotypeStore } from "../morphology/physicalPhenotype";
import { FOV_COS_SCALE } from "../spatial/fov";
import {
  Gene,
  accelerationVel,
  adultRadiusPos,
  digestionEfficiencyQ,
  effectiveMaxSpeedVel,
  effectiveMaxTurnSteps,
  geneMaxSpeedVel,
  geneMaxTurnSteps,
  geneToQ,
  hueDegrees,
  maturityAgeTicks,
  maxAgeTicks,
  metabolicPaceQ,
  offspringInvestmentQ,
  thermalOptimumCentiC,
  thermalToleranceCentiC,
  visionFovSteps,
  visionRangePos,
} from "../genetics/genes";
import { FOUNDER_PROCESS_TOTAL_Q } from "../genetics/founderGenome";
import type { GenomeStore } from "./GenomeStore";
import { PLANT_RESOURCE_COUNT, RESOURCE_COUNT, Resource } from "../world/resources";

/**
 * Derived phenotype cache (docs/10 §8, task D02/D03).
 *
 * A genome never changes during an organism's life, so every mapping from
 * genes to traits is computed once at spawn and read from here afterwards
 * instead of being recomputed 20 times per tick per organism.
 *
 * This is a DERIVED cache, on the same footing as the environment's
 * passability and gradient arrays: it is a pure function of the genome plus
 * the config, so it is neither hashed nor serialized, and it is recomputed for
 * every live slot on snapshot restore (docs/10 §8 prefers recompute over
 * duplication). Anything that changes during life — current radius, mass,
 * maximum energy — is computed from `developmentQ` on demand and is NOT cached
 * here.
 */
export class PhenotypeStore {
  readonly capacity: number;

  /** Body radius at full development, in world sub-units. */
  readonly adultRadiusPos: Uint16Array;
  /** Maximum speed in velocity units, after the armor penalty. */
  readonly maxSpeedVel: Uint16Array;
  /** Acceleration in velocity units per tick. */
  readonly accelerationVel: Uint16Array;
  /** Maximum heading change per tick, after the size penalty. */
  readonly maxTurnSteps: Uint16Array;
  /** Vision range in world sub-units. */
  readonly visionRangePos: Uint16Array;
  /** Half the field of view, in heading steps: the visibility test bound. */
  readonly visionHalfFovSteps: Uint16Array;
  /**
   * Cosine of the half field of view, scaled by {@link FOV_COS_SCALE}.
   *
   * Cached because the visibility test compares squared quantities to avoid a
   * square root per candidate, and a coarse cosine scale is what keeps that
   * squared comparison inside exact integer range (see spatial/queries.ts).
   */
  readonly visionCosHalfFov: Int16Array;

  /** Signed diet in [-Q, Q]; -Q herbivore specialist, +Q carnivore specialist. */
  readonly dietQ: Int16Array;
  /** Digestion efficiency for plant matter, Q-scaled. */
  /**
   * Processing efficiency for every channel, `capacity * RESOURCE_COUNT` in
   * resource-major-per-slot order: `slot * RESOURCE_COUNT + resource` (M17).
   *
   * Slot-major here, unlike the environment's resource-major fields, because
   * every read is "all six channels for one organism" — the feeding phase ranks
   * a single eater's options — where the environment's reads are "one channel
   * across every cell".
   */
  readonly processEfficiencyQ: Uint16Array;
  /** How much of defended growth's toxicity this body shrugs off, `[0, Q]`. */
  readonly toxinResistanceQ: Uint16Array;
  /** Digestion efficiency for meat, Q-scaled. */

  readonly attackQ: Uint16Array;
  readonly armorQ: Uint16Array;
  readonly metabolicPaceQ: Uint16Array;
  readonly thermalOptimumCentiC: Int16Array;
  readonly thermalToleranceCentiC: Uint16Array;
  readonly maturityAgeTicks: Uint16Array;
  readonly maxAgeTicks: Uint16Array;
  readonly offspringInvestmentQ: Uint16Array;
  readonly hueDegrees: Uint16Array;

  /**
   * Everything in the basal cost that scales with mass, collapsed into one
   * Q coefficient: pace, muscle capacity, attack, armor, tolerance and
   * longevity maintenance (docs/08 §9). Per-tick basal is then
   * `mass * basalMassCoeffQ / Q + basalVisionCost`.
   */
  readonly basalMassCoeffQ: Uint16Array;
  /** The one basal term that does not scale with mass: vision maintenance. */
  readonly basalVisionCost: Uint16Array;
  /** Bite size mass coefficient premultiplied by metabolic pace (docs/08 §12). */
  readonly biteMassPaceCoeffQ: Uint16Array;

  constructor(capacity: number) {
    assert(
      Number.isSafeInteger(capacity) && capacity > 0,
      `phenotype capacity must be positive, got ${capacity}`,
    );
    this.capacity = capacity;
    this.adultRadiusPos = new Uint16Array(capacity);
    this.maxSpeedVel = new Uint16Array(capacity);
    this.accelerationVel = new Uint16Array(capacity);
    this.maxTurnSteps = new Uint16Array(capacity);
    this.visionRangePos = new Uint16Array(capacity);
    this.visionHalfFovSteps = new Uint16Array(capacity);
    this.visionCosHalfFov = new Int16Array(capacity);
    this.dietQ = new Int16Array(capacity);
    this.processEfficiencyQ = new Uint16Array(capacity * RESOURCE_COUNT);
    this.toxinResistanceQ = new Uint16Array(capacity);

    this.attackQ = new Uint16Array(capacity);
    this.armorQ = new Uint16Array(capacity);
    this.metabolicPaceQ = new Uint16Array(capacity);
    this.thermalOptimumCentiC = new Int16Array(capacity);
    this.thermalToleranceCentiC = new Uint16Array(capacity);
    this.maturityAgeTicks = new Uint16Array(capacity);
    this.maxAgeTicks = new Uint16Array(capacity);
    this.offspringInvestmentQ = new Uint16Array(capacity);
    this.hueDegrees = new Uint16Array(capacity);
    this.basalMassCoeffQ = new Uint16Array(capacity);
    this.basalVisionCost = new Uint16Array(capacity);
    this.biteMassPaceCoeffQ = new Uint16Array(capacity);
  }
}

/**
 * Recompute one slot's phenotype from its genome and its developed body.
 *
 * Called at spawn and for every live slot after a snapshot restore. Every
 * value derives from the genome, the body that genome grew and the config —
 * no world state, no position, no history — which is what makes the cache safe
 * to leave out of the state hash.
 *
 * M15 folded the physical phenotype in here rather than beside it. The genetic
 * mapping and the morphological multiplier for a quantity are two halves of the
 * same number, and storing them apart would leave every consumer free to read
 * one and forget the other — which is precisely how a picture and a simulation
 * drift apart. There is one effective maximum speed, one effective armor value
 * and one effective vision range, and they live where they always did.
 */
export function derivePhenotype(
  phenotypes: PhenotypeStore,
  genomes: GenomeStore,
  physical: PhysicalPhenotypeStore,
  slot: number,
  config: DeepReadonly<SimulationConfig>,
): void {
  const ranges = config.organism.geneRanges;
  const base = genomes.geneOffset(slot);
  const raw = genomes.genes;

  const sizeQ = geneToQ(raw[base + Gene.AdultSize] as number);
  const speedGeneQ = geneToQ(raw[base + Gene.MaxSpeed] as number);
  const accelQ = geneToQ(raw[base + Gene.Acceleration] as number);
  const turnQ = geneToQ(raw[base + Gene.TurnRate] as number);
  const visionQ = geneToQ(raw[base + Gene.VisionRange] as number);
  const fovQ = geneToQ(raw[base + Gene.VisionFov] as number);
  const attackQ = geneToQ(raw[base + Gene.AttackPower] as number);
  const armorQ = geneToQ(raw[base + Gene.Armor] as number);
  const paceGeneQ = geneToQ(raw[base + Gene.MetabolicPace] as number);
  const thermalOptQ = geneToQ(raw[base + Gene.ThermalOptimum] as number);
  const toleranceGeneQ = geneToQ(raw[base + Gene.ThermalTolerance] as number);
  const maturityQ = geneToQ(raw[base + Gene.MaturityAge] as number);
  const maxAgeQ = geneToQ(raw[base + Gene.MaxAge] as number);
  const investmentQ = geneToQ(raw[base + Gene.OffspringInvestment] as number);
  const hueQ = geneToQ(raw[base + Gene.Hue] as number);

  const paceQ = metabolicPaceQ(paceGeneQ, ranges);

  // M15: the body's multipliers on the genetic mapping. Every one of these is
  // exactly Q for the founder morphology, so an unmutated world is the ecology
  // Milestones 0–13 calibrated.
  const speedFactorQ = physical.maxSpeedFactorQ[slot] as number;
  const accelFactorQ = physical.accelFactorQ[slot] as number;
  const turnFactorQ = physical.turnFactorQ[slot] as number;
  const visionRangeFactorQ = physical.visionRangeFactorQ[slot] as number;
  const visionFovFactorQ = physical.visionFovFactorQ[slot] as number;

  phenotypes.adultRadiusPos[slot] = adultRadiusPos(sizeQ, ranges);
  phenotypes.maxSpeedVel[slot] = clamp(
    qmul(effectiveMaxSpeedVel(geneMaxSpeedVel(speedGeneQ, ranges), armorQ, config), speedFactorQ),
    0,
    65535,
  );
  phenotypes.accelerationVel[slot] = clamp(
    qmul(accelerationVel(accelQ, ranges), accelFactorQ),
    0,
    65535,
  );
  phenotypes.maxTurnSteps[slot] = clamp(
    qmul(effectiveMaxTurnSteps(geneMaxTurnSteps(turnQ, ranges), sizeQ, config), turnFactorQ),
    0,
    ANGLE_STEPS >> 1,
  );
  // A cone wider than a full turn is not wider than a full turn, so the half
  // angle stops at a half turn; clamping here rather than in the visibility
  // test keeps the cached cosine and the stored angle describing the same cone.
  const halfFovSteps = clamp(
    qmul(visionFovSteps(fovQ, ranges) >> 1, visionFovFactorQ),
    0,
    ANGLE_STEPS >> 1,
  );
  phenotypes.visionRangePos[slot] = clamp(
    qmul(visionRangePos(visionQ, ranges), visionRangeFactorQ),
    0,
    65535,
  );
  phenotypes.visionHalfFovSteps[slot] = halfFovSteps;
  phenotypes.visionCosHalfFov[slot] = Math.trunc(
    (cosLut(halfFovSteps) * FOV_COS_SCALE) / TRIG_SCALE,
  );

  // M17 processing. One efficiency per channel, each from its own locus, each
  // floored well above zero so no channel is ever inedible — a categorical
  // "you cannot process this" is the fitness-valley defect ADR 0025 removed
  // from carcass feeding, and five more of them would be five times the defect.
  const { digestionEfficiencyFloorQ, digestionEfficiencySpanQ } = config.organism.feeding;
  const efficiencyBase = slot * RESOURCE_COUNT;
  let processTotalQ = 0;
  for (let resource = 0; resource < RESOURCE_COUNT; resource += 1) {
    const processQ = geneToQ(raw[base + Gene.Process + resource] as number);
    processTotalQ += processQ;
    phenotypes.processEfficiencyQ[efficiencyBase + resource] = digestionEfficiencyQ(
      processQ,
      digestionEfficiencyFloorQ,
      digestionEfficiencySpanQ,
    );
  }

  const toxinResistanceQ = geneToQ(raw[base + Gene.ToxinResistance] as number);
  phenotypes.toxinResistanceQ[slot] = toxinResistanceQ;

  // The plant↔meat axis, kept as a DERIVED SUMMARY of the six loci (M17).
  //
  // Milestones 0-16 had this as the `diet` gene itself; M17 removed it, and the
  // five consumers that outlived it — the speciation trait vector, the
  // carnivore-lineage badge, organism colouring and the inspector — would
  // otherwise have read a field nothing writes and seen every organism as
  // exactly diet-neutral forever. Silently, and without failing a test.
  //
  // Meat processing against the BEST plant channel, which preserves the old
  // meaning exactly: -Q is a plant specialist, +Q a meat specialist, 0
  // balanced. Comparing against foliage alone would call a fruit specialist a
  // carnivore. Nothing authoritative reads this — it summarizes the genome for
  // observers, and the feeding phase uses the loci themselves.
  let bestPlantProcessQ = 0;
  for (let resource = 0; resource < PLANT_RESOURCE_COUNT; resource += 1) {
    const processQ = geneToQ(raw[base + Gene.Process + resource] as number);
    if (processQ > bestPlantProcessQ) {
      bestPlantProcessQ = processQ;
    }
  }
  const meatProcessQ = geneToQ(raw[base + Gene.Process + Resource.Meat] as number);
  phenotypes.dietQ[slot] = clampSignedQ(meatProcessQ - bestPlantProcessQ);

  // Effective attack and armor: what the mouth can bite with and what the
  // plating actually stops. The genetic value is the investment, the
  // morphological factor is how much of it the body expresses — and because
  // these effective values feed the basal coefficients below, a bigger jaw or
  // heavier plating raises its own upkeep rather than being free.
  const effectiveAttackQ = clampQ(qmul(attackQ, physical.attackFactorQ[slot] as number));
  const effectiveArmorQ = clampQ(qmul(armorQ, physical.armorFactorQ[slot] as number));
  phenotypes.attackQ[slot] = effectiveAttackQ;
  phenotypes.armorQ[slot] = effectiveArmorQ;
  phenotypes.metabolicPaceQ[slot] = paceQ;
  phenotypes.thermalOptimumCentiC[slot] = thermalOptimumCentiC(thermalOptQ, ranges);
  // Surface area against volume: a slender body sheds heat faster, so the same
  // genetic tolerance covers a narrower band (M15).
  phenotypes.thermalToleranceCentiC[slot] = clamp(
    qmul(
      thermalToleranceCentiC(toleranceGeneQ, ranges),
      physical.thermalToleranceFactorQ[slot] as number,
    ),
    0,
    65535,
  );
  phenotypes.maturityAgeTicks[slot] = maturityAgeTicks(maturityQ, ranges);
  phenotypes.maxAgeTicks[slot] = maxAgeTicks(maxAgeQ, ranges);
  phenotypes.offspringInvestmentQ[slot] = offspringInvestmentQ(investmentQ, ranges);
  phenotypes.hueDegrees[slot] = hueDegrees(hueQ);

  // docs/08 §9. Every "capability" costs upkeep whether or not it is used —
  // that is what stops speed, vision, attack, armor, tolerance and longevity
  // from all evolving to their maximum for free.
  const basal = config.organism.basal;
  let massCoeffQ = qmul(paceQ, basal.baseMassPaceCoeffQ);
  massCoeffQ += qmul(qmul(speedGeneQ, speedGeneQ), basal.muscleCapacityCoeffQ);
  massCoeffQ += qmul(qmul(effectiveAttackQ, effectiveAttackQ), basal.attackMaintCoeffQ);
  massCoeffQ += qmul(qmul(effectiveArmorQ, effectiveArmorQ), basal.armorMaintCoeffQ);
  massCoeffQ += qmul(toleranceGeneQ, basal.toleranceMaintCoeffQ);
  massCoeffQ += qmul(maxAgeQ, basal.longevityMaintCoeffQ);
  // M17: digestive tissue. Every channel a lineage can process well is gut it
  // has to keep alive, so the bill is the SUM of the six processing loci above
  // the founder's total — which is what stops a universal digester evolving.
  //
  // Measured against the founder and floored at zero, exactly as M16's neural
  // upkeep is, and for the same two reasons: the founder must pay nothing so
  // the calibrated ecology is not moved by the mechanism merely existing, and a
  // cost that can go negative is an energy source (ADR 0029 §3f, ADR 0030 §3a).
  //
  // Note what is NOT constrained: the genome can hold any six values it likes.
  // A normalized allocation would have made specialization a zero-sum identity
  // enforced by the representation, which is a rule about what evolution may
  // express. This is a price instead, so a generalist is possible and merely
  // expensive — and whether the expense is worth paying is the environment's
  // answer to give, not the config's.
  massCoeffQ += qmul(
    Math.max(0, processTotalQ - FOUNDER_PROCESS_TOTAL_Q),
    basal.digestiveMaintCoeffQ,
  );
  // Toxin resistance is chemistry a body runs whether or not it eats anything
  // defended, so it is billed the same way. Without this, resistance is free
  // and fixates, and defended growth stops being a trade at all.
  massCoeffQ += qmul(qmul(toxinResistanceQ, toxinResistanceQ), basal.toxinResistMaintCoeffQ);
  // M15: limbs and plating are maintained tissue, so they are billed per unit of
  // body mass alongside the genetic capabilities.
  phenotypes.basalMassCoeffQ[slot] = clamp(
    qmul(massCoeffQ, physical.basalFactorQ[slot] as number),
    0,
    65535,
  );

  // vision = visionBaseCost * rangeNorm² * fovNorm (docs/08 §9): long and wide
  // sight is the expensive combination. The morphological multipliers enter the
  // same way — a bigger sensor buys range, and range costs quadratically — so
  // sensory tissue needs no upkeep term of its own.
  phenotypes.basalVisionCost[slot] = clamp(
    qmul(
      qmul(qmul(qmul(visionQ, visionQ), fovQ), basal.visionBaseCost),
      qmul(qmul(visionRangeFactorQ, visionRangeFactorQ), visionFovFactorQ),
    ),
    0,
    65535,
  );

  phenotypes.biteMassPaceCoeffQ[slot] = clamp(
    qmul(qmul(config.organism.feeding.biteMassCoeffQ, paceQ), physical.biteFactorQ[slot] as number),
    0,
    65535,
  );
}

/**
 * Body mass from a radius in sub-units: `massScale * radiusLU²`
 * (docs/04 §3). Computed in one expression so the POS_SCALE² division happens
 * last and small juveniles do not round to zero mass prematurely.
 *
 * This is the mass of the *unit* body — a disc of that radius. What an organism
 * actually weighs depends on the body it grew, which is what {@link bodyMass}
 * adds; call that instead unless you genuinely want the geometric figure.
 */
export function massFromRadiusPos(radiusPos: number, massScalePerRadiusSquared: number): number {
  return Math.trunc((massScalePerRadiusSquared * radiusPos * radiusPos) / (POS_SCALE * POS_SCALE));
}

/**
 * What one organism actually weighs: the unit-body mass scaled by its
 * morphology (M15).
 *
 * Mass is the busiest quantity in the engine — basal upkeep, movement cost,
 * growth cost, maximum energy, bite size, attack fee and carcass yield all read
 * it — which is exactly why morphology enters through it. A long-limbed,
 * heavily plated body is expensive to run and worth eating; a small slender one
 * is neither. Nothing about that had to be added as a rule.
 */
export function bodyMass(
  physical: PhysicalPhenotypeStore,
  slot: number,
  radiusPos: number,
  massScalePerRadiusSquared: number,
): number {
  return qmul(
    massFromRadiusPos(radiusPos, massScalePerRadiusSquared),
    physical.massFactorQ[slot] as number,
  );
}

/** Current body radius in sub-units: adult radius scaled by realized development. */
export function currentRadiusPos(adultRadius: number, developmentQ: number): number {
  return qmul(adultRadius, clamp(developmentQ, 0, Q));
}

/**
 * Maximum energy for a body mass: `(baseMaxEnergy + mass * maxEnergyPerMass)`
 * scaled by the body's storage factor.
 *
 * The factor defaults to Q so callers with no organism in hand — the config
 * probes and the founder-endowment tests — still read the unit body's capacity.
 */
export function maxEnergyForMass(
  mass: number,
  config: DeepReadonly<SimulationConfig>,
  storeFactorQ = Q,
): number {
  return qmul(
    config.organism.baseMaxEnergy + mass * config.organism.maxEnergyPerMass,
    storeFactorQ,
  );
}

/** Maximum energy for one organism, including what its body plan can store. */
export function maxEnergyForOrganism(
  physical: PhysicalPhenotypeStore,
  slot: number,
  mass: number,
  config: DeepReadonly<SimulationConfig>,
): number {
  return maxEnergyForMass(mass, config, physical.energyStoreFactorQ[slot]);
}
