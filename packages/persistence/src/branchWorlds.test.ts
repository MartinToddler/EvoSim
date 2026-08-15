import { DEFAULT_CONFIG, SimulationEngine, prepareBranchSnapshot } from "@eon/engine";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { IndexedDbFactoryLike } from "./db";
import { encodeDurableSnapshot } from "./durableSnapshot";
import { PersistenceError } from "./errors";
import { selectSaveForTick, worldOriginTick, type SnapshotSummary } from "./manifests";
import { WorldStore, type SaveWorldRequest } from "./WorldStore";

/**
 * Branch worlds in storage (tasks K10, K02).
 *
 * The storage half of branching: a branch is a NEW world with its own manifest,
 * its own saves and its own future, carrying only a record of where it came
 * from. The engine half — that the state it starts from is exactly the parent's
 * state at that tick — is proven in `@eon/engine`'s branch equivalence suite.
 */

const APP_VERSION = "test";
let indexedDb: IndexedDbFactoryLike;
let store: WorldStore;
let clockTicks = 0;
let idCounter = 0;

function fakeNow(): string {
  clockTicks += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, clockTicks)).toISOString();
}

function fakeId(): string {
  idCounter += 1;
  return `id-${idCounter.toString().padStart(4, "0")}`;
}

/** A world at `ticks`, plus the bytes that save it. Cached: generation is slow. */
const worldCache = new Map<number, { bytes: Uint8Array; hash: string }>();
function worldAt(ticks: number): { bytes: Uint8Array; hash: string } {
  const cached = worldCache.get(ticks);
  if (cached !== undefined) {
    return cached;
  }
  const engine = new SimulationEngine({ seed: 0xe0a12026, config: DEFAULT_CONFIG });
  engine.stepMany(ticks);
  const hash = engine.computeStateHash();
  const bytes = encodeDurableSnapshot({
    snapshot: engine.serialize(),
    stateHash: hash,
    configHash: engine.configHash,
  });
  const built = { bytes, hash };
  worldCache.set(ticks, built);
  return built;
}

/** Branch-origin bytes: the parent's state at `ticks`, minus its queued future. */
function branchBytes(ticks: number): Uint8Array {
  const engine = new SimulationEngine({ seed: 0xe0a12026, config: DEFAULT_CONFIG });
  engine.stepMany(ticks);
  const origin = prepareBranchSnapshot(engine.serialize(), ticks);
  const restored = SimulationEngine.fromSnapshot(origin);
  return encodeDurableSnapshot({
    snapshot: origin,
    stateHash: restored.computeStateHash(),
    configHash: restored.configHash,
  });
}

function saveRequest(overrides: Partial<SaveWorldRequest> & { ticks?: number } = {}) {
  const { ticks = 0, ...rest } = overrides;
  return {
    worldName: "Origin",
    kind: "manual" as const,
    bytes: worldAt(ticks).bytes,
    appVersion: APP_VERSION,
    configSchemaVersion: 1,
    ...rest,
  } satisfies SaveWorldRequest;
}

beforeEach(() => {
  indexedDb = new IDBFactory();
  store = new WorldStore({ indexedDb, now: fakeNow, newId: fakeId });
  clockTicks = 0;
  idCounter = 0;
});

describe("creating a branch world", () => {
  it("writes a new world that records where it diverged", async () => {
    const parent = await store.save(saveRequest({ ticks: 40 }));

    const branch = await store.save({
      worldName: "What if",
      kind: "branch",
      bytes: branchBytes(20),
      appVersion: APP_VERSION,
      configSchemaVersion: 1,
      branchedFrom: { parentWorldId: parent.manifest.worldId, branchTick: 20 },
    });

    expect(branch.manifest.worldId).not.toBe(parent.manifest.worldId);
    expect(branch.manifest.parentWorldId).toBe(parent.manifest.worldId);
    expect(branch.manifest.branchTick).toBe(20);
    expect(branch.manifest.latestTick).toBe(20);
    expect(branch.manifest.seed).toBe(parent.manifest.seed);
    expect(worldOriginTick(branch.manifest)).toBe(20);
    expect(worldOriginTick(parent.manifest)).toBe(0);
  });

  it("leaves the parent world exactly as it was", async () => {
    const parent = await store.save(saveRequest({ ticks: 40 }));
    const before = await store.listWorlds();
    const parentBefore = before.find((w) => w.manifest.worldId === parent.manifest.worldId);

    await store.save({
      worldName: "What if",
      kind: "branch",
      bytes: branchBytes(20),
      appVersion: APP_VERSION,
      configSchemaVersion: 1,
      branchedFrom: { parentWorldId: parent.manifest.worldId, branchTick: 20 },
    });

    const after = await store.listWorlds();
    const parentAfter = after.find((w) => w.manifest.worldId === parent.manifest.worldId);
    expect(parentAfter?.manifest).toEqual(parentBefore?.manifest);
    expect(parentAfter?.saves.map((s) => s.snapshotId)).toEqual(
      parentBefore?.saves.map((s) => s.snapshotId),
    );

    // And the parent still loads to the state it had.
    const loaded = await store.load(parent.manifest.worldId);
    expect(loaded.save.tick).toBe(40);
    expect(loaded.save.stateHash).toBe(worldAt(40).hash);
  });

  it("carries provenance forward through the branch's own later saves", async () => {
    const parent = await store.save(saveRequest({ ticks: 40 }));
    const branch = await store.save({
      worldName: "What if",
      kind: "branch",
      bytes: branchBytes(20),
      appVersion: APP_VERSION,
      configSchemaVersion: 1,
      branchedFrom: { parentWorldId: parent.manifest.worldId, branchTick: 20 },
    });

    const later = await store.save(
      saveRequest({ ticks: 40, worldId: branch.manifest.worldId, worldName: "What if" }),
    );

    expect(later.manifest.parentWorldId).toBe(parent.manifest.worldId);
    expect(later.manifest.branchTick).toBe(20);
    expect(later.manifest.latestTick).toBe(40);
  });

  it("refuses to write a branch origin over an existing world", async () => {
    const parent = await store.save(saveRequest({ ticks: 40 }));

    await expect(
      store.save({
        worldName: "Overwrite",
        kind: "branch",
        bytes: branchBytes(20),
        appVersion: APP_VERSION,
        configSchemaVersion: 1,
        worldId: parent.manifest.worldId,
        branchedFrom: { parentWorldId: parent.manifest.worldId, branchTick: 20 },
      }),
    ).rejects.toBeInstanceOf(PersistenceError);
  });

  it("refuses a branch point that disagrees with the save's own tick", async () => {
    const parent = await store.save(saveRequest({ ticks: 40 }));

    await expect(
      store.save({
        worldName: "Mismatched",
        kind: "branch",
        bytes: branchBytes(20),
        appVersion: APP_VERSION,
        configSchemaVersion: 1,
        branchedFrom: { parentWorldId: parent.manifest.worldId, branchTick: 25 },
      }),
    ).rejects.toThrow(/does not match the save's tick/);
  });

  it("never prunes a branch origin, however many autosaves follow it", async () => {
    const parent = await store.save(saveRequest({ ticks: 40 }));
    const branch = await store.save({
      worldName: "What if",
      kind: "branch",
      bytes: branchBytes(20),
      appVersion: APP_VERSION,
      configSchemaVersion: 1,
      branchedFrom: { parentWorldId: parent.manifest.worldId, branchTick: 20 },
    });

    for (const ticks of [20, 30, 40, 50, 60, 70, 80]) {
      await store.save(
        saveRequest({
          ticks,
          kind: "autosave",
          worldId: branch.manifest.worldId,
          worldName: "What if",
        }),
      );
    }

    const stored = (await store.listWorlds()).find(
      (w) => w.manifest.worldId === branch.manifest.worldId,
    );
    const origins = stored?.saves.filter((save) => save.kind === "branch") ?? [];
    expect(origins).toHaveLength(1);
    expect(origins[0]?.tick).toBe(20);
  });
});

describe("choosing the save a rewind replays from", () => {
  const save = (snapshotId: string, tick: number): SnapshotSummary =>
    ({ snapshotId, tick }) as SnapshotSummary;

  it("takes the newest save at or before the target", () => {
    const saves = [save("a", 0), save("b", 2500), save("c", 5000)];
    expect(selectSaveForTick(saves, 6000)?.snapshotId).toBe("c");
    expect(selectSaveForTick(saves, 5000)?.snapshotId).toBe("c");
    expect(selectSaveForTick(saves, 4999)?.snapshotId).toBe("b");
    expect(selectSaveForTick(saves, 0)?.snapshotId).toBe("a");
  });

  it("returns nothing when every save is later than the target", () => {
    expect(selectSaveForTick([save("late", 100)], 99)).toBeNull();
    expect(selectSaveForTick([], 10)).toBeNull();
  });

  it("breaks ties on the lowest id rather than on storage order", () => {
    const tied = [save("zzz", 500), save("aaa", 500)];
    expect(selectSaveForTick(tied, 800)?.snapshotId).toBe("aaa");
    expect(selectSaveForTick([...tied].reverse(), 800)?.snapshotId).toBe("aaa");
  });
});
