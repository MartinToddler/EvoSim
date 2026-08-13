import { describe, expect, it } from "vitest";
import { ANGLE_STEPS, POS_SCALE, Q } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { BRAIN_INPUT_COUNT, BrainInput } from "./BrainLayout";
import { senseAll } from "./sensors";

/**
 * Carcass sensing (docs/04 §13, docs/08 §18, task F02).
 *
 * The triple mirrors the creature triple exactly — proximity, forward, lateral —
 * because a carcass is just another thing in the world to steer toward. What
 * matters most is the encoding of ABSENCE: -Q, not 0. An organism at the very
 * edge of vision reads -Q, so a zero for absence would rank above a distant
 * sighting and invert the ordering the founder's eat weight is calibrated
 * against (ADR 0004 §1).
 */

function sense(world: TestWorld, tick = 0): void {
  world.ctx.spatialPre.rebuild(world.organisms);
  world.ctx.carcassIndex.rebuildFrom(
    world.carcasses.slotHighWater,
    world.carcasses.active,
    world.carcasses.x,
    world.carcasses.y,
  );
  senseAll(world.ctx, tick);
}

function sensor(world: TestWorld, slot: number, input: number): number {
  return world.ctx.scratch.sensorValues[slot * BRAIN_INPUT_COUNT + input] as number;
}

/** Wide eyes, so a test about distance is not accidentally a test about FOV. */
const WIDE_EYED = { [Gene.VisionRange]: Q, [Gene.VisionFov]: Q } as const;

describe("carcass sensors", () => {
  it("reports absence as -Q proximity and zero direction", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: WIDE_EYED });

    sense(world);

    expect(sensor(world, observer, BrainInput.CarcassProximity)).toBe(-Q);
    expect(sensor(world, observer, BrainInput.CarcassForward)).toBe(0);
    expect(sensor(world, observer, BrainInput.CarcassLateral)).toBe(0);
  });

  it("rises toward +Q as a carcass gets closer", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: WIDE_EYED });
    const range = world.ctx.phenotypes.visionRangePos[observer] as number;
    const ox = world.organisms.x[observer] as number;
    const oy = world.organisms.y[observer] as number;

    const far = world.carcasses.create(1, ox + range - POS_SCALE, oy, 100, 1);
    sense(world);
    const farProximity = sensor(world, observer, BrainInput.CarcassProximity);

    world.carcasses.release(far);
    world.carcasses.create(2, ox + (range >> 2), oy, 100, 1);
    sense(world);
    const nearProximity = sensor(world, observer, BrainInput.CarcassProximity);

    expect(farProximity).toBeLessThan(nearProximity);
    expect(farProximity).toBeGreaterThan(-Q);
    expect(nearProximity).toBeLessThan(Q);
  });

  it("does not see a carcass beyond its genetic vision range", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, { ...world.cellCenter(20, 20), genesQ: WIDE_EYED });
    const range = world.ctx.phenotypes.visionRangePos[observer] as number;
    world.carcasses.create(
      1,
      (world.organisms.x[observer] as number) + range + POS_SCALE,
      world.organisms.y[observer] as number,
      100,
      1,
    );

    sense(world);

    expect(sensor(world, observer, BrainInput.CarcassProximity)).toBe(-Q);
  });

  it("puts a carcass dead ahead on the forward axis, and one to the side on the lateral axis", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: WIDE_EYED,
      angle: 0, // facing +x
    });
    const ox = world.organisms.x[observer] as number;
    const oy = world.organisms.y[observer] as number;
    const step = 8 * POS_SCALE;

    const ahead = world.carcasses.create(1, ox + step, oy, 100, 1);
    sense(world);
    expect(sensor(world, observer, BrainInput.CarcassForward)).toBeGreaterThan(Q >> 1);
    expect(Math.abs(sensor(world, observer, BrainInput.CarcassLateral))).toBeLessThan(Q >> 2);

    // +y is a quarter turn clockwise from +x in this convention, so a carcass
    // there must read as being on the RIGHT: positive lateral (docs/08 §18).
    world.carcasses.release(ahead);
    world.carcasses.create(2, ox, oy + step, 100, 1);
    sense(world);
    expect(sensor(world, observer, BrainInput.CarcassLateral)).toBeGreaterThan(Q >> 1);
    expect(Math.abs(sensor(world, observer, BrainInput.CarcassForward))).toBeLessThan(Q >> 2);
  });

  it("hides a carcass behind a narrow-eyed observer", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: { [Gene.VisionRange]: Q, [Gene.VisionFov]: 0 },
      angle: 0,
    });
    const behind = (world.organisms.x[observer] as number) - 8 * POS_SCALE;
    world.carcasses.create(1, behind, world.organisms.y[observer] as number, 100, 1);

    sense(world);

    expect(sensor(world, observer, BrainInput.CarcassProximity)).toBe(-Q);
  });

  it("breaks an equal-distance tie on the lower carcass entity ID", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: WIDE_EYED,
      angle: 0,
    });
    const ox = world.organisms.x[observer] as number;
    const oy = world.organisms.y[observer] as number;
    const step = 8 * POS_SCALE;

    // Same distance, opposite sides: only the identity separates them, and the
    // lower ID must win whichever slot it happens to occupy.
    world.carcasses.create(77, ox, oy - step, 100, 1);
    world.carcasses.create(42, ox, oy + step, 100, 1);
    sense(world);
    const lateralWithLowIdOnRight = sensor(world, observer, BrainInput.CarcassLateral);

    const swapped = createTestWorld();
    const other = spawnTestOrganism(swapped, {
      ...swapped.cellCenter(20, 20),
      genesQ: WIDE_EYED,
      angle: 0,
    });
    swapped.carcasses.create(42, ox, oy - step, 100, 1);
    swapped.carcasses.create(77, ox, oy + step, 100, 1);
    sense(swapped);
    const lateralWithLowIdOnLeft = sensor(swapped, other, BrainInput.CarcassLateral);

    expect(lateralWithLowIdOnRight).toBeGreaterThan(0);
    expect(lateralWithLowIdOnLeft).toBeLessThan(0);
    expect(lateralWithLowIdOnLeft).toBe(-lateralWithLowIdOnRight);
  });

  it("prefers the nearer carcass over the lower identity", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: WIDE_EYED,
      angle: 0,
    });
    const ox = world.organisms.x[observer] as number;
    const oy = world.organisms.y[observer] as number;

    const farSlot = world.carcasses.create(1, ox + 40 * POS_SCALE, oy, 100, 1);
    world.carcasses.create(999, ox + 4 * POS_SCALE, oy, 100, 1);
    sense(world);

    // Distance dominates; identity only settles genuine ties (docs/03 §10).
    // Removing the far, lower-ID carcass must therefore change nothing.
    const proximity = sensor(world, observer, BrainInput.CarcassProximity);
    world.carcasses.release(farSlot);
    sense(world);
    expect(sensor(world, observer, BrainInput.CarcassProximity)).toBe(proximity);
  });

  it("stops reporting a carcass that has been removed", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: WIDE_EYED });
    const slot = world.carcasses.create(
      5,
      (world.organisms.x[observer] as number) + 4 * POS_SCALE,
      world.organisms.y[observer] as number,
      100,
      1,
    );

    sense(world);
    expect(sensor(world, observer, BrainInput.CarcassProximity)).toBeGreaterThan(-Q);

    world.carcasses.release(slot);
    sense(world);
    expect(sensor(world, observer, BrainInput.CarcassProximity)).toBe(-Q);
  });

  it("leaves every other sensor untouched by the presence of carrion", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, { ...world.cellCenter(10, 10), genesQ: WIDE_EYED });

    sense(world);
    const before = Array.from(
      world.ctx.scratch.sensorValues.subarray(
        observer * BRAIN_INPUT_COUNT,
        (observer + 1) * BRAIN_INPUT_COUNT,
      ),
    );

    world.carcasses.create(
      5,
      (world.organisms.x[observer] as number) + 4 * POS_SCALE,
      world.organisms.y[observer] as number,
      100,
      1,
    );
    sense(world);
    const after = Array.from(
      world.ctx.scratch.sensorValues.subarray(
        observer * BRAIN_INPUT_COUNT,
        (observer + 1) * BRAIN_INPUT_COUNT,
      ),
    );

    const carcassInputs = new Set<number>([
      BrainInput.CarcassProximity,
      BrainInput.CarcassForward,
      BrainInput.CarcassLateral,
    ]);
    for (let input = 0; input < BRAIN_INPUT_COUNT; input += 1) {
      if (carcassInputs.has(input)) {
        continue;
      }
      expect(`${input}:${after[input]}`).toBe(`${input}:${before[input]}`);
    }
    // A carcass is not a creature: it must not appear on the creature channel.
    expect(after[BrainInput.CreatureProximity]).toBe(-Q);
  });

  it("wraps the heading basis correctly for a carcass sensed on a turned observer", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, {
      ...world.cellCenter(20, 20),
      genesQ: WIDE_EYED,
      angle: ANGLE_STEPS / 2, // facing -x
    });
    world.carcasses.create(
      1,
      (world.organisms.x[observer] as number) - 8 * POS_SCALE,
      world.organisms.y[observer] as number,
      100,
      1,
    );

    sense(world);

    // Behind in world coordinates, ahead in the observer's own frame.
    expect(sensor(world, observer, BrainInput.CarcassForward)).toBeGreaterThan(Q >> 1);
  });
});
