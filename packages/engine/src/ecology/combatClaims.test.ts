import { describe, expect, it } from "vitest";
import { POS_SCALE, Q, qmul } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { DeathCause, finalizeDeaths, markDeath } from "../organisms/death";
import { currentRadiusPos, massFromRadiusPos } from "../organisms/phenotype";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import {
  attackDamageQ,
  attackEnergyCost,
  buildCombatClaims,
  resolveCombatSimultaneously,
} from "./combatClaims";

/**
 * Combat (docs/04 §21, docs/08 §14, docs/10 §13, tasks F04–F07).
 *
 * The properties under test are the ones that make combat fair rather than
 * order-dependent: damage accumulates before it is applied, so mutual kills are
 * possible and several attackers stack; armor mitigates; an attack that has no
 * target costs nothing; and the kill is credited to the largest contributor with
 * an explicit tie-break.
 */

/** A genome that can actually hurt something: full attack gene, no armor. */
const FIGHTER = { [Gene.AttackPower]: Q, [Gene.Armor]: 0 } as const;

/** Cannot fight back: used wherever a pure target is needed. */
const PACIFIST = { [Gene.AttackPower]: 0, [Gene.Armor]: 0 } as const;

function combat(world: TestWorld): void {
  world.ctx.spatialPost.rebuild(world.organisms);
  buildCombatClaims(world.ctx);
  resolveCombatSimultaneously(world.ctx);
}

function intendAttack(world: TestWorld, ...slots: number[]): void {
  for (const slot of slots) {
    world.ctx.scratch.attackQ[slot] = Q;
  }
}

function massOf(world: TestWorld, slot: number): number {
  return massFromRadiusPos(
    currentRadiusPos(
      world.ctx.phenotypes.adultRadiusPos[slot] as number,
      world.organisms.developmentQ[slot] as number,
    ),
    world.config.organism.massScalePerRadiusSquared,
  );
}

describe("attack validation", () => {
  it("does nothing and costs nothing when no target is in contact range", () => {
    const world = createTestWorld();
    const attacker = spawnTestOrganism(world, { ...world.cellCenter(5, 5), genesQ: FIGHTER });
    // 40 LU away: far outside the largest possible pair of bodies (4.5 + 4.5 LU).
    const distant = spawnTestOrganism(world, {
      ...world.cellCenter(5, 5),
      genesQ: FIGHTER,
    });
    world.organisms.x[distant] = (world.organisms.x[attacker] as number) + 40 * POS_SCALE;

    const energyBefore = world.organisms.energy[attacker] as number;
    const healthBefore = world.organisms.healthQ[distant] as number;
    intendAttack(world, attacker);
    combat(world);

    expect(world.organisms.healthQ[distant]).toBe(healthBefore);
    // Swinging at nobody is not a swing: no energy, no cooldown.
    expect(world.organisms.energy[attacker]).toBe(energyBefore);
    expect(world.organisms.attackCooldown[attacker]).toBe(0);
  });

  it("requires the attack output to clear the threshold", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const attacker = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const target = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });

    const healthBefore = world.organisms.healthQ[target] as number;
    world.ctx.scratch.attackQ[attacker] = world.config.combat.attackOutputThresholdQ - 1;
    combat(world);
    expect(world.organisms.healthQ[target]).toBe(healthBefore);

    world.ctx.scratch.attackQ[attacker] = world.config.combat.attackOutputThresholdQ;
    combat(world);
    expect(world.organisms.healthQ[target]).toBeLessThan(healthBefore);
  });

  it("charges the attacker base cost plus a mass term, and starts the cooldown", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const attacker = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    spawnTestOrganism(world, { ...place, genesQ: FIGHTER });

    const { combat: combatConfig } = world.config;
    const expectedCost =
      combatConfig.baseAttackEnergyCost +
      qmul(massOf(world, attacker), combatConfig.attackEnergyMassCoeffQ);
    expect(attackEnergyCost(world.ctx, massOf(world, attacker))).toBe(expectedCost);

    const before = world.organisms.energy[attacker] as number;
    intendAttack(world, attacker);
    combat(world);

    expect(world.organisms.energy[attacker]).toBe(before - expectedCost);
    expect(world.organisms.attackCooldown[attacker]).toBe(combatConfig.attackCooldownTicks);
  });

  it("refuses an attack the attacker cannot pay for", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const attacker = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const target = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });

    world.organisms.energy[attacker] = attackEnergyCost(world.ctx, massOf(world, attacker)) - 1;
    const healthBefore = world.organisms.healthQ[target] as number;
    intendAttack(world, attacker);
    combat(world);

    expect(world.organisms.healthQ[target]).toBe(healthBefore);
    expect(world.organisms.energy[attacker]).toBeGreaterThanOrEqual(0);
  });

  it("spaces attacks exactly attackCooldownTicks apart", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const attacker = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const target = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    world.organisms.healthQ[target] = Q;

    const cooldown = world.config.combat.attackCooldownTicks;
    intendAttack(world, attacker);
    combat(world);
    const afterFirst = world.organisms.healthQ[target];

    // The blocked ticks: the cooldown decrements once per tick and only reaches
    // zero on the tick the next attack is allowed.
    for (let tick = 1; tick < cooldown; tick += 1) {
      intendAttack(world, attacker);
      combat(world);
      expect(world.organisms.healthQ[target]).toBe(afterFirst);
    }

    intendAttack(world, attacker);
    combat(world);
    expect(world.organisms.healthQ[target]).toBeLessThan(afterFirst);
  });
});

describe("damage", () => {
  it("is reduced by the target's armor, up to the configured maximum", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const attacker = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const bare = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: 0, [Gene.Armor]: 0 },
    });
    const armored = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: 0, [Gene.Armor]: Q },
    });

    const bareDamage = attackDamageQ(world.ctx, attacker, bare);
    const armoredDamage = attackDamageQ(world.ctx, attacker, armored);
    expect(armoredDamage).toBeLessThan(bareDamage);
    expect(armoredDamage).toBe(qmul(bareDamage, Q - world.config.combat.maxArmorDamageReductionQ));
    // Full armor mitigates, it never grants immunity.
    expect(armoredDamage).toBeGreaterThan(0);
  });

  it("scales with the attacker's body and with the speed it struck at", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const small = spawnTestOrganism(world, {
      ...place,
      genesQ: { ...FIGHTER, [Gene.AdultSize]: 0 },
    });
    const large = spawnTestOrganism(world, {
      ...place,
      genesQ: { ...FIGHTER, [Gene.AdultSize]: Q },
    });
    const target = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });

    expect(attackDamageQ(world.ctx, large, target)).toBeGreaterThan(
      attackDamageQ(world.ctx, small, target),
    );

    const standing = attackDamageQ(world.ctx, large, target);
    world.ctx.scratch.speedFractionQ[large] = Q;
    const charging = attackDamageQ(world.ctx, large, target);
    expect(charging).toBeGreaterThan(standing);
    expect(charging).toBe(qmul(standing, Q + world.config.combat.maxImpactDamageBonusQ));
  });

  it("uses the size floor from config for the smallest possible body", () => {
    const world = createTestWorld({
      configure: (config) => {
        // A floor of Q means size stops mattering; the two bodies must then deal
        // identical damage, which is what pins the derived span to Q - floor.
        config.combat.attackSizeFactorFloorQ = Q;
      },
    });
    const place = world.cellCenter(5, 5);
    const small = spawnTestOrganism(world, {
      ...place,
      genesQ: { ...FIGHTER, [Gene.AdultSize]: 0 },
    });
    const large = spawnTestOrganism(world, {
      ...place,
      genesQ: { ...FIGHTER, [Gene.AdultSize]: Q },
    });
    const target = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    expect(attackDamageQ(world.ctx, small, target)).toBe(attackDamageQ(world.ctx, large, target));
  });
});

describe("simultaneous resolution", () => {
  it("lets two organisms kill each other on the same tick", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const a = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const b = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    // Both one blow from death.
    world.organisms.healthQ[a] = 1;
    world.organisms.healthQ[b] = 1;

    intendAttack(world, a, b);
    combat(world);

    // Neither died inside the attacker loop, so both blows landed.
    expect(world.ctx.scratch.pendingDeath[a]).toBe(1);
    expect(world.ctx.scratch.pendingDeath[b]).toBe(1);
    expect(world.ctx.scratch.deathCause[a]).toBe(DeathCause.Combat);
    expect(world.ctx.scratch.deathCause[b]).toBe(DeathCause.Combat);
    expect(world.organisms.kills[a]).toBe(1);
    expect(world.organisms.kills[b]).toBe(1);

    finalizeDeaths(world.ctx);
    expect(world.organisms.liveCount).toBe(0);
    expect(world.organisms.deathsByCause[DeathCause.Combat]).toBe(2);
    // Both bodies became food.
    expect(world.carcasses.liveCount).toBe(2);
  });

  it("stacks several attackers on one target before any of it is applied", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const target = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: 0, [Gene.Armor]: 0 },
    });
    const attackers = [
      spawnTestOrganism(world, { ...place, genesQ: FIGHTER }),
      spawnTestOrganism(world, { ...place, genesQ: FIGHTER }),
      spawnTestOrganism(world, { ...place, genesQ: FIGHTER }),
    ];

    const expected = attackers.reduce(
      (sum, attacker) => sum + attackDamageQ(world.ctx, attacker, target),
      0,
    );
    world.organisms.healthQ[target] = Q;
    intendAttack(world, ...attackers);
    combat(world);

    expect(Q - world.organisms.healthQ[target]).toBe(expected);
    expect(world.ctx.scratch.combatDamageQ[target]).toBe(expected);
  });

  it("does not let a target's own death rob a co-attacker of its blow", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const target = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: 0, [Gene.Armor]: 0 },
    });
    const first = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const second = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });

    world.organisms.healthQ[target] = 1;
    intendAttack(world, first, second);
    combat(world);

    // Both attackers paid, both blows counted, and the target is dead once.
    expect(world.organisms.attackCooldown[first]).toBeGreaterThan(0);
    expect(world.organisms.attackCooldown[second]).toBeGreaterThan(0);
    expect(world.ctx.scratch.combatDamageQ[target]).toBe(
      attackDamageQ(world.ctx, first, target) + attackDamageQ(world.ctx, second, target),
    );
    expect(world.organisms.totalDeaths).toBe(0);
    finalizeDeaths(world.ctx);
    expect(world.organisms.totalDeaths).toBe(1);
  });
});

describe("kill attribution", () => {
  it("credits the largest damage contributor", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const target = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: 0, [Gene.Armor]: 0 },
    });
    const weak = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: Q, [Gene.Armor]: 0, [Gene.AdultSize]: 0 },
    });
    const strong = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: Q, [Gene.Armor]: 0, [Gene.AdultSize]: Q },
    });
    expect(attackDamageQ(world.ctx, strong, target)).toBeGreaterThan(
      attackDamageQ(world.ctx, weak, target),
    );

    world.organisms.healthQ[target] = 1;
    intendAttack(world, weak, strong);
    combat(world);

    expect(world.organisms.kills[strong]).toBe(1);
    expect(world.organisms.kills[weak]).toBe(0);
    expect(world.ctx.scratch.bestAttackerId[target]).toBe(world.organisms.entityId[strong]);
  });

  it("breaks an equal-damage tie on the lower attacker entity ID", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const target = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: 0, [Gene.Armor]: 0 },
    });
    // Identical genomes, so identical damage: only identity separates them.
    const older = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const younger = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    expect(world.organisms.entityId[older] as number).toBeLessThan(
      world.organisms.entityId[younger] as number,
    );

    world.organisms.healthQ[target] = 1;
    intendAttack(world, older, younger);
    combat(world);

    expect(world.organisms.kills[older]).toBe(1);
    expect(world.organisms.kills[younger]).toBe(0);
  });

  it("breaks the tie on entity ID even when slot order says the opposite", () => {
    // The test above cannot tell "lowest entity ID wins" from "first in storage
    // order wins", because the two agree until something dies. Here they are
    // made to DISAGREE: a released slot is handed back to the LATER-born
    // attacker, so the winner sits at the higher slot and can only be chosen by
    // identity. This is the property that keeps attribution reproducible, since
    // slot order carries the accident of who died recently.
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);

    // Spawned first, so the victim owns the lowest ID and both fighters pick it
    // rather than each other.
    const target = spawnTestOrganism(world, {
      ...place,
      genesQ: { [Gene.AttackPower]: 0, [Gene.Armor]: 0 },
    });
    const placeholder = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const lowerId = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    markDeath(world.ctx, placeholder, DeathCause.Other);
    finalizeDeaths(world.ctx);
    const higherId = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });

    expect(higherId).toBeLessThan(lowerId); // storage order
    expect(world.organisms.entityId[lowerId] as number).toBeLessThan(
      world.organisms.entityId[higherId] as number,
    ); // identity order, deliberately the reverse
    expect(attackDamageQ(world.ctx, lowerId, target)).toBe(
      attackDamageQ(world.ctx, higherId, target),
    );

    world.organisms.healthQ[target] = 1;
    intendAttack(world, lowerId, higherId);
    combat(world);

    expect(world.organisms.kills[lowerId]).toBe(1);
    expect(world.organisms.kills[higherId]).toBe(0);
  });

  it("does not credit a kill when the target survives", () => {
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const attacker = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const target = spawnTestOrganism(world, { ...place, genesQ: PACIFIST });
    world.organisms.healthQ[target] = Q;

    intendAttack(world, attacker);
    combat(world);

    expect(world.organisms.healthQ[target]).toBeGreaterThan(0);
    expect(world.organisms.kills[attacker]).toBe(0);
    expect(world.ctx.scratch.pendingDeath[target]).toBe(0);
  });
});

describe("target selection", () => {
  it("attacks the equidistant candidate with the lower entity ID, not the lower slot", () => {
    // Contact range picks the nearest body and breaks ties on entity ID
    // (docs/03 §10). With both candidates at the same point the tie-break is the
    // whole decision, so the two orders are again made to disagree.
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);

    const placeholder = spawnTestOrganism(world, { ...place, genesQ: PACIFIST });
    const lowerIdTarget = spawnTestOrganism(world, { ...place, genesQ: PACIFIST });
    markDeath(world.ctx, placeholder, DeathCause.Other);
    finalizeDeaths(world.ctx);
    const higherIdTarget = spawnTestOrganism(world, { ...place, genesQ: PACIFIST });
    const attacker = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });

    expect(higherIdTarget).toBeLessThan(lowerIdTarget);
    expect(world.organisms.entityId[lowerIdTarget] as number).toBeLessThan(
      world.organisms.entityId[higherIdTarget] as number,
    );

    intendAttack(world, attacker);
    combat(world);

    expect(world.ctx.scratch.combatDamageQ[lowerIdTarget]).toBeGreaterThan(0);
    expect(world.ctx.scratch.combatDamageQ[higherIdTarget]).toBe(0);
  });

  it("never targets an organism whose slot has already been released", () => {
    // The post-movement index is rebuilt before combat, but the alive check is
    // what actually guarantees this: a stale index entry must not become a
    // target, and a swing at a dead body must not be charged for.
    const world = createTestWorld();
    const place = world.cellCenter(5, 5);
    const attacker = spawnTestOrganism(world, { ...place, genesQ: FIGHTER });
    const victim = spawnTestOrganism(world, { ...place, genesQ: PACIFIST });

    world.ctx.spatialPost.rebuild(world.organisms);
    markDeath(world.ctx, victim, DeathCause.Other);
    finalizeDeaths(world.ctx);

    const energyBefore = world.organisms.energy[attacker] as number;
    intendAttack(world, attacker);
    // Deliberately NOT rebuilt: the index still lists the released slot.
    buildCombatClaims(world.ctx);
    resolveCombatSimultaneously(world.ctx);

    expect(world.ctx.scratch.damageAccumQ[victim]).toBe(0);
    expect(world.organisms.energy[attacker]).toBe(energyBefore);
    expect(world.organisms.attackCooldown[attacker]).toBe(0);
  });
});
