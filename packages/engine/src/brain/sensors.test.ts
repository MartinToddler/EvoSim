import { PLANT_RESOURCE_COUNT, Resource } from "../world/resources";
import { describe, expect, it } from "vitest";
import { ANGLE_STEPS, POS_SCALE, Q } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { createTestWorld, spawnTestOrganism } from "../testing/harness";
import { BRAIN_INPUT_COUNT, BRAIN_INPUT_NAMES, BrainInput } from "./BrainLayout";
import { senseAll } from "./sensors";

/**
 * Sensor fixture (docs/08 §18, task D05).
 *
 * These assertions pin the meaning of every input index. The brain is a black
 * box that evolves; the sensor contract is not, and silently changing what
 * index 6 means would reinterpret every inherited weight in every save.
 */

function sensorsOf(world: ReturnType<typeof createTestWorld>, slot: number, tick = 0): Int16Array {
  world.ctx.spatialPre.rebuild(world.organisms);
  senseAll(world.ctx, tick);
  const base = slot * BRAIN_INPUT_COUNT;
  return world.ctx.scratch.sensorValues.slice(base, base + BRAIN_INPUT_COUNT);
}

describe("sensor vector shape", () => {
  it("writes exactly one named value per input index", () => {
    expect(BRAIN_INPUT_NAMES).toHaveLength(BRAIN_INPUT_COUNT);
    expect(new Set(BRAIN_INPUT_NAMES).size).toBe(BRAIN_INPUT_COUNT);
    // One key per *named* input, and three of those names each stand for a
    // block of PLANT_RESOURCE_COUNT consecutive inputs (M17): the local
    // density, the forward gradient and the lateral gradient of every channel.
    // That contiguity is what lets the sensor loop write
    // `LocalResource + resource` instead of switching on channel identity.
    const blocks = 3;
    expect(Object.keys(BrainInput)).toHaveLength(
      BRAIN_INPUT_COUNT - blocks * PLANT_RESOURCE_COUNT + blocks,
    );
  });

  it("keeps every value inside the signed Q range", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const slot = spawnTestOrganism(world, center);
    spawnTestOrganism(world, { xPos: center.xPos + 1024, yPos: center.yPos + 512 });

    for (let tick = 0; tick < 200; tick += 7) {
      const sensors = sensorsOf(world, slot, tick);
      for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
        expect(`${BRAIN_INPUT_NAMES[i]}:${(sensors[i] as number) >= -Q}`).toBe(
          `${BRAIN_INPUT_NAMES[i]}:true`,
        );
        expect(`${BRAIN_INPUT_NAMES[i]}:${(sensors[i] as number) <= Q}`).toBe(
          `${BRAIN_INPUT_NAMES[i]}:true`,
        );
      }
    }
  });
});

describe("interoception", () => {
  it("reports bias, health and energy as documented", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, {
      ...world.cellCenter(10, 10),
      energyFractionQ: Q,
    });
    const sensors = sensorsOf(world, slot);
    expect(sensors[BrainInput.Bias]).toBe(Q);
    expect(sensors[BrainInput.Health]).toBe(Q);
    expect(sensors[BrainInput.Energy]).toBe(Q);

    world.organisms.energy[slot] = 0;
    expect(sensorsOf(world, slot)[BrainInput.Energy]).toBe(-Q);

    world.organisms.healthQ[slot] = Q >> 1;
    expect(sensorsOf(world, slot)[BrainInput.Health]).toBe(0);
  });

  it("reports a newborn as -Q development and a mature body as +Q", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    expect(sensorsOf(world, slot)[BrainInput.Development]).toBe(-Q);

    world.organisms.developmentQ[slot] = Q;
    expect(sensorsOf(world, slot)[BrainInput.Development]).toBe(Q);
  });
});

describe("plant sensing", () => {
  it("reads local density against the cell's own capacity", () => {
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: 500 });
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    expect(sensorsOf(world, slot)[BrainInput.LocalResource + Resource.Foliage]).toBe(0);

    world.environment.resourceBiomass.fill(1000);
    expect(sensorsOf(world, slot)[BrainInput.LocalResource + Resource.Foliage]).toBe(Q);

    world.environment.resourceBiomass.fill(0);
    expect(sensorsOf(world, slot)[BrainInput.LocalResource + Resource.Foliage]).toBe(-Q);
  });

  it("reports a barren cell as empty rather than dividing by zero", () => {
    const world = createTestWorld({ plantCapacity: 0, plantBiomass: 0 });
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    expect(sensorsOf(world, slot)[BrainInput.LocalResource + Resource.Foliage]).toBe(-Q);
  });

  it("projects the food gradient onto forward and lateral, not into a bearing", () => {
    const world = createTestWorld({ plantCapacity: 1000, plantBiomass: 100 });
    const center = world.cellCenter(10, 10);
    // Richer ground to the east (+x).
    world.environment.resourceBiomass[world.environment.cellIndex(11, 10)] = 900;

    const facingEast = spawnTestOrganism(world, { ...center, angle: 0 });
    const east = sensorsOf(world, facingEast);
    expect(east[BrainInput.ResourceGradientForward + Resource.Foliage]).toBeGreaterThan(0);
    expect(east[BrainInput.ResourceGradientLateral + Resource.Foliage]).toBe(0);

    // Facing north (a quarter turn anticlockwise on screen), the same food is
    // now to the right, which is the positive lateral direction.
    const facingNorth = spawnTestOrganism(world, {
      ...world.cellCenter(10, 12),
      angle: (3 * ANGLE_STEPS) / 4,
    });
    world.environment.resourceBiomass[world.environment.cellIndex(11, 12)] = 900;
    const north = sensorsOf(world, facingNorth);
    expect(north[BrainInput.ResourceGradientLateral + Resource.Foliage]).toBeGreaterThan(0);
  });
});

describe("carcass inputs before Milestone 5", () => {
  it("reports absence as -Q proximity with zero direction", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    const sensors = sensorsOf(world, slot);
    expect(sensors[BrainInput.CarcassProximity]).toBe(-Q);
    expect(sensors[BrainInput.CarcassForward]).toBe(0);
    expect(sensors[BrainInput.CarcassLateral]).toBe(0);
  });
});

describe("creature sensing", () => {
  it("reports absence as -Q proximity and zeroes every other creature input", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    const sensors = sensorsOf(world, slot);
    expect(sensors[BrainInput.CreatureProximity]).toBe(-Q);
    expect(sensors[BrainInput.CreatureForward]).toBe(0);
    expect(sensors[BrainInput.CreatureLateral]).toBe(0);
    expect(sensors[BrainInput.CreatureRelativeSize]).toBe(0);
    expect(sensors[BrainInput.CreatureHueDifference]).toBe(0);
  });

  it("rises toward +Q as another creature approaches", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, { ...center, angle: 0 });
    const other = spawnTestOrganism(world, {
      xPos: center.xPos + 30 * POS_SCALE,
      yPos: center.yPos,
    });
    const far = sensorsOf(world, observer)[BrainInput.CreatureProximity] as number;

    world.organisms.x[other] = center.xPos + 5 * POS_SCALE;
    const near = sensorsOf(world, observer)[BrainInput.CreatureProximity] as number;
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThanOrEqual(Q);
  });

  it("puts a creature ahead on forward and a creature to the right on lateral", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, { ...center, angle: 0 });
    const other = spawnTestOrganism(world, {
      xPos: center.xPos + 20 * POS_SCALE,
      yPos: center.yPos,
    });
    let sensors = sensorsOf(world, observer);
    expect(sensors[BrainInput.CreatureForward]).toBeGreaterThan(3000);
    expect(sensors[BrainInput.CreatureLateral]).toBe(0);

    // Screen coordinates run y downward, so +y is to the right of an
    // east-facing organism. 45° off the heading keeps it inside the default
    // field of view, which only spans ±76°.
    world.organisms.x[other] = center.xPos + 14 * POS_SCALE;
    world.organisms.y[other] = center.yPos + 14 * POS_SCALE;
    sensors = sensorsOf(world, observer);
    expect(sensors[BrainInput.CreatureForward]).toBeGreaterThan(0);
    expect(sensors[BrainInput.CreatureLateral]).toBeGreaterThan(2000);

    world.organisms.y[other] = center.yPos - 14 * POS_SCALE;
    sensors = sensorsOf(world, observer);
    expect(sensors[BrainInput.CreatureLateral]).toBeLessThan(-2000);
  });

  it("reports relative size and hue difference, but never species or diet", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, {
      ...center,
      angle: 0,
      genesQ: { [Gene.AdultSize]: 0, [Gene.Hue]: 0 },
    });
    spawnTestOrganism(world, {
      xPos: center.xPos + 20 * POS_SCALE,
      yPos: center.yPos,
      genesQ: { [Gene.AdultSize]: Q, [Gene.Hue]: Q / 2 },
    });

    const sensors = sensorsOf(world, observer);
    // Much larger body → saturates at +Q.
    expect(sensors[BrainInput.CreatureRelativeSize]).toBe(Q);
    // 180° hue apart → the extreme of the circular difference.
    expect(Math.abs(sensors[BrainInput.CreatureHueDifference] as number)).toBe(Q);
  });
});

describe("thermal comfort", () => {
  it("is +Q inside tolerance and falls to -Q under maximum stress", () => {
    const comfortAt = (temperatureCentiC: number): number => {
      const world = createTestWorld({ temperatureCentiC });
      const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
      return sensorsOf(world, slot)[BrainInput.ThermalComfort] as number;
    };

    // The founder optimum is +18 °C with a 13.5 °C tolerance.
    expect(comfortAt(1800)).toBe(Q);
    expect(comfortAt(3000)).toBe(Q);
    expect(comfortAt(4000)).toBeLessThan(Q);
    expect(comfortAt(9000)).toBe(-Q);
    expect(comfortAt(-9000)).toBe(-Q);
  });
});

describe("crowding", () => {
  it("runs from isolated at -Q to saturated at +Q", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, center);
    expect(sensorsOf(world, observer)[BrainInput.Crowding]).toBe(-Q);

    for (let i = 0; i < world.config.senses.crowdingSaturationCount; i += 1) {
      spawnTestOrganism(world, { xPos: center.xPos + 64 * (i + 1), yPos: center.yPos });
    }
    expect(sensorsOf(world, observer)[BrainInput.Crowding]).toBe(Q);
  });
});

describe("terrain danger", () => {
  it("is zero on open land", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    const sensors = sensorsOf(world, slot);
    expect(sensors[BrainInput.TerrainDangerForward]).toBe(0);
    expect(sensors[BrainInput.TerrainDangerLateral]).toBe(0);
  });

  it("rises when water lies ahead", () => {
    const world = createTestWorld();
    world.makeWater(11, 10);
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    expect(sensorsOf(world, slot)[BrainInput.TerrainDangerForward]).toBeGreaterThan(0);
  });

  it("reports the world edge as danger, because the boundary is a wall", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, {
      xPos: world.worldSizePos - 8,
      yPos: world.worldSizePos >> 1,
      angle: 0,
    });
    expect(sensorsOf(world, slot)[BrainInput.TerrainDangerForward]).toBe(Q);
  });

  it("signs the lateral input positive when the danger is on the left", () => {
    // Facing east on screen (y downward): left is north, right is south.
    const world = createTestWorld();
    world.makeWater(10, 9); // north of the organism
    const slot = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    expect(sensorsOf(world, slot)[BrainInput.TerrainDangerLateral]).toBeGreaterThan(0);

    const mirrored = createTestWorld();
    mirrored.makeWater(10, 11); // south of the organism
    const other = spawnTestOrganism(mirrored, { ...mirrored.cellCenter(10, 10), angle: 0 });
    expect(sensorsOf(mirrored, other)[BrainInput.TerrainDangerLateral]).toBeLessThan(0);
  });
});

describe("internal signal", () => {
  it("varies over time without touching the PRNG", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    const before = world.ctx.rng.serializeState();

    const values = new Set<number>();
    for (let tick = 0; tick < 64; tick += 1) {
      values.add(sensorsOf(world, slot, tick)[BrainInput.InternalSignal] as number);
    }
    expect(values.size).toBeGreaterThan(20);
    // Sensing must never advance the authoritative generator: a render or a
    // UI query would otherwise change the simulation (docs/04 §16).
    expect(world.ctx.rng.serializeState()).toEqual(before);
  });

  it("is a pure function of seed, entity and tick", () => {
    const world = createTestWorld();
    const slot = spawnTestOrganism(world, world.cellCenter(10, 10));
    const first = sensorsOf(world, slot, 1234)[BrainInput.InternalSignal];
    const second = sensorsOf(world, slot, 1234)[BrainInput.InternalSignal];
    expect(second).toBe(first);
  });

  it("gives different organisms different phases", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const a = spawnTestOrganism(world, center);
    const b = spawnTestOrganism(world, { xPos: center.xPos + 4096, yPos: center.yPos });
    let differences = 0;
    for (let tick = 0; tick < 32; tick += 1) {
      const sa = sensorsOf(world, a, tick)[BrainInput.InternalSignal];
      const sb = sensorsOf(world, b, tick)[BrainInput.InternalSignal];
      if (sa !== sb) {
        differences += 1;
      }
    }
    expect(differences).toBeGreaterThan(24);
  });
});
