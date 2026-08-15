/**
 * Stored record shapes: world manifests and save records (tasks K01/K02,
 * docs/06 §20).
 *
 * These are the only structures IndexedDB holds. Both are plain data — they go
 * through the structured clone algorithm, so no class instance, no `Date`
 * object standing in for a timestamp, nothing with a prototype worth losing.
 *
 * ## Wall clock lives here and only here
 *
 * `createdAtIso`, `lastOpenedAtIso` and `savedAtIso` are metadata: they order
 * a list for a human and never reach the engine. The simulation itself has no
 * concept of what time it is in the real world (CLAUDE.md), so a clock reading
 * in this file cannot influence a single tick. Whoever writes a record supplies
 * the timestamp; nothing here calls `Date.now()` on its own initiative.
 */

/** How a save came to exist. Manual saves are never pruned automatically. */
export type SaveKind = "manual" | "autosave";

/** Health of a stored world, as last observed (docs/06 §20). */
export type WorldStatus =
  /** Loads cleanly. */
  | "ok"
  /** Its newest save failed validation; older saves may still be good. */
  | "corrupt"
  /** Written by a different engine version; kept, not loadable (docs/06 §28). */
  | "legacy";

/** One saved world. Points at its newest usable save. */
export interface WorldManifest {
  worldId: string;
  worldName: string;
  /** Metadata only, never authoritative. */
  createdAtIso: string;
  lastOpenedAtIso: string;
  seed: number;
  appVersion: string;
  engineVersion: string;
  configSchemaVersion: number;
  snapshotSchemaVersion: number;
  /** Tick of {@link latestSnapshotId}. */
  latestTick: number;
  latestSnapshotId: string;
  /** Canonical state hash at `latestTick` — a world's identity, at a glance. */
  latestStateHash: string;
  status: WorldStatus;
  /** Why the status is not "ok"; empty when it is. */
  statusDetail: string;
}

/**
 * One save's metadata. The payload lives beside it in `snapshotBlobs`, keyed by
 * the same `snapshotId`, so listing worlds never pulls megabytes (see `db.ts`).
 */
export interface SnapshotRecord {
  snapshotId: string;
  worldId: string;
  tick: number;
  kind: SaveKind;
  /** Metadata only. */
  savedAtIso: string;
  engineVersion: string;
  snapshotSchemaVersion: number;
  stateHash: string;
  byteLength: number;
}

/** The payload row: the durable container from `durableSnapshot.ts`. */
export interface SnapshotBlob {
  snapshotId: string;
  /**
   * Stored as an `ArrayBuffer` so IndexedDB keeps it as a binary blob rather
   * than a structured clone of a typed-array view.
   */
  bytes: ArrayBuffer;
}

/** Listing entry: a manifest plus the saves behind it. */
export interface StoredWorld {
  manifest: WorldManifest;
  /** Newest first. Metadata only — never the bytes. */
  saves: SnapshotSummary[];
}

/**
 * A save's metadata. Identical to {@link SnapshotRecord} today; kept as its own
 * name because it is what every caller above this package is handed, and the
 * stored row is free to gain fields the UI has no business seeing.
 */
export type SnapshotSummary = SnapshotRecord;
