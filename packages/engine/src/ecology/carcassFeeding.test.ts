import { describe, expect, it } from "vitest";
import { POS_SCALE, Q, qmul } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { currentRadiusPos, massFromRadiusPos } from "../organisms/phenotype";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import {
  FeedingTarget,
  buildFeedingClaims,
  meatBiteUnits,
  resolveFeedingClaims,
  totalAllocatedMeat,
} from "./feedingClaims";

/**
 * Carcass feeding and the diet trade-off (docs/03 §§21, 23–24, docs/04 §20,
 * tasks F02/F03).
 *
 * Two properties matter here. Meat is conserved exactly — units taken off a
 * carcass equal units granted to eaters — and the food-target policy is the one
 * docs/04 §20 specifies, which is what makes a herbivore's refusal of carrion an
 * ecological cost rather than a bug.
 */

/** Diet gene value that makes meat digest better than plants, and the reverse. */
const CARNIVORE = { [Gene.Diet]: Q } as const;
const HERBIVORE = { [Gene.Diet]: 0 } as const;

function feed(world: TestWorld, eatQ: number = Q): void {
  for (let slot = 0; slot < world.organisms.slotHighWater; slot += 1) {
    world.ctx.scratch.eatQ[slot] = eatQ;
  }
  world.ctx.carcassIndex.rebuildFrom(
    world.carcasses.slotHighWater,
    world.carcasses.active,
    world.carcasses.x,
    world.carcasses.y,
  );
  buildFeedingClaims(world.ctx);
  resolveFeedingClaims(world.ctx);
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

/** Put a carcass exactly under an organism, i.e. inside its mouth range. */
function carcassUnder(world: TestWorld, slot: number, meat: number, entityId = 9001): number {
  return world.carcasses.create(
    entityId,
    world.organisms.x[slot] as number,
    world.organisms.y[slot] as number,
    meat,
    1,
  );
}

describe("the food-target policy (docs/04 §20)", () => {
  it("sends a carnivore to a carcass under its body", () => {
    const world = createTestWorld();
    const eater = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: CARNIVORE });
    carcassUnder(world, eater, 500);

    feed(world);

    expect(world.ctx.scratch.feedingTargetType[eater]).toBe(FeedingTarget.Carcass);
    expect(world.organisms.meatEnergyEaten[eater]).toBeGreaterThan(0);
    expect(world.organisms.plantEnergyEaten[eater]).toBe(0);
  });

  it("keeps a herbivore grazing even while standing on meat", () => {
    const world = createTestWorld();
    const eater = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: HERBIVORE });
    carcassUnder(world, eater, 500);

    feed(world);

    // docs/04 §20 exactly: meat efficiency is below plant efficiency, so the
    // carcass is ignored. This is the documented cost of specialization.
    expect(world.ctx.scratch.feedingTargetType[eater]).toBe(FeedingTarget.Plant);
    expect(world.organisms.meatEnergyEaten[eater]).toBe(0);
    expect(world.organisms.plantEnergyEaten[eater]).toBeGreaterThan(0);
    expect(world.carcasses.remainingMeat[0]).toBe(500);
  });

  it("leaves a herbivore with nothing on a stripped cell it is sharing with a carcass", () => {
    const world = createTestWorld({ plantBiomass: 0 });
    const eater = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: HERBIVORE });
    carcassUnder(world, eater, 500);

    feed(world);

    expect(world.ctx.scratch.feedingTargetType[eater]).toBe(FeedingTarget.None);
    expect(world.organisms.plantEnergyEaten[eater]).toBe(0);
    expect(world.organisms.meatEnergyEaten[eater]).toBe(0);
  });

  it("makes a carnivore graze when no carcass is in mouth range", () => {
    const world = createTestWorld();
    const eater = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: CARNIVORE });
    // Well outside the body: visible perhaps, but not under the mouth.
    world.carcasses.create(
      42,
      (world.organisms.x[eater] as number) + 30 * POS_SCALE,
      world.organisms.y[eater] as number,
      500,
      1,
    );

    feed(world);

    expect(world.ctx.scratch.feedingTargetType[eater]).toBe(FeedingTarget.Plant);
    expect(world.carcasses.remainingMeat[0]).toBe(500);
  });

  it("ignores an eat intent below the threshold", () => {
    const world = createTestWorld();
    const eater = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: CARNIVORE });
    carcassUnder(world, eater, 500);

    feed(world, world.config.organism.feeding.eatOutputThresholdQ - 1);

    expect(world.ctx.scratch.feedingTargetType[eater]).toBe(FeedingTarget.None);
    expect(world.carcasses.remainingMeat[0]).toBe(500);
  });
});

describe("meat energy", () => {
  it("converts meat at the configured rate through the eater's meat efficiency", () => {
    const world = createTestWorld();
    const eater = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: CARNIVORE });
    carcassUnder(world, eater, 10_000);
    const bite = meatBiteUnits(world.ctx, eater, massOf(world, eater));

    feed(world);

    const expected = qmul(
      bite * world.config.plants.meatEnergyPerUnit,
      world.ctx.phenotypes.meatEfficiencyQ[eater] as number,
    );
    expect(world.ctx.scratch.feedingAllocated[eater]).toBe(bite);
    expect(world.organisms.meatEnergyEaten[eater]).toBe(expected);
    expect(world.carcasses.remainingMeat[0]).toBe(10_000 - bite);
  });

  it("feeds a carnivore specialist better than a generalist from the same carcass", () => {
    const world = createTestWorld();
    const specialist = spawnTestOrganism(world, { ...world.cellCenter(6, 6), genesQ: CARNIVORE });
    const generalist = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: { [Gene.Diet]: Q >> 1 },
    });
    carcassUnder(world, specialist, 10_000, 101);
    carcassUnder(world, generalist, 10_000, 102);

    feed(world);

    // Same mouthful, different digestion: the signed diet gene is the only
    // difference between these two organisms.
    expect(world.ctx.scratch.feedingAllocated[specialist]).toBe(
      world.ctx.scratch.feedingAllocated[generalist],
    );
    expect(world.organisms.meatEnergyEaten[specialist]).toBeGreaterThan(
      world.organisms.meatEnergyEaten[generalist] as number,
    );
  });

  it("never lets an eater exceed its own maximum energy", () => {
    const world = createTestWorld();
    const eater = spawnTestOrganism(world, {
      ...world.cellCenter(10, 10),
      genesQ: CARNIVORE,
      energyFractionQ: Q,
    });
    carcassUnder(world, eater, 10_000);
    const before = world.organisms.energy[eater] as number;

    feed(world);

    expect(world.organisms.energy[eater]).toBe(before);
    // The meat was still consumed: a full stomach does not put it back.
    expect(world.carcasses.totalMeatEaten).toBeGreaterThan(0);
  });
});

describe("carcass claim resolution", () => {
  it("satisfies everyone when the carcass can afford the demand", () => {
    const world = createTestWorld();
    const place = world.cellCenter(10, 10);
    const eaters = [0, 1, 2].map(() => spawnTestOrganism(world, { ...place, genesQ: CARNIVORE }));
    const carcass = carcassUnder(world, eaters[0] as number, 10_000);

    feed(world);

    let granted = 0;
    for (const slot of eaters) {
      expect(world.ctx.scratch.feedingAllocated[slot]).toBe(world.ctx.scratch.feedingRequest[slot]);
      granted += world.ctx.scratch.feedingAllocated[slot] as number;
    }
    expect(world.carcasses.remainingMeat[carcass]).toBe(10_000 - granted);
    expect(world.carcasses.totalMeatEaten).toBe(granted);
  });

  it("shares a scarce carcass proportionally and conserves every unit", () => {
    const world = createTestWorld();
    const place = world.cellCenter(10, 10);
    const eaters = [0, 1, 2, 3].map(() =>
      spawnTestOrganism(world, { ...place, genesQ: CARNIVORE }),
    );
    // Less meat than the four of them ask for.
    const carcass = carcassUnder(world, eaters[0] as number, 7);

    feed(world);

    expect(totalAllocatedMeat(world.ctx)).toBe(7);
    expect(world.carcasses.active[carcass]).toBe(0);
    expect(world.carcasses.totalMeatEaten).toBe(7);
    expect(
      world.carcasses.totalMeatEaten +
        world.carcasses.totalMeatDecayed +
        world.carcasses.totalRemainingMeat(),
    ).toBe(world.carcasses.totalMeatCreated);
  });

  it("hands the rounding remainder to the lowest entity IDs", () => {
    const world = createTestWorld();
    const place = world.cellCenter(10, 10);
    const eaters = [0, 1, 2].map(() => spawnTestOrganism(world, { ...place, genesQ: CARNIVORE }));
    // Each asks for the same amount; 8 units over 3 equal claimants divides as
    // 2 each with 2 left over, so the two oldest identities get one more.
    carcassUnder(world, eaters[0] as number, 8);

    feed(world);

    const allocated = eaters.map((slot) => world.ctx.scratch.feedingAllocated[slot] as number);
    expect(allocated.reduce((a, b) => a + b, 0)).toBe(8);
    expect(allocated[0]).toBeGreaterThanOrEqual(allocated[1] as number);
    expect(allocated[1]).toBeGreaterThanOrEqual(allocated[2] as number);
    expect((allocated[0] as number) - (allocated[2] as number)).toBeLessThanOrEqual(1);
  });

  it("releases a carcass eaten to nothing, and reuses its slot", () => {
    const world = createTestWorld();
    const eater = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: CARNIVORE });
    const carcass = carcassUnder(world, eater, 3);

    feed(world);

    expect(world.carcasses.active[carcass]).toBe(0);
    expect(world.carcasses.liveCount).toBe(0);
    expect(world.carcasses.create(555, 0, 0, 10, 1)).toBe(carcass);
  });

  it("does not double-book an eater on both a carcass and a plant cell", () => {
    const world = createTestWorld();
    const eater = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: CARNIVORE });
    carcassUnder(world, eater, 10_000);
    const biomassBefore = world.environment.plantBiomass[
      world.environment.cellIndexFromPosition(
        world.organisms.x[eater] as number,
        world.organisms.y[eater] as number,
      )
    ] as number;

    feed(world);

    expect(world.ctx.scratch.feedingTargetType[eater]).toBe(FeedingTarget.Carcass);
    expect(
      world.environment.plantBiomass[
        world.environment.cellIndexFromPosition(
          world.organisms.x[eater] as number,
          world.organisms.y[eater] as number,
        )
      ],
    ).toBe(biomassBefore);
  });
});
