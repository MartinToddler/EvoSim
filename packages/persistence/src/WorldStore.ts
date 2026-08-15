/**
 * The saved-world repository (tasks K01/K02/K04/K05).
 *
 * Everything above this class talks about worlds and saves; everything below it
 * is IndexedDB. It decides no simulation rules — it never inspects a payload
 * beyond its header, and it never changes one.
 *
 * ## The durability rule
 *
 * A failed or interrupted save must leave the previous save exactly as it was.
 * Three things enforce that:
 *
 * 1. **One transaction per save.** The snapshot row, the pruning and the
 *    manifest update are a single `readwrite` transaction over both stores. It
 *    commits completely or aborts completely; a save killed halfway leaves the
 *    database on its previous state, with the previous manifest still pointing
 *    at the previous snapshot.
 * 2. **Add before remove.** The new snapshot row is written *before* old ones
 *    are pruned, and the pruner refuses to touch the row a manifest points at
 *    or any manual save. There is no instant, even inside the transaction,
 *    where the newest good save has been dropped in favour of one not yet
 *    written.
 * 3. **A queue, not a race.** Autosave and a manual click can arrive
 *    together; both go through {@link #enqueue}, so they apply in order rather
 *    than interleaving two read-modify-write cycles of the same manifest.
 *
 * ## Loading never destroys
 *
 * A save that fails validation is *kept* (docs/06 §27). The world is marked
 * `corrupt` or `legacy` with the reason, older saves are tried in turn, and the
 * user is told which save actually opened. Deleting data because we could not
 * read it is the one thing a persistence layer must never do on its own.
 */

import {
  decodeDurableSnapshot,
  readSnapshotHeader,
  SnapshotFormatError,
  type DecodedDurableSnapshot,
  type DurableSnapshotHeader,
} from "./durableSnapshot";
import {
  openWorldDatabase,
  requestToPromise,
  transactionDone,
  type IndexedDbFactoryLike,
  SNAPSHOT_BLOB_STORE,
  SNAPSHOT_BY_WORLD,
  SNAPSHOT_STORE,
  WORLD_STORE,
} from "./db";
import { PersistenceError } from "./errors";
import type {
  SaveKind,
  SnapshotBlob,
  SnapshotRecord,
  SnapshotSummary,
  StoredWorld,
  WorldManifest,
} from "./manifests";

/** Every store a save touches, in one array so the transaction scope is exact. */
const SAVE_STORES = [WORLD_STORE, SNAPSHOT_STORE, SNAPSHOT_BLOB_STORE];

/** How many autosaves a world keeps. Manual saves are never auto-pruned. */
export const DEFAULT_AUTOSAVE_RETENTION = 5;

export interface WorldStoreOptions {
  /** IndexedDB factory; defaults to the ambient one. Tests inject a fake. */
  indexedDb?: IndexedDbFactoryLike;
  /**
   * Wall-clock source for record metadata, injectable so tests are not at the
   * mercy of the real clock. Never reaches the engine (see `manifests.ts`).
   */
  now?: () => string;
  /** Identifier source for new worlds and saves. */
  newId?: () => string;
  /** Autosaves kept per world. */
  autosaveRetention?: number;
}

/** What a caller must supply to record a save. */
export interface SaveWorldRequest {
  /** Omitted for the first save of a world; a new manifest is created. */
  worldId?: string;
  worldName: string;
  kind: SaveKind;
  /** The durable container from `encodeDurableSnapshot`. */
  bytes: Uint8Array;
  appVersion: string;
  configSchemaVersion: number;
}

export interface SaveWorldResult {
  manifest: WorldManifest;
  save: SnapshotSummary;
  /** Snapshot IDs pruned by retention during this save. */
  prunedSnapshotIds: readonly string[];
}

export interface LoadWorldResult {
  manifest: WorldManifest;
  save: SnapshotSummary;
  decoded: DecodedDurableSnapshot;
  /**
   * The raw container that produced {@link decoded}, freshly read from the
   * database. Callers that must hand the save to another thread transfer this
   * rather than re-encoding the decoded state — re-encoding would mean the
   * bytes the Worker validates are not the bytes that were stored.
   */
  bytes: ArrayBuffer;
  /**
   * Saves that were tried and refused before this one opened, newest first.
   * Non-empty means the world fell back to an older save, and the UI should
   * say so rather than pretend nothing happened.
   */
  rejected: readonly RejectedSave[];
}

export interface RejectedSave {
  snapshotId: string;
  tick: number;
  reason: string;
}

/**
 * Default identifier source.
 *
 * `crypto.randomUUID` is not a determinism violation: these IDs name rows in a
 * browser database, never simulation state. No authoritative value is derived
 * from them, and two worlds with identical IDs would still be identical worlds.
 * The engine's own randomness rules (CLAUDE.md) are about ticks, not filing.
 */
function defaultNewId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID !== undefined) {
    return cryptoApi.randomUUID();
  }
  // Environments without randomUUID (older WebViews, insecure origins) still
  // need unique keys; a monotonic counter plus the clock is enough for that.
  fallbackIdCounter += 1;
  return `w-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

let fallbackIdCounter = 0;

export class WorldStore {
  readonly #options: WorldStoreOptions;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #retention: number;
  #database: IDBDatabase | null = null;
  /** Tail of the serialized write queue; see the durability rule above. */
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: WorldStoreOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#newId = options.newId ?? defaultNewId;
    this.#retention = options.autosaveRetention ?? DEFAULT_AUTOSAVE_RETENTION;
    if (!Number.isInteger(this.#retention) || this.#retention < 1) {
      throw new PersistenceError(
        "io",
        `autosaveRetention must be a positive integer, got ${String(options.autosaveRetention)}`,
      );
    }
  }

  /** Open the database, reusing the connection across calls. */
  async #open(): Promise<IDBDatabase> {
    if (this.#closed) {
      throw new PersistenceError("io", "this WorldStore has been closed");
    }
    if (this.#database === null) {
      this.#database = await openWorldDatabase(this.#options.indexedDb, () => {
        // Another tab upgraded the schema, or the browser closed us. Drop the
        // handle so the next call opens a fresh connection instead of throwing
        // InvalidStateError on a dead one for the rest of the session.
        this.#database = null;
      });
    }
    return this.#database;
  }

  /**
   * Run `work` after every operation queued before it.
   *
   * The queue is what turns "autosave fired while the user clicked Save" from a
   * race into an order. A failure does not poison the chain: the next caller
   * still runs, and only its own promise rejects.
   */
  async #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  /** Close the connection. Queued work already running is not interrupted. */
  close(): void {
    this.#closed = true;
    this.#database?.close();
    this.#database = null;
  }

  /** Every stored world with its saves, newest save first. */
  async listWorlds(): Promise<StoredWorld[]> {
    const database = await this.#open();
    const transaction = database.transaction([WORLD_STORE, SNAPSHOT_STORE], "readonly");
    const manifests = await requestToPromise(
      transaction.objectStore(WORLD_STORE).getAll() as IDBRequest<WorldManifest[]>,
      "listing worlds",
    );
    // Metadata rows only: the payloads stay in `snapshotBlobs`, untouched.
    const saves = await requestToPromise(
      transaction.objectStore(SNAPSHOT_STORE).getAll() as IDBRequest<SnapshotRecord[]>,
      "listing saves",
    );

    const byWorld = new Map<string, SnapshotSummary[]>();
    for (const record of saves) {
      const list = byWorld.get(record.worldId) ?? [];
      list.push(record);
      byWorld.set(record.worldId, list);
    }
    const worlds = manifests.map((manifest) => ({
      manifest,
      saves: (byWorld.get(manifest.worldId) ?? []).sort(compareSavesNewestFirst),
    }));
    // Most recently touched first; worldId breaks ties so a list never
    // reshuffles between two renders.
    worlds.sort((a, b) => {
      const byTime = b.manifest.lastOpenedAtIso.localeCompare(a.manifest.lastOpenedAtIso);
      return byTime !== 0 ? byTime : a.manifest.worldId.localeCompare(b.manifest.worldId);
    });
    return worlds;
  }

  /** One world's manifest, or `null` when it is not stored. */
  async getManifest(worldId: string): Promise<WorldManifest | null> {
    const database = await this.#open();
    const transaction = database.transaction(WORLD_STORE, "readonly");
    const manifest = await requestToPromise(
      transaction.objectStore(WORLD_STORE).get(worldId) as IDBRequest<WorldManifest | undefined>,
      "reading a world manifest",
    );
    return manifest ?? null;
  }

  /**
   * Record a save: one snapshot row, retention, and the manifest, atomically.
   *
   * The header is parsed *before* the transaction opens. A malformed container
   * is then rejected without a database write having happened at all, which is
   * the cheapest possible way to keep a bad save from touching a good one.
   */
  async save(request: SaveWorldRequest): Promise<SaveWorldResult> {
    const header = readSnapshotHeader(request.bytes);
    return await this.#enqueue(async () => await this.#saveNow(request, header));
  }

  async #saveNow(
    request: SaveWorldRequest,
    header: DurableSnapshotHeader,
  ): Promise<SaveWorldResult> {
    const database = await this.#open();
    const transaction = database.transaction(SAVE_STORES, "readwrite");
    try {
      return await this.#writeSave(request, header, transaction);
    } catch (cause) {
      // All-or-nothing. Without this, a failure between "snapshot row written"
      // and "manifest updated" — a structured-clone rejection, a quota error,
      // anything thrown by our own code — could still commit the requests that
      // had already been queued, leaving a world whose manifest and rows
      // disagree. Aborting is what makes an interrupted save a no-op.
      abortQuietly(transaction);
      throw cause;
    }
  }

  async #writeSave(
    request: SaveWorldRequest,
    header: DurableSnapshotHeader,
    transaction: IDBTransaction,
  ): Promise<SaveWorldResult> {
    const timestamp = this.#now();
    const worldId = request.worldId ?? this.#newId();
    const snapshotId = this.#newId();

    const worlds = transaction.objectStore(WORLD_STORE);
    const snapshots = transaction.objectStore(SNAPSHOT_STORE);
    const blobs = transaction.objectStore(SNAPSHOT_BLOB_STORE);

    const existing = await requestToPromise(
      worlds.get(worldId) as IDBRequest<WorldManifest | undefined>,
      "reading a world manifest",
    );
    if (request.worldId !== undefined && existing === undefined) {
      throw new PersistenceError("not-found", `world ${worldId} is not stored`);
    }

    const record: SnapshotRecord = {
      snapshotId,
      worldId,
      tick: header.tick,
      kind: request.kind,
      savedAtIso: timestamp,
      engineVersion: header.engineVersion,
      snapshotSchemaVersion: header.schemaVersion,
      stateHash: header.stateHash,
      byteLength: request.bytes.byteLength,
    };
    const blob: SnapshotBlob = {
      snapshotId,
      // A detached copy: the caller's buffer may be a view into a larger
      // arena, and a stored save must never alias memory someone else writes.
      bytes: request.bytes.slice().buffer,
    };
    // Step 1: the new save exists — payload first, then the metadata that
    // advertises it — before anything old is considered for removal.
    blobs.put(blob);
    snapshots.put(record);

    // Step 2: retention, over this world's saves only.
    const worldSaves = await requestToPromise(
      snapshots.index(SNAPSHOT_BY_WORLD).getAll(worldId) as IDBRequest<SnapshotRecord[]>,
      "reading a world's saves",
    );
    const pruned = this.#pruneAutosaves(worldSaves, snapshotId);
    for (const id of pruned) {
      snapshots.delete(id);
      blobs.delete(id);
    }

    // Step 3: the manifest, last, pointing at a row that is already written.
    const manifest: WorldManifest = {
      worldId,
      worldName: request.worldName,
      createdAtIso: existing?.createdAtIso ?? timestamp,
      lastOpenedAtIso: timestamp,
      seed: header.seed,
      appVersion: request.appVersion,
      engineVersion: header.engineVersion,
      configSchemaVersion: request.configSchemaVersion,
      snapshotSchemaVersion: header.schemaVersion,
      latestTick: header.tick,
      latestSnapshotId: snapshotId,
      latestStateHash: header.stateHash,
      status: "ok",
      statusDetail: "",
    };
    worlds.put(manifest);

    await transactionDone(transaction, "saving a world");
    return { manifest, save: record, prunedSnapshotIds: pruned };
  }

  /**
   * Choose autosaves to drop, newest-first retention.
   *
   * Manual saves and the save just written are never candidates. The save the
   * *previous* manifest pointed at is a candidate like any other: this
   * transaction replaces that pointer, and because the pointer update and the
   * deletes commit together, there is no state — committed or rolled back — in
   * which a manifest names a row that is gone.
   */
  #pruneAutosaves(worldSaves: readonly SnapshotRecord[], justWrittenId: string): string[] {
    const autosaves = worldSaves
      .filter((save) => save.kind === "autosave" && save.snapshotId !== justWrittenId)
      .sort(compareSavesNewestFirst);
    // The new save occupies one slot of the budget when it is itself an
    // autosave, so `retention - 1` older ones stay beside it.
    const keep = Math.max(0, this.#retention - 1);
    return autosaves.slice(keep).map((save) => save.snapshotId);
  }

  /**
   * Load a world's newest usable save.
   *
   * Walks saves newest-first and returns the first that validates. Refusals
   * are collected, never deleted; when every save is refused the manifest is
   * marked with the newest failure's reason so the list can show it.
   */
  async load(worldId: string, snapshotId?: string): Promise<LoadWorldResult> {
    const database = await this.#open();
    const transaction = database.transaction(SAVE_STORES, "readonly");
    const manifest = await requestToPromise(
      transaction.objectStore(WORLD_STORE).get(worldId) as IDBRequest<WorldManifest | undefined>,
      "reading a world manifest",
    );
    if (manifest === undefined) {
      throw new PersistenceError("not-found", `world ${worldId} is not stored`);
    }
    const all = await requestToPromise(
      transaction
        .objectStore(SNAPSHOT_STORE)
        .index(SNAPSHOT_BY_WORLD)
        .getAll(worldId) as IDBRequest<SnapshotRecord[]>,
      "reading a world's saves",
    );

    // Order matters, and it is the manifest's order, not the clock's. The
    // manifest records which save this world is *on* — that is what the world
    // list displays and what "Load" means — so it is tried first, and the rest
    // follow newest-first as fallbacks. Today every save advances the tick and
    // the two orders agree; they stop agreeing the moment a world is restored
    // from an older save and saved again, which is precisely what rewind and
    // branch will do.
    const candidates =
      snapshotId === undefined
        ? orderByManifestThenNewest(all, manifest.latestSnapshotId)
        : all.filter((save) => save.snapshotId === snapshotId);
    if (candidates.length === 0) {
      throw new PersistenceError(
        "not-found",
        snapshotId === undefined
          ? `world ${worldId} has no saves`
          : `save ${snapshotId} is not stored`,
      );
    }

    const blobs = transaction.objectStore(SNAPSHOT_BLOB_STORE);
    const rejected: RejectedSave[] = [];
    for (const save of candidates) {
      const blob = await requestToPromise(
        blobs.get(save.snapshotId) as IDBRequest<SnapshotBlob | undefined>,
        "reading a save",
      );
      if (blob === undefined) {
        // Metadata without a payload: only reachable if something outside this
        // package edited the database. Treated as a damaged save, not a crash.
        rejected.push({
          snapshotId: save.snapshotId,
          tick: save.tick,
          reason: "the save's payload row is missing",
        });
        continue;
      }
      try {
        const decoded = decodeDurableSnapshot(new Uint8Array(blob.bytes));
        if (rejected.length > 0) {
          // Something newer than this save is unreadable. Leaving the manifest
          // pointed at it would keep the world list advertising a tick and a
          // state hash nobody can open, while Load quietly delivers this older
          // world instead. Repoint to what actually opened and say why. The
          // damaged save is kept (docs/06 §27) — only the pointer moves.
          const detail = `a newer save (tick ${rejected[0]?.tick ?? 0}) could not be read: ${
            rejected[0]?.reason ?? "unknown"
          }`;
          const repointed = await this.#repointManifest(
            worldId,
            save,
            rejected[0]?.reason.includes("engine") === true ? "legacy" : "corrupt",
            detail,
          );
          return { manifest: repointed ?? manifest, save, decoded, bytes: blob.bytes, rejected };
        }
        return { manifest, save, decoded, bytes: blob.bytes, rejected };
      } catch (cause) {
        if (!(cause instanceof SnapshotFormatError)) {
          throw cause;
        }
        rejected.push({ snapshotId: save.snapshotId, tick: save.tick, reason: cause.message });
      }
    }

    const worst = rejected[0] as RejectedSave;
    const status = worst.reason.includes("engine") ? "legacy" : "corrupt";
    await this.markStatus(worldId, status, worst.reason);
    throw new PersistenceError(
      "corrupt",
      `no usable save for world ${worldId}: ${rejected.map((entry) => `tick ${entry.tick} — ${entry.reason}`).join("; ")}`,
    );
  }

  /**
   * Point a manifest at the save that actually loaded and record why.
   *
   * Returns the stored manifest, or `null` when a save landed while the load
   * was reading: that save is newer than anything this load saw, so it owns the
   * pointer and this repoint must not overwrite it.
   */
  async #repointManifest(
    worldId: string,
    save: SnapshotSummary,
    status: WorldManifest["status"],
    detail: string,
  ): Promise<WorldManifest | null> {
    return await this.#enqueue(async () => {
      const database = await this.#open();
      const transaction = database.transaction(WORLD_STORE, "readwrite");
      const worlds = transaction.objectStore(WORLD_STORE);
      const current = await requestToPromise(
        worlds.get(worldId) as IDBRequest<WorldManifest | undefined>,
        "reading a world manifest",
      );
      if (current === undefined || current.latestSnapshotId === save.snapshotId) {
        abortQuietly(transaction);
        return current ?? null;
      }
      const updated: WorldManifest = {
        ...current,
        latestSnapshotId: save.snapshotId,
        latestTick: save.tick,
        latestStateHash: save.stateHash,
        status,
        statusDetail: detail,
      };
      worlds.put(updated);
      await transactionDone(transaction, "updating a world manifest");
      return updated;
    });
  }

  /** Record a world's health without touching its saves. */
  async markStatus(
    worldId: string,
    status: WorldManifest["status"],
    detail: string,
  ): Promise<void> {
    await this.#enqueue(async () => {
      const database = await this.#open();
      const transaction = database.transaction(WORLD_STORE, "readwrite");
      const worlds = transaction.objectStore(WORLD_STORE);
      const manifest = await requestToPromise(
        worlds.get(worldId) as IDBRequest<WorldManifest | undefined>,
        "reading a world manifest",
      );
      if (manifest === undefined) {
        abortQuietly(transaction);
        throw new PersistenceError("not-found", `world ${worldId} is not stored`);
      }
      worlds.put({ ...manifest, status, statusDetail: detail });
      await transactionDone(transaction, "updating a world's status");
    });
  }

  /** Stamp a world as opened now (list ordering only). */
  async touch(worldId: string): Promise<void> {
    await this.#enqueue(async () => {
      const database = await this.#open();
      const transaction = database.transaction(WORLD_STORE, "readwrite");
      const worlds = transaction.objectStore(WORLD_STORE);
      const manifest = await requestToPromise(
        worlds.get(worldId) as IDBRequest<WorldManifest | undefined>,
        "reading a world manifest",
      );
      if (manifest === undefined) {
        abortQuietly(transaction);
        throw new PersistenceError("not-found", `world ${worldId} is not stored`);
      }
      worlds.put({ ...manifest, lastOpenedAtIso: this.#now() });
      await transactionDone(transaction, "touching a world");
    });
  }

  /** Delete a world and every save behind it. Explicit user action only. */
  async deleteWorld(worldId: string): Promise<void> {
    await this.#enqueue(async () => {
      const database = await this.#open();
      const transaction = database.transaction(SAVE_STORES, "readwrite");
      const snapshots = transaction.objectStore(SNAPSHOT_STORE);
      const blobs = transaction.objectStore(SNAPSHOT_BLOB_STORE);
      const keys = await requestToPromise(
        snapshots.index(SNAPSHOT_BY_WORLD).getAllKeys(worldId),
        "reading a world's saves",
      );
      for (const key of keys) {
        snapshots.delete(key);
        blobs.delete(key);
      }
      transaction.objectStore(WORLD_STORE).delete(worldId);
      await transactionDone(transaction, "deleting a world");
    });
  }
}

/**
 * The manifest's save first, then everything else newest-first.
 *
 * A missing pointer (a manifest written before this ordering existed, or one
 * whose save was pruned) simply degrades to newest-first.
 */
function orderByManifestThenNewest(
  saves: readonly SnapshotRecord[],
  latestSnapshotId: string,
): SnapshotRecord[] {
  const ordered = [...saves].sort(compareSavesNewestFirst);
  const pointed = ordered.findIndex((save) => save.snapshotId === latestSnapshotId);
  if (pointed <= 0) {
    return ordered;
  }
  const [current] = ordered.splice(pointed, 1);
  return current === undefined ? ordered : [current, ...ordered];
}

/** Newest first: by tick, then by save time, then by id for stability. */
function compareSavesNewestFirst(a: SnapshotRecord, b: SnapshotRecord): number {
  if (a.tick !== b.tick) {
    return b.tick - a.tick;
  }
  const byTime = b.savedAtIso.localeCompare(a.savedAtIso);
  return byTime !== 0 ? byTime : a.snapshotId.localeCompare(b.snapshotId);
}

/**
 * Abort a transaction without letting the abort itself become the error the
 * caller sees. A transaction that already finished throws `InvalidStateError`
 * here, and that must not replace the real failure being propagated.
 */
function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Already committed, already aborted, or the connection is gone.
  }
}
