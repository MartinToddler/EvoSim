import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Q, qmul } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { DeathCause, finalizeDeaths } from "./death";
import {
  applyMetabolismGrowthThermalAging,
  basalCost,
  growthTargetQ,
  thermalBasalMultiplierQ,
} from "./metabolism";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "./phenotype";
import { thermalStressQ } from "./thermal";

/**
 * Physiology: upkeep, growth, thermal stress, starvation, healing, aging and
 * death (docs/04 §§4-9, 22, tasks D03/D11/D12/D13).
 */

function physiology(world: TestWorld): void {
  applyMetabolismGrowthThermalAging(world.ctx);
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

describe("growth target curve", () => {
  it("starts at the birth fraction and reaches full development at maturity", () => {
    const birth = DEFAULT_CONFIG.organism.birthSizeFractionQ;
    expect(growthTargetQ(0, 1000, birth)).toBe(birth);
    expect(growthTargetQ(1000, 1000, birth)).toBe(Q);
    expect(growthTargetQ(5000, 1000, birth)).toBe(Q);
  });

  it("rises across the whole range and never leaves [birthFraction, Q]", () => {
    const birth = DEFAULT_CONFIG.organism.birthSizeFractionQ;
    let previous = -1;
    let maxDip = 0;
    for (let age = 0; age <= 1200; age += 1) {
      const value = growthTargetQ(age, 1000, birth);
      maxDip = Math.max(maxDip, previous - value);
      expect(value).toBeGreaterThanOrEqual(birth);
      expect(value).toBeLessThanOrEqual(Q);
      previous = value;
    }
    // Integer smoothstep truncation can dip the target by a single Q unit.
    // It cannot affect development, which only ever moves toward a HIGHER
    // target, so a dip is a tick on which nothing grows.
    expect(maxDip).toBeLessThanOrEqual(1);
  });
});

describe("basal cost", () => {
  it("charges for capability even when it goes unused", () => {
    const world = createTestWorld();
    const plain = spawnTestOrganism(world, {
      ...world.cellCenter(5, 5),
      genesQ: { [Gene.MaxSpeed]: 0, [Gene.VisionRange]: 0, [Gene.Armor]: 0, [Gene.AttackPower]: 0 },
    });
    const equipped = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: { [Gene.MaxSpeed]: Q, [Gene.VisionRange]: Q, [Gene.Armor]: Q, [Gene.AttackPower]: Q },
    });
    // Same body size, so any difference is pure capability upkeep.
    const mass = massOf(world, plain);
    expect(massOf(world, equipped)).toBe(mass);
    expect(basalCost(world.ctx, equipped, mass)).toBeGreaterThan(basalCost(world.ctx, plain, mass));
  });

  it("scales with body mass", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, world.cellCenter(5, 5));
    const light = basalCost(world.ctx, slot, 100);
    const heavy = basalCost(world.ctx, slot, 1000);
    expect(heavy).toBeGreaterThan(light);
  });

  it("never lets an organism live for free", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, {
      ...world.cellCenter(5, 5),
      energyFractionQ: Q,
    });
    // Standing still, well fed, in perfect climate: upkeep still applies.
    const before = world.organisms.energy[slot] as number;
    physiology(world);
    expect(world.organisms.energy[slot]).toBeLessThan(before);
  });
});

describe("movement energy", () => {
  it("costs more the faster an organism actually moves", () => {
    const spend = (speedFractionQ: number, inWater: boolean): number => {
      const world = createTestWorld();
      const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
      world.organisms.developmentQ[slot] = Q; // adult, so movement dominates
      const before = world.organisms.energy[slot] as number;
      world.ctx.scratch.speedFractionQ[slot] = speedFractionQ;
      world.ctx.scratch.inWater[slot] = inWater ? 1 : 0;
      physiology(world);
      return before - (world.organisms.energy[slot] as number);
    };

    const idle = spend(0, false);
    const half = spend(Q / 2, false);
    const full = spend(Q, false);
    expect(half).toBeGreaterThan(idle);
    expect(full).toBeGreaterThan(half);
    // Quadratic in speed: the second half of the range costs far more.
    expect(full - half).toBeGreaterThan(half - idle);
  });

  it("makes swimming expensive rather than cheap", () => {
    const spend = (inWater: boolean): number => {
      const world = createTestWorld();
      const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
      world.organisms.developmentQ[slot] = Q;
      const before = world.organisms.energy[slot] as number;
      world.ctx.scratch.speedFractionQ[slot] = Q;
      world.ctx.scratch.inWater[slot] = inWater ? 1 : 0;
      physiology(world);
      return before - (world.organisms.energy[slot] as number);
    };
    expect(spend(true)).toBeGreaterThan(spend(false));
  });
});

describe("growth", () => {
  it("grows a well-fed juvenile toward its adult size", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    const born = world.organisms.developmentQ[slot] as number;
    for (let i = 0; i < 200; i += 1) {
      world.organisms.energy[slot] = maxEnergyForMass(massOf(world, slot), world.config);
      physiology(world);
    }
    expect(world.organisms.developmentQ[slot]).toBeGreaterThan(born);
    expect(world.organisms.developmentQ[slot]).toBeLessThanOrEqual(Q);
  });

  it("charges energy for the mass it adds", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    world.organisms.ageTicks[slot] = 500;
    const massBefore = massOf(world, slot);
    const energyBefore = world.organisms.energy[slot] as number;
    physiology(world);
    const grown = massOf(world, slot) - massBefore;
    expect(grown).toBeGreaterThan(0);
    // Upkeep is also charged, so growth alone cannot account for all of it.
    const spent = energyBefore - (world.organisms.energy[slot] as number);
    expect(spent).toBeGreaterThanOrEqual(grown * world.config.organism.energyPerGrowthMass);
  });

  it("lets development lag when the organism cannot pay", () => {
    const world = createTestWorld();
    const rich = spawnTestOrganism(world, { ...world.cellCenter(5, 5), energyFractionQ: Q });
    const poor = spawnTestOrganism(world, { ...world.cellCenter(20, 20), energyFractionQ: Q });

    for (let i = 0; i < 400; i += 1) {
      world.organisms.energy[rich] = maxEnergyForMass(massOf(world, rich), world.config);
      world.organisms.energy[poor] = 1; // never enough to buy mass
      physiology(world);
    }
    expect(world.organisms.developmentQ[poor]).toBeLessThan(
      world.organisms.developmentQ[rich] as number,
    );
    // Lagging, not shrinking: development never goes backwards.
    expect(world.organisms.developmentQ[poor]).toBeGreaterThanOrEqual(
      world.config.organism.birthSizeFractionQ,
    );
  });

  it("never grows past full development", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    world.organisms.ageTicks[slot] = 10_000;
    for (let i = 0; i < 50; i += 1) {
      world.organisms.energy[slot] = maxEnergyForMass(massOf(world, slot), world.config);
      physiology(world);
    }
    expect(world.organisms.developmentQ[slot]).toBe(Q);
  });
});

describe("starvation", () => {
  it("floors energy at zero and converts the shortfall into health damage", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: 0 });
    expect(world.organisms.energy[slot]).toBe(0);

    physiology(world);
    expect(world.organisms.energy[slot]).toBe(0); // never negative
    expect(world.organisms.healthQ[slot]).toBe(
      Q - world.config.organism.health.starvationDamageQPerTick,
    );
  });

  it("kills once health runs out, and attributes the cause", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: 0 });
    const ticksToDie = Math.ceil(Q / world.config.organism.health.starvationDamageQPerTick);

    for (let i = 0; i < ticksToDie; i += 1) {
      expect(world.organisms.alive[slot]).toBe(1);
      physiology(world);
      finalizeDeaths(world.ctx);
    }
    expect(world.organisms.alive[slot]).toBe(0);
    expect(world.organisms.deathsByCause[DeathCause.Starvation]).toBe(1);
    expect(world.organisms.totalDeaths).toBe(1);
  });

  it("does not starve an organism that can pay its upkeep", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    for (let i = 0; i < 50; i += 1) {
      world.organisms.energy[slot] = maxEnergyForMass(massOf(world, slot), world.config);
      physiology(world);
    }
    expect(world.organisms.healthQ[slot]).toBe(Q);
  });
});

describe("thermal stress", () => {
  it("is zero inside tolerance and saturates at twice the tolerance width", () => {
    expect(thermalStressQ(1800, 1800, 1000, 100)).toBe(0);
    expect(thermalStressQ(2800, 1800, 1000, 100)).toBe(0); // exactly at the edge
    expect(thermalStressQ(3800, 1800, 1000, 100)).toBe(Q); // one width beyond
    expect(thermalStressQ(9800, 1800, 1000, 100)).toBe(2 * Q); // capped
    // Symmetric in both directions.
    expect(thermalStressQ(800, 1800, 1000, 100)).toBe(thermalStressQ(2800, 1800, 1000, 100));
    expect(thermalStressQ(-200, 1800, 1000, 100)).toBe(thermalStressQ(3800, 1800, 1000, 100));
  });

  it("uses the tolerance floor instead of dividing by zero", () => {
    expect(() => thermalStressQ(2000, 1800, 0, 100)).not.toThrow();
    expect(thermalStressQ(2000, 1800, 0, 100)).toBe(2 * Q);
  });

  it("raises the basal multiplier from 1× toward the configured ceiling", () => {
    const ceiling = DEFAULT_CONFIG.organism.health.severeThermalBasalMultiplierMaxQ;
    expect(thermalBasalMultiplierQ(0, ceiling)).toBe(Q);
    expect(thermalBasalMultiplierQ(2 * Q, ceiling)).toBe(ceiling);
    expect(thermalBasalMultiplierQ(Q, ceiling)).toBeGreaterThan(Q);
    expect(thermalBasalMultiplierQ(Q, ceiling)).toBeLessThan(ceiling);
  });

  it("makes an ill-adapted organism spend more to stand still", () => {
    const spend = (temperatureCentiC: number): number => {
      const world = createTestWorld({ temperatureCentiC });
      const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
      const before = world.organisms.energy[slot] as number;
      physiology(world);
      return before - (world.organisms.energy[slot] as number);
    };
    // Founder optimum is +18 °C with a 13.5 °C tolerance.
    expect(spend(4500)).toBeGreaterThan(spend(1800));
    expect(spend(9000)).toBeGreaterThan(spend(4500));
  });

  it("damages health only beyond the severe threshold", () => {
    const damageAt = (temperatureCentiC: number): number => {
      const world = createTestWorld({ temperatureCentiC });
      const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
      world.organisms.energy[slot] = 1_000_000; // never starving
      physiology(world);
      return Q - (world.organisms.healthQ[slot] as number);
    };

    expect(damageAt(1800)).toBe(0);
    expect(damageAt(3000)).toBe(0); // stressed, but not severely
    // Optimum +18 °C, tolerance 13.5 °C: severe damage starts at +45 °C and
    // reaches its ceiling once the excess is two tolerance widths.
    expect(damageAt(5000)).toBeGreaterThan(0);
    expect(damageAt(9000)).toBeGreaterThan(damageAt(5000));
    expect(damageAt(9000)).toBe(DEFAULT_CONFIG.organism.health.severeThermalMaxDamageQPerTick);
  });

  it("kills by thermal stress and says so", () => {
    const world = createTestWorld({ temperatureCentiC: 19000 });
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    for (let i = 0; i < 1000 && world.organisms.alive[slot] === 1; i += 1) {
      world.organisms.energy[slot] = 1_000_000;
      physiology(world);
      finalizeDeaths(world.ctx);
    }
    expect(world.organisms.alive[slot]).toBe(0);
    expect(world.organisms.deathsByCause[DeathCause.Thermal]).toBe(1);
  });
});

describe("drowning", () => {
  it("grants a grace period before water damages health", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    const grace = world.config.organism.movement.waterGraceTicks;
    world.ctx.scratch.inWater[slot] = 1;

    for (let tick = 1; tick <= grace; tick += 1) {
      world.organisms.energy[slot] = 1_000_000;
      world.organisms.waterTicks[slot] = tick;
      physiology(world);
      expect(world.organisms.healthQ[slot]).toBe(Q);
    }

    world.organisms.energy[slot] = 1_000_000;
    world.organisms.waterTicks[slot] = grace + 1;
    physiology(world);
    // Damage lands first and passive healing repairs part of it in the same
    // tick, so the net loss is the difference — drowning outpaces healing.
    const damage = world.config.organism.movement.waterHealthDamageQPerTick;
    const healing = world.config.organism.health.passiveHealingQPerTick;
    expect(damage).toBeGreaterThan(healing);
    expect(world.organisms.healthQ[slot]).toBe(Q - damage + healing);
  });

  it("eventually drowns an organism that stays in water", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    world.ctx.scratch.inWater[slot] = 1;
    for (let tick = 1; tick < 2000 && world.organisms.alive[slot] === 1; tick += 1) {
      world.organisms.energy[slot] = 1_000_000;
      world.organisms.waterTicks[slot] = tick;
      physiology(world);
      finalizeDeaths(world.ctx);
    }
    expect(world.organisms.alive[slot]).toBe(0);
    expect(world.organisms.deathsByCause[DeathCause.Drowning]).toBe(1);
  });
});

describe("passive healing", () => {
  it("repairs damage only when well fed, and charges for it", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    world.organisms.healthQ[slot] = Q >> 1;

    const maxEnergy = maxEnergyForMass(massOf(world, slot), world.config);
    world.organisms.energy[slot] = maxEnergy;
    physiology(world);
    expect(world.organisms.healthQ[slot]).toBe(
      (Q >> 1) + world.config.organism.health.passiveHealingQPerTick,
    );

    // Below the energy threshold, no healing at all.
    const damaged = world.organisms.healthQ[slot];
    world.organisms.energy[slot] = qmul(
      maxEnergy,
      world.config.organism.health.passiveHealingMinEnergyFractionQ,
    );
    physiology(world);
    expect(world.organisms.healthQ[slot]).toBeLessThanOrEqual(damaged);
  });

  it("does not heal under severe thermal stress", () => {
    const world = createTestWorld({ temperatureCentiC: 9000 });
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    world.organisms.healthQ[slot] = Q >> 1;
    const before = world.organisms.healthQ[slot];
    world.organisms.energy[slot] = 1_000_000;
    physiology(world);
    expect(world.organisms.healthQ[slot]).toBeLessThan(before);
  });

  it("never heals above full health", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    for (let i = 0; i < 20; i += 1) {
      world.organisms.energy[slot] = 1_000_000;
      physiology(world);
    }
    expect(world.organisms.healthQ[slot]).toBe(Q);
  });
});

describe("aging", () => {
  it("advances one tick at a time", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    for (let i = 1; i <= 10; i += 1) {
      world.organisms.energy[slot] = 1_000_000;
      physiology(world);
      expect(world.organisms.ageTicks[slot]).toBe(i);
    }
  });

  it("kills at the genetic maximum age, however healthy the organism is", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    const maxAge = world.ctx.phenotypes.maxAgeTicks[slot] as number;
    world.organisms.ageTicks[slot] = maxAge - 1;
    world.organisms.energy[slot] = 1_000_000;
    world.organisms.healthQ[slot] = Q;

    physiology(world);
    finalizeDeaths(world.ctx);
    expect(world.organisms.alive[slot]).toBe(0);
    expect(world.organisms.deathsByCause[DeathCause.OldAge]).toBe(1);
  });

  it("gives a longer-lived genome a later death", () => {
    const world = createTestWorld();
    const short = spawnTestOrganism(world, {
      ...world.cellCenter(5, 5),
      genesQ: { [Gene.MaxAge]: 0 },
    });
    const long = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: { [Gene.MaxAge]: Q },
    });
    expect(world.ctx.phenotypes.maxAgeTicks[long]).toBeGreaterThan(
      world.ctx.phenotypes.maxAgeTicks[short] as number,
    );
  });
});

describe("death finalization", () => {
  it("releases the slot and clears the genome", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: 0 });
    const geneBase = world.ctx.genomes.geneOffset(slot);
    expect(world.ctx.genomes.genes[geneBase]).toBeGreaterThan(0);

    world.organisms.healthQ[slot] = 1;
    physiology(world);
    finalizeDeaths(world.ctx);

    expect(world.organisms.alive[slot]).toBe(0);
    expect(world.organisms.liveCount).toBe(0);
    expect(world.organisms.freeCount).toBe(1);
    expect(world.ctx.genomes.genes[geneBase]).toBe(0);
    expect(world.ctx.genomes.brainWeights[world.ctx.genomes.weightOffset(slot)]).toBe(0);
  });

  it("does not finalize the same death twice", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: 0 });
    world.organisms.healthQ[slot] = 1;
    physiology(world);
    finalizeDeaths(world.ctx);
    finalizeDeaths(world.ctx);
    expect(world.organisms.totalDeaths).toBe(1);
    expect(world.organisms.freeCount).toBe(1);
  });

  it("finalizes several deaths in ascending slot order", () => {
    const world = createTestWorld();
    const slots = [0, 1, 2].map((i) =>
      spawnTestOrganism(world, { ...world.cellCenter(5 + i * 5, 5), energyFractionQ: 0 }),
    );
    for (const slot of slots) {
      world.organisms.healthQ[slot] = 1;
    }
    physiology(world);
    finalizeDeaths(world.ctx);

    expect(world.organisms.liveCount).toBe(0);
    expect(world.organisms.totalDeaths).toBe(3);
    // LIFO reuse: the highest slot released last comes back first.
    expect(world.organisms.allocateSlot()).toBe(slots[2]);
  });

  it("keeps a dying organism intact until the death phase runs", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: 0 });
    world.organisms.healthQ[slot] = 1;
    physiology(world);
    // Doomed but still present: later phases in the same tick must not have to
    // ask whether the entity they are looking at still exists.
    expect(world.organisms.alive[slot]).toBe(1);
    expect(world.ctx.scratch.pendingDeath[slot]).toBe(1);
    finalizeDeaths(world.ctx);
    expect(world.organisms.alive[slot]).toBe(0);
  });
});

describe("invariants under sustained physiology", () => {
  it("keeps energy, health and development in range for many ticks", () => {
    const world = createTestWorld();
    const slots: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      slots.push(
        spawnTestOrganism(world, {
          ...world.cellCenter(4 + i * 6, 10),
          energyFractionQ: (i * Q) / 8,
        }),
      );
    }

    // Nothing here feeds them, so the run has to be long enough for the
    // best-provisioned organism to burn its reserves and then its health.
    for (let tick = 0; tick < 3000; tick += 1) {
      physiology(world);
      finalizeDeaths(world.ctx);
      for (const slot of slots) {
        if (world.organisms.alive[slot] !== 1) {
          continue;
        }
        expect(world.organisms.energy[slot]).toBeGreaterThanOrEqual(0);
        expect(world.organisms.healthQ[slot]).toBeGreaterThan(0);
        expect(world.organisms.healthQ[slot]).toBeLessThanOrEqual(Q);
        expect(world.organisms.developmentQ[slot]).toBeGreaterThanOrEqual(
          world.config.organism.birthSizeFractionQ,
        );
        expect(world.organisms.developmentQ[slot]).toBeLessThanOrEqual(Q);
      }
    }
    // Every one of them starved: nothing here feeds them.
    expect(world.organisms.liveCount).toBe(0);
    expect(world.organisms.deathsByCause[DeathCause.Starvation]).toBe(slots.length);
  });
});
