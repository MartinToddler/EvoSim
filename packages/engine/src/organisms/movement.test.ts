import { describe, expect, it } from "vitest";
import { ANGLE_STEPS, Q } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { VELOCITY_SCALE, integrateMovement, resolveTerrainAndSoftCollisions } from "./movement";
import { currentRadiusPos } from "./phenotype";

/**
 * Movement, terrain and soft collisions (docs/03 §§11-13, task D09).
 *
 * Every test drives the phases directly with hand-set intents, so what is
 * asserted is the physics, not whatever the brain happened to want.
 */

function setIntent(
  world: TestWorld,
  slot: number,
  intents: { throttleQ?: number; turnQ?: number },
): void {
  world.ctx.scratch.throttleQ[slot] = intents.throttleQ ?? 0;
  world.ctx.scratch.turnQ[slot] = intents.turnQ ?? 0;
}

function stepMovement(world: TestWorld): void {
  world.ctx.spatialPre.rebuild(world.organisms);
  integrateMovement(world.ctx);
  resolveTerrainAndSoftCollisions(world.ctx);
}

describe("turning", () => {
  it("turns right on a positive intent and left on a negative one", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 1000 });

    setIntent(world, slot, { turnQ: Q });
    stepMovement(world);
    const right = world.organisms.angle[slot] as number;
    expect(right).toBeGreaterThan(1000);

    world.organisms.angle[slot] = 1000;
    setIntent(world, slot, { turnQ: -Q });
    stepMovement(world);
    expect(world.organisms.angle[slot]).toBeLessThan(1000);
  });

  it("never turns faster than the genome allows", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    const maxTurn = world.ctx.phenotypes.maxTurnSteps[slot] as number;

    setIntent(world, slot, { turnQ: Q });
    stepMovement(world);
    expect(world.organisms.angle[slot]).toBe(maxTurn);
  });

  it("wraps the heading rather than letting it run out of range", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, {
      ...world.cellCenter(10, 10),
      angle: ANGLE_STEPS - 1,
    });
    setIntent(world, slot, { turnQ: Q });
    stepMovement(world);
    const angle = world.organisms.angle[slot] as number;
    expect(angle).toBeGreaterThanOrEqual(0);
    expect(angle).toBeLessThan(ANGLE_STEPS);
  });

  it("makes a big body turn more slowly than a small one", () => {
    const world = createTestWorld();
    const small = spawnTestOrganism(world, {
      ...world.cellCenter(10, 10),
      genesQ: { [Gene.AdultSize]: 0 },
    });
    const large = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: { [Gene.AdultSize]: Q },
    });
    expect(world.ctx.phenotypes.maxTurnSteps[large]).toBeLessThan(
      world.ctx.phenotypes.maxTurnSteps[small] as number,
    );
  });
});

describe("translation", () => {
  it("stays put with the throttle closed", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const slot = spawnTestOrganism(world, { ...center, angle: 0 });
    setIntent(world, slot, { throttleQ: 0 });
    for (let i = 0; i < 20; i += 1) {
      stepMovement(world);
    }
    expect(world.organisms.x[slot]).toBe(center.xPos);
    expect(world.organisms.y[slot]).toBe(center.yPos);
  });

  it("moves along its heading and nowhere else", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const slot = spawnTestOrganism(world, { ...center, angle: 0 });
    setIntent(world, slot, { throttleQ: Q });
    for (let i = 0; i < 100; i += 1) {
      stepMovement(world);
    }
    expect(world.organisms.x[slot]).toBeGreaterThan(center.xPos);
    expect(world.organisms.y[slot]).toBe(center.yPos);
  });

  it("covers exactly its cruising velocity over one full remainder cycle", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    setIntent(world, slot, { throttleQ: Q });
    for (let i = 0; i < 200; i += 1) {
      stepMovement(world);
    }

    // Cruising velocity is 35.5 sub-units per tick here, so individual steps
    // alternate between 35 and 36 — that alternation IS the point of the
    // remainder, and over VELOCITY_SCALE ticks it sums to the exact distance
    // with no drift at all.
    const before = world.organisms.x[slot] as number;
    const steps = new Set<number>();
    for (let i = 0; i < VELOCITY_SCALE; i += 1) {
      const previous = world.organisms.x[slot] as number;
      stepMovement(world);
      steps.add((world.organisms.x[slot] as number) - previous);
    }
    const maxSpeed = world.ctx.phenotypes.maxSpeedVel[slot] as number;
    expect((world.organisms.x[slot] as number) - before).toBe(maxSpeed);

    const ordered = [...steps].sort((a, b) => a - b);
    expect((ordered[ordered.length - 1] as number) - (ordered[0] as number)).toBeLessThanOrEqual(1);
  });

  it("accelerates gradually rather than jumping to top speed", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    setIntent(world, slot, { throttleQ: Q });
    const acceleration = world.ctx.phenotypes.accelerationVel[slot] as number;

    stepMovement(world);
    expect(world.organisms.vx[slot]).toBe(acceleration);
    stepMovement(world);
    expect(world.organisms.vx[slot]).toBe(2 * acceleration);
  });

  it("does not lose slow motion to truncation", () => {
    // The slowest genome moves 9 sub-units per tick at full throttle; at a
    // tenth of that, whole-sub-unit velocity would round every step to zero.
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const slot = spawnTestOrganism(world, {
      ...center,
      angle: 0,
      genesQ: { [Gene.MaxSpeed]: 0, [Gene.Acceleration]: Q },
    });
    setIntent(world, slot, { throttleQ: Q / 10 });
    for (let i = 0; i < 200; i += 1) {
      stepMovement(world);
    }
    expect(world.organisms.x[slot]).toBeGreaterThan(center.xPos);
  });

  it("reports the realized speed fraction for the metabolism phase", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    setIntent(world, slot, { throttleQ: 0 });
    stepMovement(world);
    expect(world.ctx.scratch.speedFractionQ[slot]).toBe(0);

    setIntent(world, slot, { throttleQ: Q });
    for (let i = 0; i < 200; i += 1) {
      stepMovement(world);
    }
    expect(world.ctx.scratch.speedFractionQ[slot]).toBeGreaterThan(Q - 64);
    expect(world.ctx.scratch.speedFractionQ[slot]).toBeLessThanOrEqual(Q);
  });

  it("makes armor cost realized speed", () => {
    const distanceWithArmor = (armorQ: number): number => {
      const world = createTestWorld();
      const center = world.cellCenter(10, 10);
      const slot = spawnTestOrganism(world, {
        ...center,
        angle: 0,
        genesQ: { [Gene.Armor]: armorQ },
      });
      setIntent(world, slot, { throttleQ: Q });
      for (let i = 0; i < 300; i += 1) {
        stepMovement(world);
      }
      return (world.organisms.x[slot] as number) - center.xPos;
    };
    expect(distanceWithArmor(Q)).toBeLessThan(distanceWithArmor(0));
  });
});

describe("world boundary", () => {
  it("clamps at the edge and drops the outward velocity", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, {
      xPos: world.worldSizePos - 4,
      yPos: world.worldSizePos >> 1,
      angle: 0,
    });
    setIntent(world, slot, { throttleQ: Q });
    for (let i = 0; i < 50; i += 1) {
      stepMovement(world);
    }
    expect(world.organisms.x[slot]).toBe(world.worldSizePos - 1);
    expect(world.organisms.vx[slot]).toBe(0);
  });

  it("clamps at the low edge too, with no wrap-around", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, {
      xPos: 4,
      yPos: world.worldSizePos >> 1,
      angle: ANGLE_STEPS / 2,
    });
    setIntent(world, slot, { throttleQ: Q });
    for (let i = 0; i < 50; i += 1) {
      stepMovement(world);
    }
    expect(world.organisms.x[slot]).toBe(0);
    // No toroidal wrap in MVP (docs/03 §12).
    expect(world.organisms.x[slot]).not.toBeGreaterThan(world.worldSizePos >> 1);
  });
});

describe("water", () => {
  it("slows movement without forbidding it", () => {
    const travel = (water: boolean): number => {
      const world = createTestWorld();
      const center = world.cellCenter(10, 10);
      if (water) {
        for (let gx = 10; gx < 30; gx += 1) {
          world.makeWater(gx, 10);
        }
      }
      const slot = spawnTestOrganism(world, { ...center, angle: 0 });
      setIntent(world, slot, { throttleQ: Q });
      for (let i = 0; i < 200; i += 1) {
        stepMovement(world);
      }
      return (world.organisms.x[slot] as number) - center.xPos;
    };

    const onLand = travel(false);
    const inWater = travel(true);
    expect(inWater).toBeGreaterThan(0); // entering water is possible
    expect(inWater).toBeLessThan(onLand / 2);
  });

  it("counts consecutive ticks in water and resets on dry land", () => {
    const world = createTestWorld();
    world.makeWater(10, 10);
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    setIntent(world, slot, { throttleQ: 0 });

    for (let i = 1; i <= 5; i += 1) {
      stepMovement(world);
      expect(world.organisms.waterTicks[slot]).toBe(i);
      expect(world.ctx.scratch.inWater[slot]).toBe(1);
    }

    const dry = world.cellCenter(20, 20);
    world.organisms.x[slot] = dry.xPos;
    world.organisms.y[slot] = dry.yPos;
    stepMovement(world);
    expect(world.organisms.waterTicks[slot]).toBe(0);
    expect(world.ctx.scratch.inWater[slot]).toBe(0);
  });
});

describe("soft collisions", () => {
  it("pushes overlapping bodies apart without teleporting them", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const a = spawnTestOrganism(world, { ...center, angle: 0 });
    const b = spawnTestOrganism(world, { xPos: center.xPos + 8, yPos: center.yPos, angle: 0 });
    setIntent(world, a, {});
    setIntent(world, b, {});

    const contact =
      currentRadiusPos(
        world.ctx.phenotypes.adultRadiusPos[a] as number,
        world.organisms.developmentQ[a] as number,
      ) +
      currentRadiusPos(
        world.ctx.phenotypes.adultRadiusPos[b] as number,
        world.organisms.developmentQ[b] as number,
      );

    let previousGap = (world.organisms.x[b] as number) - (world.organisms.x[a] as number);
    for (let i = 0; i < 40; i += 1) {
      stepMovement(world);
      const gap = (world.organisms.x[b] as number) - (world.organisms.x[a] as number);
      expect(gap).toBeGreaterThanOrEqual(previousGap);
      previousGap = gap;
    }
    expect(previousGap).toBeGreaterThan(8);
    // Overlap is allowed, only nudged: separation must not exceed contact.
    expect(previousGap).toBeLessThanOrEqual(contact);
  });

  it("separates exactly coincident bodies using their entity IDs", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const a = spawnTestOrganism(world, { ...center, angle: 0 });
    const b = spawnTestOrganism(world, { ...center, angle: 0 });
    setIntent(world, a, {});
    setIntent(world, b, {});

    stepMovement(world);
    const moved =
      world.organisms.x[a] !== world.organisms.x[b] ||
      world.organisms.y[a] !== world.organisms.y[b];
    expect(moved).toBe(true);
  });

  it("gives coincident bodies the same escape whichever slot holds which ID", () => {
    // docs/03 §13 derives the direction from an entity-ID hash. Once slots are
    // recycled (Milestone 4) the same two organisms can hold either slot, and
    // hashing them in slot order would send them apart differently depending
    // only on who died recently — storage order deciding an outcome.
    const separate = (idInLowerSlot: number, idInHigherSlot: number): Record<number, string> => {
      const world = createTestWorld();
      const center = world.cellCenter(10, 10);
      const low = spawnTestOrganism(world, { ...center, angle: 0 });
      const high = spawnTestOrganism(world, { ...center, angle: 0 });
      world.organisms.entityId[low] = idInLowerSlot;
      world.organisms.entityId[high] = idInHigherSlot;
      setIntent(world, low, {});
      setIntent(world, high, {});
      stepMovement(world);
      return {
        [idInLowerSlot]: `${world.organisms.x[low]},${world.organisms.y[low]}`,
        [idInHigherSlot]: `${world.organisms.x[high]},${world.organisms.y[high]}`,
      };
    };

    const lowIdFirst = separate(7, 9);
    const lowIdSecond = separate(9, 7);
    expect(lowIdSecond[7]).toBe(lowIdFirst[7]);
    expect(lowIdSecond[9]).toBe(lowIdFirst[9]);
    // And they really did move apart, so the assertion above is not vacuous.
    expect(lowIdFirst[7]).not.toBe(lowIdFirst[9]);
  });

  it("leaves distant organisms untouched", () => {
    const world = createTestWorld();
    const a = spawnTestOrganism(world, { ...world.cellCenter(5, 5), angle: 0 });
    const b = spawnTestOrganism(world, { ...world.cellCenter(30, 30), angle: 0 });
    setIntent(world, a, {});
    setIntent(world, b, {});
    const ax = world.organisms.x[a] as number;
    const bx = world.organisms.x[b] as number;
    stepMovement(world);
    expect(world.organisms.x[a]).toBe(ax);
    expect(world.organisms.x[b]).toBe(bx);
  });

  it("resolves a pair identically whichever slot each organism holds", () => {
    // Separation accumulates into scratch and is applied afterwards, so the
    // outcome must not depend on which organism the loop reaches first.
    const gapAfter = (swap: boolean): number => {
      const world = createTestWorld();
      const center = world.cellCenter(10, 10);
      const first = { ...center, angle: 0 };
      const second = { xPos: center.xPos + 16, yPos: center.yPos, angle: 0 };
      const a = spawnTestOrganism(world, swap ? second : first);
      const b = spawnTestOrganism(world, swap ? first : second);
      setIntent(world, a, {});
      setIntent(world, b, {});
      stepMovement(world);
      return Math.abs((world.organisms.x[a] as number) - (world.organisms.x[b] as number));
    };
    expect(gapAfter(false)).toBe(gapAfter(true));
  });
});

describe("position accounting", () => {
  it("keeps the sub-sub-unit remainder inside its range", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 700 });
    setIntent(world, slot, { throttleQ: Q / 3 });
    for (let i = 0; i < 100; i += 1) {
      stepMovement(world);
      expect(world.organisms.posFracX[slot]).toBeGreaterThanOrEqual(0);
      expect(world.organisms.posFracX[slot]).toBeLessThan(VELOCITY_SCALE);
      expect(world.organisms.posFracY[slot]).toBeLessThan(VELOCITY_SCALE);
    }
  });

  it("moves backwards exactly as far as forwards, with no floor bias", () => {
    // Negative motion floors while positive motion truncates, so a naive
    // implementation drifts one direction. Carrying the remainder bounds the
    // difference at a single sub-unit at any moment, and cancels it exactly
    // over a full remainder cycle.
    const world = createTestWorld();
    const east = spawnTestOrganism(world, { ...world.cellCenter(20, 20), angle: 0 });
    const west = spawnTestOrganism(world, {
      ...world.cellCenter(20, 30),
      angle: ANGLE_STEPS / 2,
    });
    setIntent(world, east, { throttleQ: Q });
    setIntent(world, west, { throttleQ: Q });
    for (let i = 0; i < 200; i += 1) {
      stepMovement(world);
    }

    const eastStart = world.organisms.x[east] as number;
    const westStart = world.organisms.x[west] as number;
    for (let i = 0; i < VELOCITY_SCALE; i += 1) {
      stepMovement(world);
    }
    expect((world.organisms.x[east] as number) - eastStart).toBe(
      westStart - (world.organisms.x[west] as number),
    );
  });
});

describe("dead organisms", () => {
  it("are not moved", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    setIntent(world, slot, { throttleQ: Q });
    world.organisms.releaseSlot(slot);
    stepMovement(world);
    expect(world.organisms.x[slot]).toBe(0);
    expect(world.organisms.vx[slot]).toBe(0);
  });
});
