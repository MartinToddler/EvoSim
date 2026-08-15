import { DEFAULT_CONFIG, ENGINE_VERSION, SimulationEngine, cloneConfig } from "@eon/engine";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { HEADER_BYTES, encodeDurableSnapshot } from "./durableSnapshot";
import { WorldStore } from "./WorldStore";
import type { IndexedDbFactoryLike } from "./db";

/**
 * Independent storage-layer probes (A19 review).
 *
 * The shipped `WorldStore.test.ts` proves the happy paths and the headline
 * durability claims. These are the cases a review adds on top: what the
 * *manifest* says after something went wrong, and whether a connection that
 * another tab closed can still be used.
 */

let indexedDb: IndexedDbFactoryLike;
let ids = 0;

function newStore(): WorldStore {
  return new WorldStore({
    indexedDb,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++ids)).toISOString(),
    newId: () => `id-${++ids}`,
  });
}

/** A tiny but real world, so the bytes under test are real bytes. */
function bytesAt(tick: number): Uint8Array {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = 32;
  config.world.sizeLU = 32 * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = 4;
  config.world.initialOrganisms = 8;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = 64;
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 64,
  );
  const engine = new SimulationEngine({ seed: 7, config });
  engine.stepMany(tick);
  return encodeDurableSnapshot({
    snapshot: engine.serialize(),
    stateHash: engine.computeStateHash(),
    configHash: engine.configHash,
  });
}

function request(overrides: { worldId?: string; tick?: number; kind?: "manual" | "autosave" }) {
  return {
    ...(overrides.worldId === undefined ? {} : { worldId: overrides.worldId }),
    worldName: "Probe",
    kind: overrides.kind ?? ("manual" as const),
    bytes: bytesAt(overrides.tick ?? 0),
    appVersion: "review",
    configSchemaVersion: 1,
  };
}

/** Corrupt a stored payload in place, leaving the metadata row untouched. */
async function damage(snapshotId: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDb.open("eon-worlds-v1");
    open.onsuccess = (): void => {
      resolve(open.result);
    };
    open.onerror = (): void => {
      reject(new Error("open failed"));
    };
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("snapshotBlobs", "readwrite");
    const blobs = transaction.objectStore("snapshotBlobs");
    const read = blobs.get(snapshotId);
    read.onsuccess = (): void => {
      const row = read.result as { snapshotId: string; bytes: ArrayBuffer };
      const bytes = new Uint8Array(row.bytes);
      bytes[HEADER_BYTES + 64] = (bytes[HEADER_BYTES + 64] as number) ^ 0xff;
      blobs.put({ ...row, bytes: bytes.buffer });
    };
    transaction.oncomplete = (): void => {
      database.close();
      resolve();
    };
    transaction.onerror = (): void => {
      reject(new Error("damage failed"));
    };
  });
}

beforeEach(() => {
  indexedDb = new IDBFactory();
  ids = 0;
});

describe("manifest truthfulness after a fallback load", () => {
  it("stops advertising a save that could not be read", async () => {
    const store = newStore();
    const first = await store.save(request({ tick: 0 }));
    const worldId = first.manifest.worldId;
    const newest = await store.save(request({ worldId, tick: 60 }));
    await damage(newest.save.snapshotId);

    const loaded = await store.load(worldId);
    expect(loaded.decoded.snapshot.tick).toBe(0);
    expect(loaded.rejected).toHaveLength(1);

    // The world list reads the manifest. After a fallback it must describe the
    // save the user can actually open, and say that something is wrong —
    // otherwise the panel keeps promising tick 60 while Load delivers tick 0,
    // and the state hash it shows belongs to a save nobody can read.
    const manifest = await store.getManifest(worldId);
    expect(manifest?.latestSnapshotId).toBe(first.save.snapshotId);
    expect(manifest?.latestTick).toBe(0);
    expect(manifest?.latestStateHash).toBe(first.save.stateHash);
    expect(manifest?.status).toBe("corrupt");
    expect(manifest?.statusDetail).toMatch(/checksum/);

    // And nothing was deleted to achieve that (docs/06 §27).
    const [world] = await store.listWorlds();
    expect(world?.saves).toHaveLength(2);
    store.close();
  });

  it("clears the warning once a good save is written again", async () => {
    const store = newStore();
    const created = await store.save(request({ tick: 0 }));
    const worldId = created.manifest.worldId;
    const newest = await store.save(request({ worldId, tick: 60 }));
    await damage(newest.save.snapshotId);
    await store.load(worldId);
    expect((await store.getManifest(worldId))?.status).toBe("corrupt");

    const healthy = await store.save(request({ worldId, tick: 90 }));
    const manifest = await store.getManifest(worldId);
    expect(manifest?.status).toBe("ok");
    expect(manifest?.statusDetail).toBe("");
    expect(manifest?.latestSnapshotId).toBe(healthy.save.snapshotId);
    store.close();
  });
});

describe("load follows the manifest, not the highest tick", () => {
  it("opens the save the manifest points at", async () => {
    // Today every save advances the tick, so the two orders agree. They stop
    // agreeing the moment a world is restored from an older save and saved
    // again (Milestone 11's rewind and branch do exactly that), and "Load"
    // must mean "the save this world is currently on", which is what the
    // manifest records and what the panel displays.
    const store = newStore();
    const created = await store.save(request({ tick: 90 }));
    const worldId = created.manifest.worldId;
    const older = await store.save(request({ worldId, tick: 30 }));

    const manifest = await store.getManifest(worldId);
    expect(manifest?.latestSnapshotId).toBe(older.save.snapshotId);
    expect(manifest?.latestTick).toBe(30);

    const loaded = await store.load(worldId);
    expect(loaded.save.snapshotId).toBe(older.save.snapshotId);
    expect(loaded.decoded.snapshot.tick).toBe(30);
    store.close();
  });
});

describe("another tab upgrading the schema", () => {
  it("drops the dead handle and reports a version problem, not a broken store", async () => {
    const store = newStore();
    const created = await store.save(request({ tick: 0 }));

    // A newer build in another tab upgrades the schema. The store's connection
    // receives `versionchange` and closes; every later call on that handle
    // would otherwise throw InvalidStateError — an opaque failure that says
    // nothing about what happened or what to do.
    await new Promise<void>((resolve) => {
      const upgrade = indexedDb.open("eon-worlds-v1", 2);
      upgrade.onsuccess = (): void => {
        upgrade.result.close();
        resolve();
      };
      upgrade.onblocked = (): void => {
        resolve();
      };
      upgrade.onerror = (): void => {
        resolve();
      };
    });

    await expect(store.listWorlds()).rejects.toMatchObject({
      kind: "version",
      message: expect.stringContaining("reload") as unknown as string,
    });
    expect(created.manifest.worldId).toBeTruthy();
    store.close();
  });
});

describe("header fields that are fixed-width by construction (A19 review)", () => {
  it("refuses, loudly, to write an engine version that does not fit", () => {
    // The header gives the engine version 16 ASCII bytes. A future
    // `0.10.0-rc.1+build.20260815` would not fit, and the one thing that must
    // never happen is a silently truncated version — two different engines
    // would then claim the same identity and a save from one would load into
    // the other. Failing at save time, before anything is stored, is the
    // correct behaviour; this pins it.
    const engine = new SimulationEngine({ seed: 1, config: cloneConfig(DEFAULT_CONFIG) });
    const snapshot = engine.serialize();
    expect(() =>
      encodeDurableSnapshot({
        snapshot: { ...snapshot, engineVersion: "0.10.0-rc.1+build.20260815" },
        stateHash: engine.computeStateHash(),
        configHash: engine.configHash,
      }),
    ).toThrow(/does not fit/);
  });

  it("refuses a non-ASCII version rather than mangling it", () => {
    const engine = new SimulationEngine({ seed: 1, config: cloneConfig(DEFAULT_CONFIG) });
    const snapshot = engine.serialize();
    expect(() =>
      encodeDurableSnapshot({
        snapshot: { ...snapshot, engineVersion: "0.7.0-π" },
        stateHash: engine.computeStateHash(),
        configHash: engine.configHash,
      }),
    ).toThrow(/ASCII/);
  });

  it("keeps the current engine version comfortably inside the field", () => {
    expect(ENGINE_VERSION.length).toBeLessThanOrEqual(16);
  });
});
