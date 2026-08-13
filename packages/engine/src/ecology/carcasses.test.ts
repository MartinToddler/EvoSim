import { describe, expect, it } from "vitest";
import { Q, qmul } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { DeathCause, finalizeDeaths, markDeath } from "../organisms/death";
import { currentRadiusPos, massFromRadiusPos } from "../organisms/phenotype";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import {
  MIN_CARCASS_DECAY_UNITS,
  carcassDecayFractionQ,
  carcassMeatUnits,
  createCarcass,
  decayCarcasses,
} from "./carcasses";

/**
 * Carcass creation and decay (docs/03 §23, docs/08 §15, task F01).
 */

function massOf(world: TestWorld, slot: number): number {
  return massFromRadiusPos(
    currentRadiusPos(
      world.ctx.phenotypes.adultRadiusPos[slot] as number,
      world.organisms.developmentQ[slot] as number,
    ),
    world.config.organism.massScalePerRadiusSquared,
  );
}

describe("carcass creation", () => {
  it("leaves a carcass at the position of a dead organism, whatever killed it", () => {
    const world = createTestWorld();
    const place = world.cellCenter(10, 10);
    const slot = spawnTestOrganism(world, place);
    const id = world.organisms.entityId[slot] as number;

    markDeath(world.ctx, slot, DeathCause.Starvation);
    finalizeDeaths(world.ctx);

    expect(world.carcasses.liveCount).toBe(1);
    expect(world.carcasses.active[0]).toBe(1);
    expect(world.carcasses.entityId[0]).toBe(id);
    expect(world.carcasses.x[0]).toBe(place.xPos);
    expect(world.carcasses.y[0]).toBe(place.yPos);
    expect(world.carcasses.sourceSpeciesId[0]).toBe(1);
    expect(world.carcasses.ageTicks[0]).toBe(0);
    expect(world.carcasses.remainingMeat[0]).toBeGreaterThan(0);
    // The organism's slot is gone; the carcass carries its identity instead.
    expect(world.organisms.alive[slot]).toBe(0);
  });

  it("values a body at mass x meatPerMass plus a bounded share of its energy", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    const { carcass } = world.config.organism;

    const expectedBody = massOf(world, slot) * carcass.meatPerMass;
    const expectedEnergy = Math.trunc(
      qmul(world.organisms.energy[slot] as number, carcass.remainingEnergyToMeatMaxFractionQ) /
        world.config.plants.meatEnergyPerUnit,
    );
    expect(carcassMeatUnits(world.ctx, slot)).toBe(expectedBody + expectedEnergy);
  });

  it("recovers at most the configured fraction of the dead organism's energy", () => {
    const world = createTestWorld({
      configure: (config) => {
        // Isolate the energy term from the mass term.
        config.organism.carcass.meatPerMass = 0;
      },
    });
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    const energy = world.organisms.energy[slot] as number;
    const meat = carcassMeatUnits(world.ctx, slot);

    // What an eater could ever get back out of the carcass, at perfect
    // digestion, must stay under the fraction the config allows.
    const recoverableEnergy = meat * world.config.plants.meatEnergyPerUnit;
    expect(recoverableEnergy).toBeLessThanOrEqual(
      qmul(energy, world.config.organism.carcass.remainingEnergyToMeatMaxFractionQ),
    );
  });

  it("gives a bigger body more meat", () => {
    const world = createTestWorld();
    const small = spawnTestOrganism(world, {
      ...world.cellCenter(5, 5),
      genesQ: { [Gene.AdultSize]: 0 },
    });
    const large = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: { [Gene.AdultSize]: Q },
    });
    expect(carcassMeatUnits(world.ctx, large)).toBeGreaterThan(carcassMeatUnits(world.ctx, small));
  });

  it("creates nothing when a body is worth no meat", () => {
    const world = createTestWorld({
      configure: (config) => {
        config.organism.carcass.meatPerMass = 0;
        config.organism.carcass.remainingEnergyToMeatMaxFractionQ = 0;
      },
    });
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    expect(createCarcass(world.ctx, slot)).toBe(-1);
    expect(world.carcasses.liveCount).toBe(0);
    // A zero-meat carcass would occupy a capped slot and be sensed as food
    // while giving nothing to whoever crossed the world for it.
    expect(world.carcasses.totalCreated).toBe(0);
  });

  it("counts skipped carcasses when the cap is full rather than evicting one", () => {
    const world = createTestWorld({
      configure: (config) => {
        config.limits.maxCarcasses = 2;
      },
    });
    const slots = [
      spawnTestOrganism(world, world.cellCenter(5, 5)),
      spawnTestOrganism(world, world.cellCenter(6, 6)),
      spawnTestOrganism(world, world.cellCenter(7, 7)),
    ];
    const survivingIds = [
      world.organisms.entityId[slots[0] as number] as number,
      world.organisms.entityId[slots[1] as number] as number,
    ];
    for (const slot of slots) {
      markDeath(world.ctx, slot, DeathCause.OldAge);
    }
    finalizeDeaths(world.ctx);

    expect(world.carcasses.liveCount).toBe(2);
    expect(world.carcasses.skippedAtCap).toBe(1);
    // The two that made it are the two that died first; nothing was replaced.
    expect([world.carcasses.entityId[0], world.carcasses.entityId[1]]).toEqual(survivingIds);
    // All three deaths still happened.
    expect(world.organisms.totalDeaths).toBe(3);
  });
});

describe("carcass decay", () => {
  it("rots faster where it is hotter", () => {
    const cold = createTestWorld({ temperatureCentiC: -500 });
    const hot = createTestWorld({ temperatureCentiC: 3500 });
    const coldFraction = carcassDecayFractionQ(-500, cold.ctx);
    const hotFraction = carcassDecayFractionQ(3500, hot.ctx);

    const base = cold.config.organism.carcass.baseCarcassDecayFractionQPerDecayStep;
    expect(coldFraction).toBe(base);
    expect(hotFraction).toBe(qmul(base, Q + cold.config.organism.carcass.hotDecayBonusMaxQ));
    expect(hotFraction).toBeGreaterThan(coldFraction);
  });

  it("saturates the hot bonus above the configured full-bonus temperature", () => {
    const world = createTestWorld();
    const atFull = carcassDecayFractionQ(
      world.config.organism.carcass.hotDecayFullBonusTemperatureCentiC,
      world.ctx,
    );
    const wayAbove = carcassDecayFractionQ(9000, world.ctx);
    expect(wayAbove).toBe(atFull);
  });

  it("removes meat monotonically and counts every unit lost", () => {
    const world = createTestWorld({ temperatureCentiC: 1800 });
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    markDeath(world.ctx, slot, DeathCause.OldAge);
    finalizeDeaths(world.ctx);

    const created = world.carcasses.totalMeatCreated;
    let previous = world.carcasses.remainingMeat[0] as number;
    for (let step = 0; step < 5; step += 1) {
      decayCarcasses(world.ctx);
      const now = world.carcasses.remainingMeat[0] as number;
      expect(now).toBeLessThan(previous);
      previous = now;
    }
    expect(world.carcasses.totalMeatDecayed + previous).toBe(created);
    expect(world.carcasses.ageTicks[0]).toBe(5 * world.config.time.carcassDecayInterval);
  });

  it("always removes at least one unit, so a small carcass cannot linger forever", () => {
    const world = createTestWorld();
    // 1 unit x 0.49% truncates to zero: without the floor this carcass would
    // hold its slot for the rest of the world's life.
    world.carcasses.create(7, world.cellCenter(4, 4).xPos, world.cellCenter(4, 4).yPos, 1, 1);
    expect(qmul(1, carcassDecayFractionQ(1800, world.ctx))).toBe(0);
    expect(MIN_CARCASS_DECAY_UNITS).toBe(1);

    decayCarcasses(world.ctx);
    expect(world.carcasses.liveCount).toBe(0);
    expect(world.carcasses.totalMeatDecayed).toBe(1);
  });

  it("releases the slot of an emptied carcass and reuses it", () => {
    const world = createTestWorld();
    const place = world.cellCenter(8, 8);
    const slot = world.carcasses.create(11, place.xPos, place.yPos, 2, 1);
    world.carcasses.create(12, place.xPos, place.yPos, 100_000, 1);

    // Two units at the minimum decay of one unit per step: two steps, and the
    // second one is what empties it.
    decayCarcasses(world.ctx);
    expect(world.carcasses.active[slot]).toBe(1);
    expect(world.carcasses.remainingMeat[slot]).toBe(1);
    decayCarcasses(world.ctx);
    // The small one is gone, the big one is not.
    expect(world.carcasses.active[slot]).toBe(0);
    expect(world.carcasses.liveCount).toBe(1);
    expect(world.carcasses.create(13, place.xPos, place.yPos, 10, 1)).toBe(slot);
  });

  it("keeps carrion forever when decay is configured off", () => {
    const world = createTestWorld({
      configure: (config) => {
        config.organism.carcass.baseCarcassDecayFractionQPerDecayStep = 0;
      },
    });
    const place = world.cellCenter(9, 9);
    world.carcasses.create(21, place.xPos, place.yPos, 500, 1);
    for (let step = 0; step < 10; step += 1) {
      decayCarcasses(world.ctx);
    }
    // The ablation has to stay available: "carrion never rots" is a legitimate
    // experimental configuration, so the minimum-decay floor must not fire when
    // the rate itself is zero.
    expect(world.carcasses.remainingMeat[0]).toBe(500);
    expect(world.carcasses.totalMeatDecayed).toBe(0);
  });
});
