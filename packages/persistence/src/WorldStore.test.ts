import { DEFAULT_CONFIG, SimulationEngine } from "@eon/engine";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADER_BYTES, encodeDurableSnapshot } from "./durableSnapshot";
import { PersistenceError } from "./errors";
import { WorldStore, type SaveWorldRequest } from "./WorldStore";
import type { IndexedDbFactoryLike } from "./db";

/**
 * Storage-layer behaviour, against a real IndexedDB implementation
 * (`fake-indexeddb`) rather than a hand-written stub. Transaction atomicity,
 * index behaviour and the structured-clone of an ArrayBuffer are exactly the
 * things a stub would fake away, and they are what these tests are about.
 */

const APP_VERSION = "test";
let indexedDb: IndexedDbFactoryLike;
let store: WorldStore;
let clockTicks = 0;
let idCounter = 0;

/** Deterministic metadata: tests must not depend on the real clock. */
function fakeNow(): string {
  clockTicks += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, clockTicks)).toISOString();
}

function fakeId(): string {
  idCounter += 1;
  return `id-${idCounter.toString().padStart(4, "0")}`;
}

function newStore(retention?: number): WorldStore {
  return new WorldStore({
    indexedDb,
    now: fakeNow,
    newId: fakeId,
    ...(retention === undefined ? {} : { autosaveRetention: retention }),
  });
}

/** Bytes for a world at `ticks`. Cached: 10 world generations is 10× the cost. */
const bytesCache = new Map<number, Uint8Array>();
function worldBytes(ticks: number): Uint8Array {
  const cached = bytesCache.get(ticks);
  if (cached !== undefined) {
    return cached;
  }
  const engine = new SimulationEngine({ seed: 0xe0a12026, config: DEFAULT_CONFIG });
  engine.stepMany(ticks);
  const bytes = encodeDurableSnapshot({
    snapshot: engine.serialize(),
    stateHash: engine.computeStateHash(),
    configHash: engine.configHash,
  });
  bytesCache.set(ticks, bytes);
  return bytes;
}

function saveRequest(overrides: Partial<SaveWorldRequest> & { ticks?: number } = {}) {
  const { ticks = 0, ...rest } = overrides;
  return {
    worldName: "Test world",
    kind: "manual" as const,
    bytes: worldBytes(ticks),
    appVersion: APP_VERSION,
    configSchemaVersion: 1,
    ...rest,
  };
}

beforeEach(() => {
  indexedDb = new IDBFactory();
  store = newStore();
  clockTicks = 0;
  idCounter = 0;
});

afterEach(() => {
  store.close();
});

describe("saving and listing worlds", () => {
  it("creates a manifest from the snapshot header on first save", async () => {
    const bytes = worldBytes(20);
    const result = await store.save(saveRequest({ ticks: 20, worldName: "Eden" }));

    expect(result.manifest.worldName).toBe("Eden");
    expect(result.manifest.latestTick).toBe(20);
    expect(result.manifest.status).toBe("ok");
    expect(result.manifest.latestSnapshotId).toBe(result.save.snapshotId);
    expect(result.save.byteLength).toBe(bytes.byteLength);

    const worlds = await store.listWorlds();
    expect(worlds).toHaveLength(1);
    expect(worlds[0]?.saves).toHaveLength(1);
  });

  it("adds later saves to the same world and moves the pointer forward", async () => {
    const first = await store.save(saveRequest({ ticks: 0 }));
    const second = await store.save(
      saveRequest({ ticks: 40, worldId: first.manifest.worldId, kind: "autosave" }),
    );

    expect(second.manifest.worldId).toBe(first.manifest.worldId);
    expect(second.manifest.latestTick).toBe(40);
    expect(second.manifest.latestSnapshotId).toBe(second.save.snapshotId);
    expect(second.manifest.createdAtIso).toBe(first.manifest.createdAtIso);

    const [world] = await store.listWorlds();
    // Newest first.
    expect(world?.saves.map((save) => save.tick)).toEqual([40, 0]);
  });

  it("refuses to save into a world that is not stored", async () => {
    await expect(store.save(saveRequest({ worldId: "ghost" }))).rejects.toMatchObject({
      kind: "not-found",
    });
  });

  it("refuses bytes that are not a snapshot, without touching the database", async () => {
    const good = await store.save(saveRequest({ ticks: 0 }));
    await expect(
      store.save(
        saveRequest({ worldId: good.manifest.worldId, bytes: new Uint8Array(HEADER_BYTES + 4) }),
      ),
    ).rejects.toMatchObject({ code: "not-a-snapshot" });

    const [world] = await store.listWorlds();
    expect(world?.saves).toHaveLength(1);
    expect(world?.manifest.latestSnapshotId).toBe(good.save.snapshotId);
  });

  it("stores a detached copy of the caller's bytes", async () => {
    const source = worldBytes(10).slice();
    const saved = await store.save(saveRequest({ ticks: 10, bytes: source }));
    // Whatever the caller does with its buffer afterwards, the save must not
    // change underneath the database.
    source.fill(0);

    const loaded = await store.load(saved.manifest.worldId);
    expect(loaded.decoded.header.tick).toBe(10);
  });
});

describe("loading", () => {
  it("loads the newest save and returns the decoded snapshot", async () => {
    const created = await store.save(saveRequest({ ticks: 0 }));
    await store.save(saveRequest({ worldId: created.manifest.worldId, ticks: 60 }));

    const loaded = await store.load(created.manifest.worldId);
    expect(loaded.decoded.snapshot.tick).toBe(60);
    expect(loaded.rejected).toHaveLength(0);

    const engine = SimulationEngine.fromSnapshot(loaded.decoded.snapshot);
    expect(engine.computeStateHash()).toBe(loaded.decoded.header.stateHash);
  });

  it("loads a specific older save when asked", async () => {
    const created = await store.save(saveRequest({ ticks: 0 }));
    await store.save(saveRequest({ worldId: created.manifest.worldId, ticks: 60 }));

    const loaded = await store.load(created.manifest.worldId, created.save.snapshotId);
    expect(loaded.decoded.snapshot.tick).toBe(0);
  });

  it("falls back to an older save when the newest one is damaged", async () => {
    const created = await store.save(saveRequest({ ticks: 0 }));
    const newest = await store.save(saveRequest({ worldId: created.manifest.worldId, ticks: 60 }));
    await damageSnapshotPayload(indexedDb, newest.save.snapshotId);

    const loaded = await store.load(created.manifest.worldId);
    expect(loaded.decoded.snapshot.tick).toBe(0);
    expect(loaded.rejected).toHaveLength(1);
    expect(loaded.rejected[0]?.tick).toBe(60);
    expect(loaded.rejected[0]?.reason).toMatch(/checksum/);

    // The damaged save is kept, not deleted (docs/06 §27).
    const [world] = await store.listWorlds();
    expect(world?.saves).toHaveLength(2);
  });

  it("marks the world and keeps every save when none can be read", async () => {
    const created = await store.save(saveRequest({ ticks: 0 }));
    await damageSnapshotPayload(indexedDb, created.save.snapshotId);

    await expect(store.load(created.manifest.worldId)).rejects.toMatchObject({ kind: "corrupt" });

    const manifest = await store.getManifest(created.manifest.worldId);
    expect(manifest?.status).toBe("corrupt");
    expect(manifest?.statusDetail).toMatch(/checksum/);

    const [world] = await store.listWorlds();
    expect(world?.saves).toHaveLength(1);
  });

  it("reports a missing world rather than inventing an empty one", async () => {
    await expect(store.load("ghost")).rejects.toMatchObject({ kind: "not-found" });
  });
});

describe("durability", () => {
  it("keeps the previous save when a write fails mid-transaction", async () => {
    const created = await store.save(saveRequest({ ticks: 0 }));
    const good = created.save.snapshotId;

    // A save that fails while the transaction is open: the snapshot row was
    // already put, so an implementation without transactional atomicity would
    // leave a half-written world behind.
    const failing = newStore();
    await expect(
      failing.save(
        saveRequest({
          worldId: created.manifest.worldId,
          ticks: 60,
          // A value structured-clone cannot copy aborts the transaction at
          // commit time — the same shape as a quota failure or a browser kill.
          worldName: sabotage(),
        }),
      ),
    ).rejects.toBeInstanceOf(Error);
    failing.close();

    const manifest = await store.getManifest(created.manifest.worldId);
    expect(manifest?.latestSnapshotId).toBe(good);
    expect(manifest?.latestTick).toBe(0);

    // The aborted transaction left no orphan row behind either.
    const [world] = await store.listWorlds();
    expect(world?.saves).toHaveLength(1);

    const loaded = await store.load(created.manifest.worldId);
    expect(loaded.decoded.snapshot.tick).toBe(0);
  });

  it("serializes an autosave racing a manual save", async () => {
    const created = await store.save(saveRequest({ ticks: 0 }));
    const worldId = created.manifest.worldId;

    // Fired together, deliberately not awaited in order.
    const [autosave, manual] = await Promise.all([
      store.save(saveRequest({ worldId, ticks: 40, kind: "autosave" })),
      store.save(saveRequest({ worldId, ticks: 60, kind: "manual" })),
    ]);

    const manifest = await store.getManifest(worldId);
    // Whichever ran second owns the manifest; both saves exist, and the
    // manifest is consistent with exactly one of them rather than mixing the
    // tick of one with the snapshot id of the other.
    const winner = manifest?.latestSnapshotId === autosave.save.snapshotId ? autosave : manual;
    expect(manifest?.latestTick).toBe(winner.save.tick);
    expect(manifest?.latestStateHash).toBe(winner.save.stateHash);

    const [world] = await store.listWorlds();
    expect(world?.saves).toHaveLength(3);
  });

  it("survives a store being closed and reopened, as a page reload would", async () => {
    const created = await store.save(saveRequest({ ticks: 30, worldName: "Persisted" }));
    store.close();

    const reopened = newStore();
    const worlds = await reopened.listWorlds();
    expect(worlds[0]?.manifest.worldName).toBe("Persisted");
    const loaded = await reopened.load(created.manifest.worldId);
    expect(loaded.decoded.snapshot.tick).toBe(30);
    reopened.close();
  });
});

describe("retention", () => {
  it("prunes old autosaves but never manual saves", async () => {
    const keeping = newStore(3);
    const created = await keeping.save(saveRequest({ ticks: 0, kind: "manual" }));
    const worldId = created.manifest.worldId;

    for (const ticks of [10, 20, 30, 40, 50]) {
      await keeping.save(saveRequest({ worldId, ticks, kind: "autosave" }));
    }

    const worlds = await keeping.listWorlds();
    const saves = worlds[0]?.saves ?? [];
    const autosaves = saves.filter((save) => save.kind === "autosave");
    const manual = saves.filter((save) => save.kind === "manual");

    expect(autosaves).toHaveLength(3);
    expect(autosaves.map((save) => save.tick)).toEqual([50, 40, 30]);
    expect(manual.map((save) => save.tick)).toEqual([0]);
    keeping.close();
  });

  it("leaves the manifest pointing at a save that exists, even at retention 1", async () => {
    const keeping = newStore(1);
    const created = await keeping.save(saveRequest({ ticks: 0, kind: "autosave" }));
    const worldId = created.manifest.worldId;

    for (const ticks of [10, 20, 30]) {
      await keeping.save(saveRequest({ worldId, ticks, kind: "autosave" }));
    }

    const worlds = await keeping.listWorlds();
    const saves = worlds[0]?.saves ?? [];
    const manifest = worlds[0]?.manifest;
    expect(saves).toHaveLength(1);
    expect(saves[0]?.snapshotId).toBe(manifest?.latestSnapshotId);
    // And it is genuinely loadable: pruning never orphaned a pointer.
    const loaded = await keeping.load(worldId);
    expect(loaded.decoded.snapshot.tick).toBe(30);
    keeping.close();
  });
});

describe("deleting", () => {
  it("removes a world and all of its saves", async () => {
    const created = await store.save(saveRequest({ ticks: 0 }));
    await store.save(saveRequest({ worldId: created.manifest.worldId, ticks: 20 }));
    const other = await store.save(saveRequest({ ticks: 0, worldName: "Other" }));

    await store.deleteWorld(created.manifest.worldId);

    const worlds = await store.listWorlds();
    expect(worlds).toHaveLength(1);
    expect(worlds[0]?.manifest.worldId).toBe(other.manifest.worldId);
    expect(worlds[0]?.saves).toHaveLength(1);
    await expect(store.load(created.manifest.worldId)).rejects.toMatchObject({
      kind: "not-found",
    });
  });
});

describe("availability", () => {
  it("says so plainly when IndexedDB is missing", async () => {
    const none = new WorldStore({ now: fakeNow, newId: fakeId });
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
    try {
      await expect(none.listWorlds()).rejects.toBeInstanceOf(PersistenceError);
      await expect(none.listWorlds()).rejects.toMatchObject({ kind: "unavailable" });
    } finally {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "indexedDB");
      } else {
        Object.defineProperty(globalThis, "indexedDB", originalDescriptor);
      }
    }
  });
});

/**
 * Corrupt a stored save's payload in place, the way a bad sector or a
 * half-flushed write would: the record is still there and still readable, its
 * bytes just are not what they were.
 */
async function damageSnapshotPayload(
  factory: IndexedDbFactoryLike,
  snapshotId: string,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("eon-worlds-v1");
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(new Error(`could not open the world database: ${String(request.error?.name)}`));
    };
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("snapshotBlobs", "readwrite");
    const blobs = transaction.objectStore("snapshotBlobs");
    const read = blobs.get(snapshotId);
    read.onsuccess = (): void => {
      const record = read.result as { snapshotId: string; bytes: ArrayBuffer };
      const bytes = new Uint8Array(record.bytes);
      bytes[HEADER_BYTES + 32] = (bytes[HEADER_BYTES + 32] as number) ^ 0xff;
      blobs.put({ ...record, bytes: bytes.buffer });
    };
    transaction.oncomplete = (): void => {
      database.close();
      resolve();
    };
    transaction.onerror = (): void => {
      reject(new Error(`could not damage the save: ${String(transaction.error?.name)}`));
    };
  });
}

/** A value the structured clone algorithm refuses, to force a write failure. */
function sabotage(): string {
  return { toString: () => "unclonable" } as unknown as string;
}
