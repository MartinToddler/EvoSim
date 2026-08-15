import { describe, expect, it } from "vitest";
import {
  FieldHeader,
  FieldSnapshotFormatError,
  VegetationBufferPool,
  createTerrainBuffer,
  createVegetationBuffer,
  viewTerrainSnapshot,
  viewVegetationSnapshot,
} from "./terrainSnapshot";

/**
 * `structuredClone` is a platform global, and `@eon/protocol` deliberately
 * loads neither the DOM nor the Node type definitions — the package must stay
 * free of both (docs/02 §4). Declaring the one global these tests need keeps
 * that boundary intact instead of widening the package's lib for a test.
 *
 * It is used to detach a buffer exactly the way `postMessage` does, which is
 * the only way to test the detached-buffer path honestly.
 */
declare function structuredClone<T>(value: T, options?: { transfer?: ArrayBuffer[] }): T;

describe("terrain snapshot", () => {
  it("carries seven byte-per-cell fields that do not alias", () => {
    const view = viewTerrainSnapshot(createTerrainBuffer(8));
    expect(view.cellCount).toBe(64);
    view.biome.fill(3);
    view.elevation.fill(200);
    view.vegetation.fill(17);
    view.temperature.fill(99);
    view.moisture.fill(120);
    view.fertility.fill(45);
    view.capacity.fill(210);
    expect(view.biome[63]).toBe(3);
    expect(view.elevation[0]).toBe(200);
    expect(view.vegetation[32]).toBe(17);
    expect(view.temperature[1]).toBe(99);
    expect(view.moisture[62]).toBe(120);
    expect(view.fertility[7]).toBe(45);
    expect(view.capacity[40]).toBe(210);
    // Filling every later plane must not have bled into the first one.
    expect(view.biome[0]).toBe(3);
  });

  it("records the grid size so the consumer needs no side channel", () => {
    const view = viewTerrainSnapshot(createTerrainBuffer(256));
    expect(view.gridSize).toBe(256);
    expect(view.header[FieldHeader.CellCount]).toBe(65536);
  });

  it("refuses a vegetation buffer presented as terrain", () => {
    expect(() => viewTerrainSnapshot(createVegetationBuffer(8))).toThrowError(
      FieldSnapshotFormatError,
    );
  });

  it("refuses a truncated buffer", () => {
    const buffer = createTerrainBuffer(8);
    expect(() => viewTerrainSnapshot(buffer.slice(0, buffer.byteLength - 1))).toThrowError(
      /but its header describes/,
    );
  });

  it("refuses an impossible grid size", () => {
    expect(() => createTerrainBuffer(0)).toThrowError(FieldSnapshotFormatError);
    expect(() => createVegetationBuffer(-4)).toThrowError(FieldSnapshotFormatError);
  });
});

describe("vegetation snapshot", () => {
  it("carries one byte per cell and a tick", () => {
    const view = viewVegetationSnapshot(createVegetationBuffer(16));
    expect(view.vegetation.length).toBe(256);
    view.header[FieldHeader.Tick] = 12_345;
    expect(view.header[FieldHeader.Tick]).toBe(12_345);
  });

  it("refuses a terrain buffer presented as vegetation", () => {
    expect(() => viewVegetationSnapshot(createTerrainBuffer(8))).toThrowError(
      FieldSnapshotFormatError,
    );
  });
});

describe("VegetationBufferPool", () => {
  it("reuses buffers and drops updates under back-pressure", () => {
    const pool = new VegetationBufferPool(8, 1);
    const first = pool.acquire();
    expect(first).not.toBeNull();
    // A skipped vegetation update is invisible: the previous field stays on
    // screen until the next one lands.
    expect(pool.acquire()).toBeNull();
    expect(pool.droppedSnapshots).toBe(1);
    pool.release(first as ArrayBuffer);
    expect(pool.acquire()).toBe(first);
  });

  it("refuses a detached buffer", () => {
    const pool = new VegetationBufferPool(8, 2);
    const buffer = pool.acquire() as ArrayBuffer;
    structuredClone(buffer, { transfer: [buffer] });
    expect(pool.release(buffer)).toBe(false);
  });

  it("refuses a buffer for a different grid", () => {
    const pool = new VegetationBufferPool(8, 2);
    expect(pool.release(createVegetationBuffer(16))).toBe(false);
  });

  it("does not let foreign recycles erode the allocation ceiling", () => {
    const pool = new VegetationBufferPool(8, 2);
    for (let i = 0; i < 50; i += 1) {
      pool.release(new ArrayBuffer(32));
      pool.release(createVegetationBuffer(16));
    }
    expect(pool.created).toBe(pool.idle + pool.inFlight);
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).toBeNull();
  });
  it("refuses any release while nothing is in flight, even a same-grid buffer", () => {
    // Same invariant as RenderBufferPool: a release with nothing out cannot be
    // a return of ours, so adopting it would grow `idle` past `created`.
    const pool = new VegetationBufferPool(8, 2);
    expect(pool.release(createVegetationBuffer(8))).toBe(false);
    expect(pool.created).toBe(pool.idle + pool.inFlight);
    expect(pool.idle).toBe(1);
  });
});
