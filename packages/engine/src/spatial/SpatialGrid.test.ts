import { describe, expect, it } from "vitest";
import { EonAssertionError } from "@eon/shared";
import { ANGLE_STEPS, POS_SCALE, Q } from "../math/fixed";
import { Gene } from "../genetics/genes";
import { createTestWorld, spawnTestOrganism } from "../testing/harness";
import { SpatialGrid } from "./SpatialGrid";
import { type NearestCreature, countCrowding, findNearestVisibleCreature } from "./queries";

describe("SpatialGrid", () => {
  it("derives its resolution from the world and cell size", () => {
    const grid = new SpatialGrid(4096, 32, 100);
    expect(grid.size).toBe(128);
    expect(grid.cellCount).toBe(128 * 128);
    expect(grid.cellSizePos).toBe(32 * POS_SCALE);
  });

  it("refuses a cell size that does not divide the world", () => {
    expect(() => new SpatialGrid(4096, 30, 10)).toThrow(EonAssertionError);
  });

  it("clamps out-of-world coordinates onto the border cells", () => {
    const grid = new SpatialGrid(4096, 32, 10);
    expect(grid.cellX(-1)).toBe(0);
    expect(grid.cellY(-100000)).toBe(0);
    expect(grid.cellX(4096 * POS_SCALE)).toBe(127);
    expect(grid.cellX(1e12)).toBe(127);
  });

  it("buckets organisms by position and leaves empty cells empty", () => {
    const world = createTestWorld();
    const a = spawnTestOrganism(world, world.cellCenter(1, 1));
    const b = spawnTestOrganism(world, world.cellCenter(1, 1));
    const c = spawnTestOrganism(world, world.cellCenter(40, 20));
    const grid = world.ctx.spatialPre;
    grid.rebuild(world.organisms);

    const cellOf = (slot: number): number =>
      grid.cellY(world.organisms.y[slot] as number) * grid.size +
      grid.cellX(world.organisms.x[slot] as number);

    const shared = cellOf(a);
    expect(cellOf(b)).toBe(shared);
    const members: number[] = [];
    for (let slot = grid.head[shared] as number; slot !== -1; slot = grid.next[slot] as number) {
      members.push(slot);
    }
    expect(members).toEqual([a, b]); // ascending slot order
    expect(grid.head[cellOf(c)]).toBe(c);

    // Every cell nobody occupies stays empty.
    let occupied = 0;
    for (let cell = 0; cell < grid.cellCount; cell += 1) {
      if (grid.head[cell] !== -1) {
        occupied += 1;
      }
    }
    expect(occupied).toBe(2);
  });

  it("drops dead organisms on rebuild", () => {
    const world = createTestWorld();
    const a = spawnTestOrganism(world, world.cellCenter(5, 5));
    const b = spawnTestOrganism(world, world.cellCenter(5, 5));
    world.organisms.releaseSlot(a);

    const grid = world.ctx.spatialPre;
    grid.rebuild(world.organisms);
    const cell =
      grid.cellY(world.organisms.y[b] as number) * grid.size +
      grid.cellX(world.organisms.x[b] as number);
    expect(grid.head[cell]).toBe(b);
    expect(grid.next[b]).toBe(-1);
  });
});

describe("nearest visible creature", () => {
  const out: NearestCreature = { slot: -1, distSq: 0 };

  function look(world: ReturnType<typeof createTestWorld>, observer: number): number {
    world.ctx.spatialPre.rebuild(world.organisms);
    findNearestVisibleCreature(world.ctx, observer, out);
    return out.slot;
  }

  it("finds nothing in an empty neighbourhood", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, world.cellCenter(10, 10));
    expect(look(world, observer)).toBe(-1);
  });

  it("never sees itself", () => {
    const world = createTestWorld();
    const observer = spawnTestOrganism(world, { ...world.cellCenter(10, 10), angle: 0 });
    expect(look(world, observer)).toBe(-1);
  });

  it("sees a neighbour ahead and not one beyond its vision range", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, { ...center, angle: 0 });
    const near = spawnTestOrganism(world, {
      xPos: center.xPos + 20 * POS_SCALE,
      yPos: center.yPos,
    });
    expect(look(world, observer)).toBe(near);

    world.organisms.releaseSlot(near);
    // The founder's vision range is ~42 LU; 200 LU is far outside it.
    spawnTestOrganism(world, { xPos: center.xPos + 200 * POS_SCALE, yPos: center.yPos });
    expect(look(world, observer)).toBe(-1);
  });

  it("respects the field of view", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    // Facing +x, with the default ~152° field of view: something directly
    // behind is invisible, the same body ahead is not.
    const observer = spawnTestOrganism(world, { ...center, angle: 0 });
    const behind = spawnTestOrganism(world, {
      xPos: center.xPos - 20 * POS_SCALE,
      yPos: center.yPos,
    });
    expect(look(world, observer)).toBe(-1);

    world.organisms.angle[observer] = ANGLE_STEPS / 2; // turn around
    expect(look(world, observer)).toBe(behind);
  });

  it("widens with the field-of-view gene, up to the configured 270° maximum", () => {
    // 120° off the heading: outside the default 152° cone (±76°) but inside
    // the widest genome's 270° cone (±135°). Each case gets its own world so
    // the two observers cannot see each other.
    const angle = (2 * Math.PI * 120) / 360;
    const distance = 20 * POS_SCALE;

    const sees = (fovGeneQ: number | undefined): number => {
      const world = createTestWorld();
      const center = world.cellCenter(10, 10);
      const observer = spawnTestOrganism(world, {
        ...center,
        angle: 0,
        ...(fovGeneQ === undefined ? {} : { genesQ: { [Gene.VisionFov]: fovGeneQ } }),
      });
      const target = spawnTestOrganism(world, {
        xPos: center.xPos + Math.trunc(Math.cos(angle) * distance),
        yPos: center.yPos + Math.trunc(Math.sin(angle) * distance),
      });
      return look(world, observer) === target ? 1 : 0;
    };

    expect(sees(undefined)).toBe(0);
    expect(sees(Q)).toBe(1);
  });

  it("prefers the closer candidate", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, { ...center, angle: 0 });
    const far = spawnTestOrganism(world, { xPos: center.xPos + 30 * POS_SCALE, yPos: center.yPos });
    const near = spawnTestOrganism(world, {
      xPos: center.xPos + 10 * POS_SCALE,
      yPos: center.yPos,
    });
    expect(far).toBeLessThan(near); // the far one was allocated first
    expect(look(world, observer)).toBe(near);
  });

  it("breaks an exact distance tie on the lower entity ID, not on slot order", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, { ...center, angle: 0 });
    const offset = 10 * POS_SCALE;
    // Two candidates equidistant ahead, mirrored across the heading.
    const first = spawnTestOrganism(world, { xPos: center.xPos + offset, yPos: center.yPos - 4 });
    const second = spawnTestOrganism(world, { xPos: center.xPos + offset, yPos: center.yPos + 4 });

    const firstId = world.organisms.entityId[first] as number;
    const secondId = world.organisms.entityId[second] as number;
    expect(firstId).toBeLessThan(secondId);
    expect(look(world, observer)).toBe(first);

    // Swap the IDs and the winner swaps with them: the tie-break is on
    // identity, not on which slot the grid happened to visit first.
    world.organisms.entityId[first] = secondId;
    world.organisms.entityId[second] = firstId;
    expect(look(world, observer)).toBe(second);
  });

  it("ignores organisms whose slot was released", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, { ...center, angle: 0 });
    const target = spawnTestOrganism(world, {
      xPos: center.xPos + 10 * POS_SCALE,
      yPos: center.yPos,
    });
    expect(look(world, observer)).toBe(target);
    world.organisms.releaseSlot(target);
    expect(look(world, observer)).toBe(-1);
  });
});

describe("crowding", () => {
  it("counts neighbours inside the radius and excludes the observer", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const observer = spawnTestOrganism(world, center);
    world.ctx.spatialPre.rebuild(world.organisms);
    expect(countCrowding(world.ctx, observer)).toBe(0);

    const radiusPos = world.config.senses.crowdingRadiusLU * POS_SCALE;
    for (let i = 0; i < 3; i += 1) {
      spawnTestOrganism(world, { xPos: center.xPos + radiusPos - 100, yPos: center.yPos });
    }
    // One just outside the radius must not count.
    spawnTestOrganism(world, { xPos: center.xPos + radiusPos + 100, yPos: center.yPos });

    world.ctx.spatialPre.rebuild(world.organisms);
    expect(countCrowding(world.ctx, observer)).toBe(3);
  });

  it("is symmetric between two neighbours", () => {
    const world = createTestWorld();
    const center = world.cellCenter(10, 10);
    const a = spawnTestOrganism(world, center);
    const b = spawnTestOrganism(world, { xPos: center.xPos + 512, yPos: center.yPos });
    world.ctx.spatialPre.rebuild(world.organisms);
    expect(countCrowding(world.ctx, a)).toBe(1);
    expect(countCrowding(world.ctx, b)).toBe(1);
  });
});
