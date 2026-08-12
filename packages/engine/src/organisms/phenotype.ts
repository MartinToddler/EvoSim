import { assert, type DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { POS_SCALE, Q, TRIG_SCALE, clamp, qmul } from "../math/fixed";
import { cosLut } from "../math/trigLut";
import { FOV_COS_SCALE } from "../spatial/queries";
import {
  Gene,
  accelerationVel,
  adultRadiusPos,
  carnivoreAffinityQ,
  digestionEfficiencyQ,
  dietSignedQ,
  effectiveMaxSpeedVel,
  effectiveMaxTurnSteps,
  geneMaxSpeedVel,
  geneMaxTurnSteps,
  geneToQ,
  herbivoreAffinityQ,
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
import type { GenomeStore } from "./GenomeStore";

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
  readonly plantEfficiencyQ: Uint16Array;
  /** Digestion efficiency for meat, Q-scaled. */
  readonly meatEfficiencyQ: Uint16Array;

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
    this.plantEfficiencyQ = new Uint16Array(capacity);
    this.meatEfficiencyQ = new Uint16Array(capacity);
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
 * Recompute one slot's phenotype from its genome.
 *
 * Called at spawn and for every live slot after a snapshot restore. Every
 * value derives from the genome and the config only — no world state, no
 * position, no history — which is what makes the cache safe to leave out of
 * the state hash.
 */
export function derivePhenotype(
  phenotypes: PhenotypeStore,
  genomes: GenomeStore,
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

  phenotypes.adultRadiusPos[slot] = adultRadiusPos(sizeQ, ranges);
  phenotypes.maxSpeedVel[slot] = effectiveMaxSpeedVel(
    geneMaxSpeedVel(speedGeneQ, ranges),
    armorQ,
    config,
  );
  phenotypes.accelerationVel[slot] = accelerationVel(accelQ, ranges);
  phenotypes.maxTurnSteps[slot] = effectiveMaxTurnSteps(
    geneMaxTurnSteps(turnQ, ranges),
    sizeQ,
    config,
  );
  const halfFovSteps = visionFovSteps(fovQ, ranges) >> 1;
  phenotypes.visionRangePos[slot] = visionRangePos(visionQ, ranges);
  phenotypes.visionHalfFovSteps[slot] = halfFovSteps;
  phenotypes.visionCosHalfFov[slot] = Math.trunc(
    (cosLut(halfFovSteps) * FOV_COS_SCALE) / TRIG_SCALE,
  );

  const dietQ = dietSignedQ(raw[base + Gene.Diet] as number);
  const { digestionEfficiencyFloorQ, digestionEfficiencySpanQ } = config.organism.feeding;
  phenotypes.dietQ[slot] = dietQ;
  phenotypes.plantEfficiencyQ[slot] = digestionEfficiencyQ(
    herbivoreAffinityQ(dietQ),
    digestionEfficiencyFloorQ,
    digestionEfficiencySpanQ,
  );
  phenotypes.meatEfficiencyQ[slot] = digestionEfficiencyQ(
    carnivoreAffinityQ(dietQ),
    digestionEfficiencyFloorQ,
    digestionEfficiencySpanQ,
  );

  phenotypes.attackQ[slot] = attackQ;
  phenotypes.armorQ[slot] = armorQ;
  phenotypes.metabolicPaceQ[slot] = paceQ;
  phenotypes.thermalOptimumCentiC[slot] = thermalOptimumCentiC(thermalOptQ, ranges);
  phenotypes.thermalToleranceCentiC[slot] = thermalToleranceCentiC(toleranceGeneQ, ranges);
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
  massCoeffQ += qmul(qmul(attackQ, attackQ), basal.attackMaintCoeffQ);
  massCoeffQ += qmul(qmul(armorQ, armorQ), basal.armorMaintCoeffQ);
  massCoeffQ += qmul(toleranceGeneQ, basal.toleranceMaintCoeffQ);
  massCoeffQ += qmul(maxAgeQ, basal.longevityMaintCoeffQ);
  phenotypes.basalMassCoeffQ[slot] = clamp(massCoeffQ, 0, 65535);

  // vision = visionBaseCost * rangeNorm² * fovNorm (docs/08 §9): long and wide
  // sight is the expensive combination.
  phenotypes.basalVisionCost[slot] = clamp(
    qmul(qmul(qmul(visionQ, visionQ), fovQ), basal.visionBaseCost),
    0,
    65535,
  );

  phenotypes.biteMassPaceCoeffQ[slot] = clamp(
    qmul(config.organism.feeding.biteMassCoeffQ, paceQ),
    0,
    65535,
  );
}

/**
 * Body mass from a radius in sub-units: `massScale * radiusLU²`
 * (docs/04 §3). Computed in one expression so the POS_SCALE² division happens
 * last and small juveniles do not round to zero mass prematurely.
 */
export function massFromRadiusPos(radiusPos: number, massScalePerRadiusSquared: number): number {
  return Math.trunc((massScalePerRadiusSquared * radiusPos * radiusPos) / (POS_SCALE * POS_SCALE));
}

/** Current body radius in sub-units: adult radius scaled by realized development. */
export function currentRadiusPos(adultRadius: number, developmentQ: number): number {
  return qmul(adultRadius, clamp(developmentQ, 0, Q));
}

/** Maximum energy for a body mass: `baseMaxEnergy + mass * maxEnergyPerMass`. */
export function maxEnergyForMass(mass: number, config: DeepReadonly<SimulationConfig>): number {
  return config.organism.baseMaxEnergy + mass * config.organism.maxEnergyPerMass;
}
