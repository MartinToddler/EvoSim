import { RESOURCE_COUNT, Resource } from "../world/resources";
import type { ResourceProfile } from "../config/SimulationConfig";
import { describe, expect, it } from "vitest";
import { POS_SCALE, Q, qmul } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { massFromRadiusPos, currentRadiusPos } from "../organisms/phenotype";
import {
  FeedingTarget,
  buildFeedingClaims,
  plantBiteUnits,
  resolveFeedingClaims,
} from "./feedingClaims";

/** The foliage channel of a config, non-optional. M17 made plants a list. */
function foliageProfile(config: { plants: { resources: readonly ResourceProfile[] } }): ResourceProfile {
  const profile = config.plants.resources[Resource.Foliage];
  if (profile === undefined) {
    throw new Error("config is missing the foliage channel");
  }
  return profile;
}


/**
 * Plant feeding allocation (docs/03 §21, task D10).
 *
 * The property that matters most here is conservation: biomass removed from a
 * cell must equal biomass granted to organisms, exactly, whether or not the
 * cell can satisfy everyone.
 */

function feed(world: TestWorld, eatQ: number = Q): void {
  for (let slot = 0; slot < world.organisms.slotHighWater; slot += 1) {
    world.ctx.scratch.eatQ[slot] = eatQ;
  }
  buildFeedingClaims(world.ctx);
  resolveFeedingClaims(world.ctx);
}

function totalBiomass(world: TestWorld): number {
  let total = 0;
  for (let i = 0; i < world.environment.cellCount; i += 1) {
    total += world.environment.resourceBiomass[i] as number;
  }
  return total;
}

function totalAllocated(world: TestWorld): number {
  let total = 0;
  for (let slot = 0; slot < world.organisms.slotHighWater; slot += 1) {
    total += world.ctx.scratch.feedingAllocated[slot] as number;
  }
  return total;
}

describe("bite size", () => {
  it("scales with body mass and metabolic pace, capped by config", () => {
    const world = createTestWorld();
    const small = spawnTestOrganism(world, {
      ...world.cellCenter(5, 5),
      genesQ: { [Gene.AdultSize]: 0 },
    });
    const large = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: { [Gene.AdultSize]: Q },
    });

    const massOf = (slot: number): number =>
      massFromRadiusPos(
        currentRadiusPos(
          world.ctx.phenotypes.adultRadiusPos[slot] as number,
          world.organisms.developmentQ[slot] as number,
        ),
        world.config.organism.massScalePerRadiusSquared,
      );

    const smallBite = plantBiteUnits(world.ctx, small, massOf(small));
    const largeBite = plantBiteUnits(world.ctx, large, massOf(large));
    expect(largeBite).toBeGreaterThan(smallBite);
    expect(largeBite).toBeLessThanOrEqual(world.config.organism.feeding.maxPlantBiteUnits);
    expect(smallBite).toBeGreaterThanOrEqual(world.config.organism.feeding.biteBaseUnits);
  });
});

describe("eat intent gating", () => {
  it("claims nothing below the eat threshold", () => {
    const world = createTestWorld();
    spawnTestOrganism(world, world.cellCenter(10, 10));
    const before = totalBiomass(world);
    feed(world, world.config.organism.feeding.eatOutputThresholdQ - 1);
    expect(totalAllocated(world)).toBe(0);
    expect(totalBiomass(world)).toBe(before);
  });

  it("claims at exactly the threshold", () => {
    const world = createTestWorld();
    spawnTestOrganism(world, world.cellCenter(10, 10));
    feed(world, world.config.organism.feeding.eatOutputThresholdQ);
    expect(totalAllocated(world)).toBeGreaterThan(0);
  });

  it("claims nothing from a barren cell", () => {
    const world = createTestWorld({ plantBiomass: 0 });
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    feed(world);
    expect(world.ctx.scratch.feedingTargetType[slot]).toBe(FeedingTarget.None);
    expect(totalAllocated(world)).toBe(0);
  });
});

describe("conservation", () => {
  it("removes exactly as much biomass as it grants, uncontested", () => {
    const world = createTestWorld();
    for (let i = 0; i < 5; i += 1) {
      spawnTestOrganism(world, world.cellCenter(5 + i * 4, 5));
    }
    const before = totalBiomass(world);
    feed(world);
    const allocated = totalAllocated(world);
    expect(allocated).toBeGreaterThan(0);
    expect(before - totalBiomass(world)).toBe(allocated);
  });

  it("removes exactly as much biomass as it grants when contested", () => {
    // One nearly empty cell, many claimants: the interesting case.
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: 7 });
    const center = world.cellCenter(10, 10);
    for (let i = 0; i < 10; i += 1) {
      spawnTestOrganism(world, { xPos: center.xPos + i, yPos: center.yPos });
    }
    const before = totalBiomass(world);
    feed(world);
    const allocated = totalAllocated(world);
    expect(allocated).toBe(7); // the cell's entire standing crop, no more
    expect(before - totalBiomass(world)).toBe(allocated);
  });

  it("never leaves a cell with negative biomass", () => {
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: 3 });
    const center = world.cellCenter(10, 10);
    for (let i = 0; i < 40; i += 1) {
      spawnTestOrganism(world, { xPos: center.xPos + i, yPos: center.yPos });
    }
    feed(world);
    for (let i = 0; i < world.environment.cellCount; i += 1) {
      expect(world.environment.resourceBiomass[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("satisfies everyone when the cell can afford it", () => {
    const world = createTestWorld({ plantCapacity: 60000, plantBiomass: 60000 });
    const center = world.cellCenter(10, 10);
    const slots = [0, 1, 2].map((i) =>
      spawnTestOrganism(world, { xPos: center.xPos + i, yPos: center.yPos }),
    );
    feed(world);
    for (const slot of slots) {
      expect(world.ctx.scratch.feedingAllocated[slot]).toBe(
        world.ctx.scratch.feedingRequest[slot] as number,
      );
    }
  });
});

describe("contested allocation", () => {
  it("shares proportionally rather than letting the first slot drain the cell", () => {
    // Two newborns bite for 3 units each against a cell holding 4: contested.
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: 4 });
    const center = world.cellCenter(10, 10);
    const a = spawnTestOrganism(world, { xPos: center.xPos, yPos: center.yPos });
    const b = spawnTestOrganism(world, { xPos: center.xPos + 4, yPos: center.yPos });
    feed(world);

    // Equal requests, so an equal share each — not "first slot served first",
    // which would have left the second organism with nothing.
    expect(world.ctx.scratch.feedingAllocated[a]).toBe(2);
    expect(world.ctx.scratch.feedingAllocated[b]).toBe(2);
  });

  it("gives a bigger claimant a bigger share", () => {
    const world = createTestWorld({ plantCapacity: 60000, plantBiomass: 20 });
    const center = world.cellCenter(10, 10);
    const small = spawnTestOrganism(world, {
      xPos: center.xPos,
      yPos: center.yPos,
      genesQ: { [Gene.AdultSize]: 0 },
    });
    const large = spawnTestOrganism(world, {
      xPos: center.xPos + 4,
      yPos: center.yPos,
      genesQ: { [Gene.AdultSize]: Q },
    });
    feed(world);
    expect(world.ctx.scratch.feedingAllocated[large]).toBeGreaterThan(
      world.ctx.scratch.feedingAllocated[small] as number,
    );
  });

  it("hands the integer remainder to the lowest entity IDs, not the lowest slots", () => {
    // Three equal claimants and 8 units: base share 2 each, 2 units left over.
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: 8 });
    const center = world.cellCenter(10, 10);
    const a = spawnTestOrganism(world, { xPos: center.xPos, yPos: center.yPos });
    const b = spawnTestOrganism(world, { xPos: center.xPos + 2, yPos: center.yPos });
    const c = spawnTestOrganism(world, { xPos: center.xPos + 4, yPos: center.yPos });

    feed(world);
    const allocations = [a, b, c].map((s) => world.ctx.scratch.feedingAllocated[s] as number);
    expect(allocations.reduce((sum, v) => sum + v, 0)).toBe(8);
    expect(allocations).toEqual([3, 3, 2]);

    // Reverse the entity IDs and the leftovers follow them, proving the rule
    // is about identity rather than storage order.
    world.environment.resourceBiomass.fill(8);
    world.organisms.entityId[a] = 30;
    world.organisms.entityId[b] = 20;
    world.organisms.entityId[c] = 10;
    feed(world);
    expect([a, b, c].map((s) => world.ctx.scratch.feedingAllocated[s] as number)).toEqual([
      2, 3, 3,
    ]);
  });

  it("never grants a claimant more than it asked for", () => {
    const world = createTestWorld({ plantCapacity: 60000, plantBiomass: 60000 });
    const center = world.cellCenter(10, 10);
    const slots = [0, 1, 2, 3].map((i) =>
      spawnTestOrganism(world, { xPos: center.xPos + i, yPos: center.yPos }),
    );
    feed(world);
    for (const slot of slots) {
      expect(world.ctx.scratch.feedingAllocated[slot]).toBeLessThanOrEqual(
        world.ctx.scratch.feedingRequest[slot] as number,
      );
    }
  });

  it("keeps cells independent", () => {
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: 4 });
    const alone = spawnTestOrganism(world, world.cellCenter(5, 5));
    const crowdedCenter = world.cellCenter(20, 20);
    for (let i = 0; i < 8; i += 1) {
      spawnTestOrganism(world, { xPos: crowdedCenter.xPos + i, yPos: crowdedCenter.yPos });
    }
    feed(world);
    // The lone organism gets its whole request; the crowd next door competing
    // over an equally sparse cell has no effect on it.
    expect(world.ctx.scratch.feedingAllocated[alone]).toBe(
      world.ctx.scratch.feedingRequest[alone] as number,
    );
    expect(world.ctx.scratch.feedingAllocated[alone]).toBeGreaterThan(0);
  });
});

describe("energy conversion", () => {
  it("converts allocated biomass through the diet efficiency", () => {
    const world = createTestWorld({ plantCapacity: 60000, plantBiomass: 60000 });
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: 0 });
    feed(world);

    const allocated = world.ctx.scratch.feedingAllocated[slot] as number;
    const expected = qmul(
      allocated * foliageProfile(world.config).energyPerUnit,
      world.ctx.phenotypes.processEfficiencyQ[(slot) * RESOURCE_COUNT + Resource.Foliage] as number,
    );
    expect(world.organisms.energy[slot]).toBe(expected);
    expect(world.organisms.plantEnergyEaten[slot]).toBe(expected);
  });

  it("rewards the herbivore specialist over the carnivore for the same mouthful", () => {
    const world = createTestWorld({ plantCapacity: 60000, plantBiomass: 60000 });
    const center = world.cellCenter(10, 10);
    const herbivore = spawnTestOrganism(world, {
      xPos: center.xPos,
      yPos: center.yPos,
      genesQ: { [Gene.Process + Resource.Foliage]: Q, [Gene.Process + Resource.Meat]: 0 },
      energyFractionQ: 0,
    });
    const carnivore = spawnTestOrganism(world, {
      xPos: center.xPos + 4,
      yPos: center.yPos,
      genesQ: { [Gene.Process + Resource.Meat]: Q, [Gene.Process + Resource.Foliage]: 0 },
      energyFractionQ: 0,
    });
    feed(world);
    expect(world.ctx.scratch.feedingAllocated[herbivore]).toBe(
      world.ctx.scratch.feedingAllocated[carnivore] as number,
    );
    expect(world.organisms.energy[herbivore]).toBeGreaterThan(
      (world.organisms.energy[carnivore] as number) * 3,
    );
  });

  it("never fills an organism past its maximum energy", () => {
    const world = createTestWorld({ plantCapacity: 60000, plantBiomass: 60000 });
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), energyFractionQ: Q });
    const before = world.organisms.energy[slot] as number;
    feed(world);
    expect(world.organisms.energy[slot]).toBe(before);
  });
});

describe("claim bookkeeping", () => {
  it("clears stale claims between ticks", () => {
    const world = createTestWorld({ plantCapacity: 60000, plantBiomass: 60000 });
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    feed(world);
    expect(world.ctx.scratch.feedingRequest[slot]).toBeGreaterThan(0);

    // A tick where nobody eats must leave no residue behind.
    feed(world, 0);
    expect(world.ctx.scratch.feedingRequest[slot]).toBe(0);
    expect(world.ctx.scratch.feedingAllocated[slot]).toBe(0);
    expect(world.ctx.scratch.demandedCellCount).toBe(0);
    for (let i = 0; i < world.environment.cellCount; i += 1) {
      expect(world.ctx.scratch.plantDemandPerCell[i]).toBe(0);
    }
  });

  it("ignores dead slots", () => {
    const world = createTestWorld({ plantCapacity: 60000, plantBiomass: 60000 });
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    world.organisms.releaseSlot(slot);
    const before = totalBiomass(world);
    feed(world);
    expect(totalBiomass(world)).toBe(before);
  });
});

describe("large contested populations", () => {
  it("conserves biomass exactly across many cells and claimants", () => {
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: 9 });
    for (let cell = 0; cell < 12; cell += 1) {
      const center = world.cellCenter(3 + cell * 2, 7);
      for (let i = 0; i < 7; i += 1) {
        spawnTestOrganism(world, { xPos: center.xPos + i * 3, yPos: center.yPos + i });
      }
    }
    const before = totalBiomass(world);
    feed(world);
    const allocated = totalAllocated(world);
    expect(allocated).toBe(12 * 9);
    expect(before - totalBiomass(world)).toBe(allocated);
  });

  it("keeps every claimant's share within one unit of its proportional entitlement", () => {
    const biomass = 10;
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: biomass });
    const center = world.cellCenter(10, 10);
    const slots: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      slots.push(
        spawnTestOrganism(world, { xPos: center.xPos + i * POS_SCALE, yPos: center.yPos }),
      );
    }
    feed(world);

    let demand = 0;
    for (const slot of slots) {
      demand += world.ctx.scratch.feedingRequest[slot] as number;
    }
    expect(demand).toBeGreaterThan(biomass);
    for (const slot of slots) {
      const request = world.ctx.scratch.feedingRequest[slot] as number;
      const fair = (request * biomass) / demand;
      const actual = world.ctx.scratch.feedingAllocated[slot] as number;
      expect(Math.abs(actual - fair)).toBeLessThan(1);
    }
  });
});
