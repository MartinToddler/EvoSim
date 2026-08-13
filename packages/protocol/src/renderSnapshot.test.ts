import { describe, expect, it } from "vitest";
import {
  RENDER_HEADER_FIELDS,
  RENDER_SNAPSHOT_LAYOUT_VERSION,
  RENDER_SNAPSHOT_MAGIC,
  RenderBufferPool,
  RenderFlag,
  RenderHeader,
  RenderSnapshotFormatError,
  computeRenderSnapshotLayout,
  createRenderSnapshotBuffer,
  readRenderSnapshotCounts,
  viewRenderSnapshot,
} from "./renderSnapshot";

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

describe("render snapshot layout", () => {
  it("gives every section an offset aligned to its element size", () => {
    // Odd capacities on purpose: powers of two would hide a missing alignment.
    const layout = computeRenderSnapshotLayout(101, 37);
    expect(layout.organismId % 4).toBe(0);
    expect(layout.organismX % 4).toBe(0);
    expect(layout.organismRotation % 4).toBe(0);
    expect(layout.organismSpeciesId % 4).toBe(0);
    expect(layout.organismHueDeg % 2).toBe(0);
    expect(layout.organismFlags % 2).toBe(0);
    expect(layout.carcassId % 4).toBe(0);
    expect(layout.carcassRadiusLU % 4).toBe(0);
  });

  it("builds views for capacities that are not powers of two", () => {
    const buffer = createRenderSnapshotBuffer(101, 37);
    const view = viewRenderSnapshot(buffer);
    expect(view.organismId.length).toBe(101);
    expect(view.carcassX.length).toBe(37);
  });

  it("sections never overlap", () => {
    const organisms = 64;
    const carcasses = 16;
    const buffer = createRenderSnapshotBuffer(organisms, carcasses);
    const view = viewRenderSnapshot(buffer);

    // Writing a distinct sentinel into every column and reading them all back
    // is the direct test that no two views alias the same bytes.
    view.organismId.fill(0xaaaa_aaaa);
    view.organismX.fill(1.5);
    view.organismY.fill(-2.5);
    view.organismRotation.fill(3);
    view.organismRadiusLU.fill(0.25);
    view.organismSpeciesId.fill(7);
    view.organismHueDeg.fill(359);
    view.organismFlags.fill(RenderFlag.Juvenile | RenderFlag.Injured);
    view.organismHealth.fill(200);
    view.organismEnergy.fill(100);
    view.organismDiet.fill(-120);
    view.organismSpeed.fill(250);
    view.carcassId.fill(0xbbbb_bbbb);
    view.carcassX.fill(9);
    view.carcassY.fill(-9);
    view.carcassRadiusLU.fill(0.75);

    expect(view.organismId[0]).toBe(0xaaaa_aaaa);
    expect(view.organismX[63]).toBe(1.5);
    expect(view.organismY[0]).toBe(-2.5);
    expect(view.organismRotation[10]).toBe(3);
    expect(view.organismRadiusLU[10]).toBe(0.25);
    expect(view.organismSpeciesId[63]).toBe(7);
    expect(view.organismHueDeg[63]).toBe(359);
    expect(view.organismFlags[0]).toBe(RenderFlag.Juvenile | RenderFlag.Injured);
    expect(view.organismHealth[63]).toBe(200);
    expect(view.organismEnergy[63]).toBe(100);
    expect(view.organismDiet[0]).toBe(-120);
    expect(view.organismSpeed[63]).toBe(250);
    expect(view.carcassId[15]).toBe(0xbbbb_bbbb);
    expect(view.carcassX[15]).toBe(9);
    expect(view.carcassY[0]).toBe(-9);
    expect(view.carcassRadiusLU[15]).toBe(0.75);
  });

  it("stamps a self-describing header", () => {
    const view = viewRenderSnapshot(createRenderSnapshotBuffer(8, 4));
    expect(view.header.length).toBe(RENDER_HEADER_FIELDS);
    expect(view.header[RenderHeader.Magic]).toBe(RENDER_SNAPSHOT_MAGIC);
    expect(view.header[RenderHeader.LayoutVersion]).toBe(RENDER_SNAPSHOT_LAYOUT_VERSION);
    expect(view.header[RenderHeader.OrganismCapacity]).toBe(8);
    expect(view.header[RenderHeader.CarcassCapacity]).toBe(4);
  });

  it("carries a tick beyond uint32 exactly", () => {
    // Ticks are safe integers, not uint32 (the engine fixed that in 0.1.1). A
    // Float64 header slot keeps a 2^40 tick exact instead of wrapping it.
    const view = viewRenderSnapshot(createRenderSnapshotBuffer(4, 2));
    const bigTick = 1_099_511_627_777;
    view.header[RenderHeader.Tick] = bigTick;
    expect(readRenderSnapshotCounts(view).tick).toBe(bigTick);
  });

  it("rejects a foreign buffer", () => {
    expect(() => viewRenderSnapshot(new ArrayBuffer(1024))).toThrowError(RenderSnapshotFormatError);
  });

  it("rejects a buffer too small for a header", () => {
    expect(() => viewRenderSnapshot(new ArrayBuffer(8))).toThrowError(RenderSnapshotFormatError);
  });

  it("rejects a buffer whose size disagrees with its own header", () => {
    const good = createRenderSnapshotBuffer(8, 4);
    const truncated = good.slice(0, good.byteLength - 4);
    expect(() => viewRenderSnapshot(truncated)).toThrowError(/but its header describes/);
  });

  it("rejects nonsensical capacities", () => {
    expect(() => createRenderSnapshotBuffer(0, 4)).toThrowError(RenderSnapshotFormatError);
    expect(() => createRenderSnapshotBuffer(8, -1)).toThrowError(RenderSnapshotFormatError);
    expect(() => createRenderSnapshotBuffer(1.5, 4)).toThrowError(RenderSnapshotFormatError);
  });
});

describe("RenderBufferPool", () => {
  it("recycles the same buffers instead of allocating per snapshot", () => {
    const pool = new RenderBufferPool(16, 8, 3);
    const first = pool.acquire();
    expect(first).not.toBeNull();
    pool.release(first as ArrayBuffer);
    const second = pool.acquire();
    expect(second).toBe(first);
    expect(pool.created).toBe(1);
  });

  it("grows only up to its cap, then drops snapshots", () => {
    const pool = new RenderBufferPool(16, 8, 2);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(pool.created).toBe(2);
    expect(pool.inFlight).toBe(2);

    // Nothing left: this is back-pressure, and dropping the snapshot is the
    // correct answer. Ticks are never dropped; pictures are.
    expect(pool.acquire()).toBeNull();
    expect(pool.droppedSnapshots).toBe(1);
    expect(pool.created).toBe(2);
  });

  it("recovers after the consumer returns a buffer", () => {
    const pool = new RenderBufferPool(16, 8, 2);
    const a = pool.acquire() as ArrayBuffer;
    pool.acquire();
    expect(pool.acquire()).toBeNull();
    pool.release(a);
    expect(pool.acquire()).toBe(a);
  });

  it("refuses a detached buffer rather than pooling a zero-length one", () => {
    const pool = new RenderBufferPool(16, 8, 3);
    const buffer = pool.acquire() as ArrayBuffer;
    // structuredClone with a transfer detaches the original, exactly as
    // postMessage does.
    structuredClone(buffer, { transfer: [buffer] });
    expect(buffer.byteLength).toBe(0);
    expect(pool.release(buffer)).toBe(false);
    // The slot is freed for a replacement, so a detached buffer costs one
    // allocation rather than permanently shrinking the pool.
    expect(pool.acquire()).not.toBeNull();
  });

  it("refuses a buffer belonging to a different world shape", () => {
    const pool = new RenderBufferPool(16, 8, 3);
    expect(pool.release(createRenderSnapshotBuffer(32, 8))).toBe(false);
  });

  it("refuses a buffer that is not a render snapshot at all", () => {
    const pool = new RenderBufferPool(16, 8, 3);
    expect(pool.release(new ArrayBuffer(64))).toBe(false);
  });

  it("requires at least one buffer", () => {
    expect(() => new RenderBufferPool(16, 8, 0)).toThrowError(RenderSnapshotFormatError);
  });
});
