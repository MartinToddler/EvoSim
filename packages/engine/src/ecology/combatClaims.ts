import { Q, qmul } from "../math/fixed";
import type { EngineContext } from "../EngineContext";
import { DeathCause, markDeath } from "../organisms/death";
import { currentRadiusPos, massFromRadiusPos } from "../organisms/phenotype";
import { type NearestTarget, findContactTarget } from "../spatial/queries";

/**
 * Combat — phases 10 and 11 of the authoritative tick order (docs/04 §21,
 * docs/08 §14, docs/10 §13, tasks F04–F07).
 *
 * ## There is no predator here
 *
 * Nothing in this file asks what kind of organism is attacking, or what kind is
 * being attacked. Every organism has an `attack` output and an `attackPower`
 * gene; whether either is ever used is a matter of what the inherited controller
 * does with its sensors and what the diet gene makes of the resulting carcass.
 * Predation is the *outcome* of those general rules meeting each other, which is
 * why the founder — attack gene 0.10, attack output pinned near zero by a
 * negative bias — never attacks anything, and why a lineage can nevertheless
 * discover carnivory without a single new rule being added.
 *
 * ## Damage accumulates first and is applied afterwards
 *
 * Phase 10 validates attackers, charges them and records damage *claims*.
 * Phase 11 applies the totals. Killing a target inside the attacker loop would
 * make combat depend on slot order in the worst possible way: the lower-slot
 * organism of a mutual attack would win every time, mutual kills would be
 * impossible, and a target that several organisms attacked would absorb the
 * blows in storage order (docs/10 §25 lists this as a mistake to avoid).
 *
 * Nothing dies before phase 13 either, so an organism killed here still finishes
 * its tick: it pays its own metabolism, and its carcass is created from the body
 * it had when it died.
 *
 * ## The cooldown is decremented here, not with the reproduction cooldown
 *
 * `combat.attackCooldownTicks` has to mean "attacks are that many ticks apart",
 * and the phase that sets the counter is the only phase that can decrement it
 * without changing that meaning. Reproduction's cooldown is decremented in the
 * physiology phase because reproduction runs *after* physiology; combat runs
 * *before* it, so a shared decrement would silently cost one tick of every
 * attack cooldown.
 */

/** Reused across the combat loop so the hot path allocates nothing. */
const contactTarget: NearestTarget = { slot: -1, distSq: 0 };

/** What one attack costs its attacker (docs/08 §14). */
export function attackEnergyCost(ctx: EngineContext, mass: number): number {
  const { combat } = ctx.config;
  return combat.baseAttackEnergyCost + qmul(mass, combat.attackEnergyMassCoeffQ);
}

/**
 * Damage one attack deals to one target, in health Q units (docs/08 §14):
 *
 * ```text
 * sizeFactor  = floor + (1 - floor) × attackerSizeNorm
 * impactBonus = 1 + maxImpactBonus × attackerSpeedFraction
 * raw         = baseDamage × attackPower × sizeFactor × impactBonus
 * final       = raw × (1 - maxArmorReduction × targetArmor)
 * ```
 *
 * `attackerSizeNorm` is the attacker's CURRENT body radius against the largest
 * radius the gene range allows, so a juvenile of a big genome hits like the
 * small body it currently has rather than like the adult it might become.
 *
 * Exported so the combat tests can assert the arithmetic directly instead of
 * inferring it from a health total.
 */
export function attackDamageQ(
  ctx: EngineContext,
  attackerSlot: number,
  targetSlot: number,
): number {
  const { phenotypes, scratch, config } = ctx;
  const { combat } = config;

  const attackerRadius = currentRadiusPos(
    phenotypes.adultRadiusPos[attackerSlot] as number,
    ctx.organisms.developmentQ[attackerSlot] as number,
  );
  const sizeNormQ = Math.min(
    Q,
    Math.trunc((attackerRadius * Q) / config.organism.geneRanges.adultRadiusMaxPos),
  );
  const sizeFactorQ =
    combat.attackSizeFactorFloorQ + qmul(Q - combat.attackSizeFactorFloorQ, sizeNormQ);
  const impactQ =
    Q + qmul(combat.maxImpactDamageBonusQ, scratch.speedFractionQ[attackerSlot] as number);

  const rawQ = qmul(
    qmul(qmul(combat.baseAttackDamageQ, phenotypes.attackQ[attackerSlot] as number), sizeFactorQ),
    impactQ,
  );
  const mitigationQ =
    Q - qmul(combat.maxArmorDamageReductionQ, phenotypes.armorQ[targetSlot] as number);
  return qmul(rawQ, mitigationQ);
}

/**
 * Whether one organism may attack at all this tick (docs/04 §21).
 *
 * The four conditions the specification lists, minus the target: output over
 * threshold, cooldown expired, energy available. Having someone to hit is
 * resolved separately, because "no target in reach" must cost nothing.
 */
function canAttack(ctx: EngineContext, slot: number, mass: number): boolean {
  const { organisms, scratch, config } = ctx;
  if ((scratch.attackQ[slot] as number) < config.combat.attackOutputThresholdQ) {
    return false;
  }
  if ((organisms.attackCooldown[slot] as number) > 0) {
    return false;
  }
  return (organisms.energy[slot] as number) >= attackEnergyCost(ctx, mass);
}

/**
 * Phase 10 — validate attackers, charge them, and accumulate damage claims.
 *
 * An attacker with no one in contact range spends nothing and stays off
 * cooldown: it swung at nobody, so there was no swing (docs/07 §2's
 * "out-of-range no-hit").
 */
export function buildCombatClaims(ctx: EngineContext): void {
  const { organisms, phenotypes, scratch, config } = ctx;
  const massScale = config.organism.massScalePerRadiusSquared;
  const cooldownTicks = config.combat.attackCooldownTicks;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    // Cleared for every used slot, live or not, so phase 11 and the physiology
    // phase can read them without asking how the previous tick ended.
    scratch.combatDamageQ[slot] = 0;
    scratch.damageAccumQ[slot] = 0;
    scratch.bestDamageQ[slot] = 0;
    scratch.bestAttackerId[slot] = 0;
    scratch.bestAttackerSlot[slot] = -1;
  }

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    // Every living organism's cooldown ticks down once per tick, whether or not
    // it wants to attack.
    const cooldown = organisms.attackCooldown[slot] as number;
    if (cooldown > 0) {
      organisms.attackCooldown[slot] = cooldown - 1;
    }
  }

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }

    const radius = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const mass = massFromRadiusPos(radius, massScale);
    if (!canAttack(ctx, slot, mass)) {
      continue;
    }

    findContactTarget(ctx, slot, radius, contactTarget);
    const targetSlot = contactTarget.slot;
    if (targetSlot === -1) {
      continue;
    }

    // The attack happens: pay for it, start the cooldown, and file the claim.
    organisms.energy[slot] = (organisms.energy[slot] as number) - attackEnergyCost(ctx, mass);
    organisms.attackCooldown[slot] = cooldownTicks;

    const damage = attackDamageQ(ctx, slot, targetSlot);
    if (damage <= 0) {
      continue;
    }
    scratch.damageAccumQ[targetSlot] = (scratch.damageAccumQ[targetSlot] as number) + damage;

    // Kill attribution: largest single contributor, ties to the lower attacker
    // entity ID (docs/04 §21). Entity ID rather than slot, because slots are
    // recycled and would make attribution depend on who died recently.
    const attackerId = organisms.entityId[slot] as number;
    const bestDamage = scratch.bestDamageQ[targetSlot] as number;
    if (
      damage > bestDamage ||
      (damage === bestDamage && attackerId < (scratch.bestAttackerId[targetSlot] as number))
    ) {
      scratch.bestDamageQ[targetSlot] = damage;
      scratch.bestAttackerId[targetSlot] = attackerId;
      scratch.bestAttackerSlot[targetSlot] = slot;
    }
  }
}

/**
 * Phase 11 — apply the accumulated damage to every target at once.
 *
 * Mutual kills fall out of this for free: both organisms filed their claims in
 * phase 10 while both were alive and unharmed, and both totals are applied here.
 */
export function resolveCombatSimultaneously(ctx: EngineContext): void {
  const { organisms, scratch } = ctx;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    const damage = scratch.damageAccumQ[slot] as number;
    if (damage <= 0) {
      continue;
    }
    scratch.damageAccumQ[slot] = 0;
    if (organisms.alive[slot] !== 1) {
      continue;
    }

    // Recorded for the physiology phase, which folds it into `lastDamageQ`
    // together with this tick's starvation and thermal damage.
    scratch.combatDamageQ[slot] = Math.min(damage, 65535);

    const healthQ = organisms.healthQ[slot] as number;
    if (damage < healthQ) {
      organisms.healthQ[slot] = healthQ - damage;
      continue;
    }

    organisms.healthQ[slot] = 0;
    markDeath(ctx, slot, DeathCause.Combat);

    // Credit the kill. The killer may be dying this same tick — that is what a
    // mutual kill is — and its counter is released with its slot in phase 13,
    // which is what a per-organism lifetime counter means.
    const killerSlot = scratch.bestAttackerSlot[slot] as number;
    if (killerSlot >= 0 && organisms.alive[killerSlot] === 1) {
      const kills = organisms.kills[killerSlot] as number;
      if (kills < 65535) {
        organisms.kills[killerSlot] = kills + 1;
      }
    }
  }
}
