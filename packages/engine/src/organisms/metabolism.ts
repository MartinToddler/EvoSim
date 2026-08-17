import { neuralUpkeep } from "../brain/neuralComplexity";
import { Q, clamp, qmul } from "../math/fixed";
import { smoothstepQ } from "../math/noise";
import type { EngineContext } from "../EngineContext";
import { DeathCause, markDeath } from "./death";
import { bodyMass, currentRadiusPos, maxEnergyForOrganism } from "./phenotype";
import { SEVERE_THERMAL_STRESS_Q, thermalStressQ } from "./thermal";

/**
 * Metabolism, growth, thermal stress and aging — phase 12 of the authoritative
 * tick order (docs/04 §§4-9, docs/08 §§9-13, tasks D03/D11/D12).
 *
 * Ordering inside the phase is fixed and load-bearing:
 *
 *  1. basal upkeep, multiplied by thermal stress;
 *  2. movement cost from the effort actually spent this tick;
 *  3. pay both, and take starvation damage for whatever could not be paid;
 *  4. grow toward the age-appropriate size, paying for the added mass;
 *  5. thermal and drowning health damage;
 *  6. passive healing, if well fed and not badly stressed;
 *  7. age, and die of old age at the genetic maximum.
 *
 * Growth is billed after upkeep on purpose: an organism that cannot pay for
 * staying alive has nothing left to spend on getting bigger, and development
 * lags instead (docs/04 §4).
 */

/**
 * Target development for an age (docs/04 §4):
 * `birthFraction + (1 - birthFraction) × growthCurve(age / maturityAge)`.
 *
 * The curve is the project's integer smoothstep, so growth eases in and out
 * rather than jumping, and is exact at both ends.
 *
 * Integer truncation inside the smoothstep can make the target dip by a single
 * Q unit (0.02%) at a handful of ages. That is harmless by construction:
 * development only ever moves toward a target that is HIGHER than it, so a
 * one-unit dip is a tick on which nothing grows, not a tick on which anything
 * shrinks. Rounding the smoothstep to remove the dip is not an option — the
 * same function generates the world's noise fields, and changing it would move
 * every coastline.
 */
export function growthTargetQ(
  ageTicks: number,
  maturityAgeTicks: number,
  birthSizeFractionQ: number,
): number {
  if (maturityAgeTicks <= 0) {
    return Q;
  }
  const ageFractionQ = clamp(Math.trunc((ageTicks * Q) / maturityAgeTicks), 0, Q);
  return birthSizeFractionQ + qmul(Q - birthSizeFractionQ, smoothstepQ(ageFractionQ));
}

/**
 * Basal upkeep for one organism before the thermal multiplier (docs/08 §9).
 *
 * Three terms: what the body costs per unit of mass, what its eyes cost, and
 * what its brain costs (M16). The brain term is the only one that does not
 * scale with mass — nervous tissue is billed by what it is, not by how big the
 * animal carrying it happens to be — and it is zero for the founder's topology
 * by construction.
 */
export function basalCost(ctx: EngineContext, slot: number, mass: number): number {
  return (
    qmul(mass, ctx.phenotypes.basalMassCoeffQ[slot] as number) +
    (ctx.phenotypes.basalVisionCost[slot] as number) +
    neuralUpkeep(ctx.genomes, slot, ctx.config)
  );
}

/**
 * Thermal multiplier applied to the basal cost: 1× inside tolerance rising to
 * the configured ceiling at maximum stress (docs/04 §8, docs/08 §13).
 */
export function thermalBasalMultiplierQ(stressQ: number, severeMultiplierMaxQ: number): number {
  return Q + qmul(severeMultiplierMaxQ - Q, stressQ >> 1);
}

/** Run the whole physiology phase for every living organism. */
export function applyMetabolismGrowthThermalAging(ctx: EngineContext): void {
  const { organisms, phenotypes, physical, environment, scratch, config } = ctx;
  const organism = config.organism;
  const { basal, movement, health } = organism;
  const massScale = organism.massScalePerRadiusSquared;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }

    const developmentQ = organisms.developmentQ[slot] as number;
    const adultRadius = phenotypes.adultRadiusPos[slot] as number;
    const radius = currentRadiusPos(adultRadius, developmentQ);
    const mass = bodyMass(physical, slot, radius, massScale);
    let energy = organisms.energy[slot] as number;
    let healthQ = organisms.healthQ[slot] as number;
    // Seeded from what combat already took off this organism in phase 11, not
    // zero: `lastDamageQ` means "damage taken this tick", and an organism can be
    // bitten and starve on the same tick. Overwriting here would make the field
    // silently report only whichever source happened to run last.
    // M17 adds a second source on the same footing: an organism can be bitten,
    // poisoned by what it ate, and starve, all on one tick, and the health
    // arithmetic has to see the sum. The two are kept separate in scratch so
    // the death cause stays truthful (a toxin death is not a predation death).
    let damageThisTick =
      (scratch.combatDamageQ[slot] as number) + (scratch.toxinDamageQ[slot] as number);

    const cell = environment.cellIndexFromPosition(
      organisms.x[slot] as number,
      organisms.y[slot] as number,
    );
    const stressQ = thermalStressQ(
      environment.getTemperatureCentiC(cell),
      phenotypes.thermalOptimumCentiC[slot] as number,
      phenotypes.thermalToleranceCentiC[slot] as number,
      health.thermalStressMinToleranceCentiC,
    );

    // 1. Basal upkeep. Every capability the genome paid for is billed whether
    //    or not it was used this tick — that is the trade-off that keeps speed,
    //    vision, armor, attack, tolerance and longevity from being free.
    let cost = qmul(
      basalCost(ctx, slot, mass),
      thermalBasalMultiplierQ(stressQ, health.severeThermalBasalMultiplierMaxQ),
    );
    if (cost < basal.minimumBasalPerTick) {
      cost = basal.minimumBasalPerTick;
    }

    // 2. Movement (docs/04 §7). Billed from the propulsive effort, so water is
    //    genuinely expensive rather than merely slow.
    const speedFractionQ = scratch.speedFractionQ[slot] as number;
    const accelFractionQ = scratch.accelFractionQ[slot] as number;
    let movementCost = qmul(
      mass,
      qmul(qmul(speedFractionQ, speedFractionQ), movement.movementCostCoeffQ),
    );
    movementCost += qmul(
      mass,
      qmul(qmul(accelFractionQ, accelFractionQ), movement.accelerationCostCoeffQ),
    );
    if (scratch.inWater[slot] === 1) {
      movementCost = qmul(movementCost, movement.waterMovementCostMultiplierQ);
    }
    // M15: what the body burns to push itself, as opposed to what it burns to
    // stay alive. Limb area and lateral silhouette both raise it.
    cost += qmul(movementCost, physical.movementCostFactorQ[slot] as number);

    // 3. Pay, and starve for the shortfall (docs/04 §9). There is no debt:
    //    energy floors at zero and the deficit becomes health damage.
    energy -= cost;
    if (energy < 0) {
      energy = 0;
      const damage = health.starvationDamageQPerTick;
      damageThisTick += damage;
      healthQ = healthQ > damage ? healthQ - damage : 0;
      if (healthQ === 0) {
        markDeath(ctx, slot, DeathCause.Starvation);
      }
    }

    // 4. Growth (docs/04 §4). What cannot be paid for is simply not grown.
    const targetQ = growthTargetQ(
      organisms.ageTicks[slot] as number,
      phenotypes.maturityAgeTicks[slot] as number,
      organism.birthSizeFractionQ,
    );
    if (targetQ > developmentQ) {
      const targetMass = bodyMass(
        physical,
        slot,
        currentRadiusPos(adultRadius, targetQ),
        massScale,
      );
      const addedMass = targetMass - mass;
      // M15: dense and complex tissue costs more per unit to build, so plating
      // and long limbs are paid for in development time as well as in mass.
      // The floor of 1 keeps a costed configuration from rounding to free.
      const perMass =
        organism.energyPerGrowthMass === 0
          ? 0
          : Math.max(
              1,
              qmul(organism.energyPerGrowthMass, physical.growthCostFactorQ[slot] as number),
            );
      if (addedMass <= 0 || perMass === 0) {
        // The step is too small to change integer mass, or growth is free in
        // this configuration; either way there is nothing to charge for.
        organisms.developmentQ[slot] = targetQ;
      } else {
        const affordableMass = Math.min(addedMass, Math.trunc(energy / perMass));
        if (affordableMass > 0) {
          energy -= affordableMass * perMass;
          organisms.developmentQ[slot] =
            developmentQ + Math.trunc(((targetQ - developmentQ) * affordableMass) / addedMass);
        }
      }
    }

    // 5. Thermal and drowning damage.
    if (stressQ > SEVERE_THERMAL_STRESS_Q) {
      const damage = Math.trunc(
        (health.severeThermalMaxDamageQPerTick * (stressQ - SEVERE_THERMAL_STRESS_Q)) / Q,
      );
      if (damage > 0) {
        damageThisTick += damage;
        healthQ = healthQ > damage ? healthQ - damage : 0;
        if (healthQ === 0) {
          markDeath(ctx, slot, DeathCause.Thermal);
        }
      }
    }
    if (
      scratch.inWater[slot] === 1 &&
      (organisms.waterTicks[slot] as number) > movement.waterGraceTicks
    ) {
      const damage = movement.waterHealthDamageQPerTick;
      if (damage > 0) {
        damageThisTick += damage;
        healthQ = healthQ > damage ? healthQ - damage : 0;
        if (healthQ === 0) {
          markDeath(ctx, slot, DeathCause.Drowning);
        }
      }
    }

    // 6. Passive healing (docs/04 §9): only when well fed and not severely
    //    stressed, and it costs energy. Eating never restores health directly.
    if (healthQ > 0 && healthQ < Q && stressQ < SEVERE_THERMAL_STRESS_Q) {
      const maxEnergy = maxEnergyForOrganism(physical, slot, mass, config);
      const threshold = qmul(maxEnergy, health.passiveHealingMinEnergyFractionQ);
      if (energy > threshold) {
        const healCost =
          health.passiveHealingEnergyBaseCost + qmul(mass, health.passiveHealingEnergyMassCoeffQ);
        if (energy >= healCost) {
          energy -= healCost;
          healthQ = Math.min(Q, healthQ + health.passiveHealingQPerTick);
        }
      }
    }

    // 7. Aging and per-tick counters. Old age is a deterministic hard cap in MVP
    //    (docs/04 §22). The reproduction cooldown ticks down here, in the one
    //    phase that already runs exactly once per living organism per tick; it
    //    runs BEFORE reproduction (phase 14), so a cooldown of N really does
    //    space births N ticks apart.
    const cooldown = organisms.reproductionCooldown[slot] as number;
    if (cooldown > 0) {
      organisms.reproductionCooldown[slot] = cooldown - 1;
    }
    const age = (organisms.ageTicks[slot] as number) + 1;
    organisms.ageTicks[slot] = age;
    if (age >= (phenotypes.maxAgeTicks[slot] as number)) {
      markDeath(ctx, slot, DeathCause.OldAge);
    }

    organisms.energy[slot] = energy;
    organisms.healthQ[slot] = healthQ;
    organisms.lastDamageQ[slot] = Math.min(damageThisTick, 65535);
  }
}
