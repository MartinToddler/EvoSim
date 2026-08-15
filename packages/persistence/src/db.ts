/**
 * IndexedDB access for saved worlds (task K01, docs/06 §19).
 *
 * IndexedDB rather than localStorage because a world is megabytes of binary
 * state: localStorage is synchronous, string-only and capped around 5 MB, so it
 * would block the main thread to store a base64 inflation of data it cannot
 * hold anyway.
 *
 * This module owns the schema and the promise wrappers; nothing above it should
 * ever see an `IDBRequest`. It decides no simulation rules — it moves bytes.
 */

import { PersistenceError } from "./errors";

/** Database name. The `-v1` suffix versions the *concept*; see MIGRATIONS. */
export const DATABASE_NAME = "eon-worlds-v1";

/**
 * Schema version. Bump together with a new entry in `MIGRATIONS`.
 *
 * Version 1 creates:
 *
 * - `worlds`        — one manifest per saved world, keyed by `worldId`
 * - `snapshots`     — one metadata row per save, keyed by `snapshotId`,
 *                     indexed by `worldId` and by `[worldId, tick]`
 * - `snapshotBlobs` — the durable bytes, keyed by the same `snapshotId`
 *
 * Metadata and payload live apart on purpose. Listing worlds is the most
 * frequent read there is, and a combined row would make it pull every save's
 * multi-megabyte buffer through a structured clone just to show a tick number
 * and a date. Split, a listing reads kilobytes; only an actual load touches a
 * payload. The two rows are written and deleted in the same transaction, so
 * they cannot drift apart.
 *
 * The stores docs/06 §19 also anticipates (`commandChunks`, `events`, `stats`,
 * `preferences`) are deliberately NOT created empty here. A save currently
 * carries its command log, event log and statistics *inside* the snapshot
 * payload, so separate stores would be empty tables pretending to be a design.
 * They arrive with the milestone that chunks history out of the snapshot, as
 * migration 2 — which is exactly the case `MIGRATIONS` exists to make routine.
 */
export const DATABASE_VERSION = 1;

export const WORLD_STORE = "worlds";
export const SNAPSHOT_STORE = "snapshots";
export const SNAPSHOT_BLOB_STORE = "snapshotBlobs";

/** Index names, kept in one place so queries cannot misspell them. */
export const SNAPSHOT_BY_WORLD = "by-world";
export const SNAPSHOT_BY_WORLD_TICK = "by-world-tick";

/**
 * Ordered schema steps. Step `i` upgrades version `i` to `i + 1`.
 *
 * A browser that has been away for several versions runs the steps it missed,
 * in order, inside the single `versionchange` transaction the upgrade event
 * gives us. Writing them as a list rather than a switch means a new version is
 * one appended function, and it is impossible to forget the older path.
 */
const MIGRATIONS: readonly ((database: IDBDatabase) => void)[] = [
  function createInitialStores(database: IDBDatabase): void {
    database.createObjectStore(WORLD_STORE, { keyPath: "worldId" });
    const snapshots = database.createObjectStore(SNAPSHOT_STORE, { keyPath: "snapshotId" });
    snapshots.createIndex(SNAPSHOT_BY_WORLD, "worldId", { unique: false });
    database.createObjectStore(SNAPSHOT_BLOB_STORE, { keyPath: "snapshotId" });
    // Compound index: "the newest save of this world" is a bounded cursor on
    // it, not a scan-and-sort of every save the browser holds.
    snapshots.createIndex(SNAPSHOT_BY_WORLD_TICK, ["worldId", "tick"], { unique: false });
  },
];

/** The IndexedDB entry point, injectable so tests can supply a fake. */
export interface IndexedDbFactoryLike {
  open(name: string, version?: number): IDBOpenDBRequest;
  deleteDatabase(name: string): IDBOpenDBRequest;
}

/**
 * Resolve the ambient IndexedDB factory.
 *
 * Explicit rather than assumed: IndexedDB is missing in private-mode variants
 * and disabled in some embedded WebViews, and "cannot save here" is a message
 * the user deserves rather than a `TypeError` from a property access.
 */
export function resolveIndexedDb(factory?: IndexedDbFactoryLike): IndexedDbFactoryLike {
  if (factory !== undefined) {
    return factory;
  }
  const ambient = (globalThis as { indexedDB?: IndexedDbFactoryLike }).indexedDB;
  if (ambient === undefined || ambient === null) {
    throw new PersistenceError(
      "unavailable",
      "IndexedDB is not available in this browser context, so worlds cannot be saved here",
    );
  }
  return ambient;
}

/**
 * Open (and upgrade) the world database.
 *
 * `onClosed` fires when this connection stops being usable — another tab
 * upgrading the schema (`versionchange`), or the browser force-closing it. The
 * caller must drop its handle when that happens: every later call on a closed
 * connection throws `InvalidStateError`, which would turn one background event
 * into a store that fails forever.
 */
export async function openWorldDatabase(
  factory?: IndexedDbFactoryLike,
  onClosed?: () => void,
): Promise<IDBDatabase> {
  const indexedDb = resolveIndexedDb(factory);
  return await new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (cause) {
      reject(new PersistenceError("unavailable", `could not open ${DATABASE_NAME}`, cause));
      return;
    }

    request.onupgradeneeded = (event): void => {
      const database = request.result;
      const from = event.oldVersion;
      for (let step = from; step < DATABASE_VERSION; step += 1) {
        const migrate = MIGRATIONS[step];
        if (migrate === undefined) {
          // A database newer than this build should have failed as a version
          // error before reaching here; if it somehow did not, refusing beats
          // running an upgrade we have no code for.
          throw new PersistenceError(
            "version",
            `no migration from schema version ${step} to ${step + 1}`,
          );
        }
        migrate(database);
      }
    };

    request.onblocked = (): void => {
      reject(
        new PersistenceError(
          "blocked",
          "another open tab is holding an older version of the world database; close it and retry",
        ),
      );
    };

    request.onsuccess = (): void => {
      const database = request.result;
      // A newer tab upgrading the schema would otherwise leave this connection
      // holding a stale handle and blocking that upgrade forever.
      database.onversionchange = (): void => {
        database.close();
        onClosed?.();
      };
      // Fired when the connection is closed abnormally (the browser reclaiming
      // storage, a deleted database). Same consequence, same response.
      database.onclose = (): void => {
        onClosed?.();
      };
      resolve(database);
    };

    request.onerror = (): void => {
      // A VersionError means the stored database is NEWER than this build
      // expects — another tab, running a later version of the app, upgraded it.
      // That is not "IndexedDB is unavailable"; it is "this page is out of
      // date", and the user's fix is to reload, not to enable storage.
      const error = request.error;
      if (error?.name === "VersionError") {
        reject(
          new PersistenceError(
            "version",
            "the saved-world database was upgraded by a newer version of this app " +
              "(probably in another tab); reload the page to catch up",
            error,
          ),
        );
        return;
      }
      reject(new PersistenceError("unavailable", `could not open ${DATABASE_NAME}`, error));
    };
  });
}

/** Await one request, mapping failure onto a {@link PersistenceError}. */
export async function requestToPromise<T>(request: IDBRequest<T>, what: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(classifyRequestError(request.error, what));
    };
  });
}

/**
 * Await a whole transaction's completion.
 *
 * Writes resolve on `complete`, never on the last request's `success`: an
 * IndexedDB transaction can still abort after every request succeeded — quota,
 * a failed flush, the tab going away. Resolving early would let the UI report
 * "saved" for a save that never landed, which is precisely the failure mode a
 * durable-save feature exists to prevent.
 */
export async function transactionDone(transaction: IDBTransaction, what: string): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = (): void => {
      resolve();
    };
    transaction.onabort = (): void => {
      reject(classifyRequestError(transaction.error, what));
    };
    transaction.onerror = (): void => {
      reject(classifyRequestError(transaction.error, what));
    };
  });
}

function classifyRequestError(error: DOMException | null, what: string): PersistenceError {
  const name = error?.name ?? "UnknownError";
  if (name === "QuotaExceededError") {
    return new PersistenceError(
      "quota",
      `${what} failed: the browser's storage quota is full. Delete a saved world and retry.`,
      error,
    );
  }
  return new PersistenceError("io", `${what} failed: ${name}`, error);
}
