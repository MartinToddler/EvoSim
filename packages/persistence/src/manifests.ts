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

/**
 * How a save came to exist.
 *
 * Only autosaves are pruned automatically. A `"branch"` save is the ORIGIN of a
 * world — the one save without which that world cannot be opened at all — so it
 * is retained like a manual save, and deliberately named apart from one so a
 * world list can say where a branch came from.
 */
export type SaveKind = "manual" | "autosave" | "branch";

/** Health of a stored world, as last observed (docs/06 §20). */
export type WorldStatus =
  /** Loads cleanly. */
  | "ok"
  /** Its newest save failed validation; older saves may still be good. */
  | "corrupt"
  /** Written by a different engine version; kept, not loadable (docs/06 §28). */
  | "legacy";

/**
 * One saved world. Points at its newest usable save.
 *
 * A branch is a world like any other here — its own id, its own saves, its own
 * future (docs/06 §30). The only difference is provenance: `parentWorldId` and
 * `branchTick` record where it diverged, and `branchTick` is also the earliest
 * tick it can be rewound to, because a branch does not own its parent's earlier
 * saves. Both are absent on a root world, which therefore begins at tick 0 —
 * see {@link worldOriginTick}, which is the single place that reads that rule.
 */
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
  /** World this one branched from, absent on a root world (docs/06 §30). */
  parentWorldId?: string;
  /** Tick the branch diverged at, absent on a root world. */
  branchTick?: number;
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

/**
 * Earliest tick a world can be reconstructed at.
 *
 * 0 for a root world; the branch point for a branch. A branch's history before
 * that tick belongs to its parent — asking this world for it would mean either
 * reading another world's saves or inventing state, and both are worse than a
 * bounded timeline.
 */
export function worldOriginTick(manifest: WorldManifest): number {
  return manifest.branchTick ?? 0;
}

/**
 * The save a reconstruction of `targetTick` must start from: the newest save at
 * or before it, or null when the world has none that early.
 *
 * Ties break on the lowest snapshot id. Two saves can share a tick — a manual
 * save and an autosave written at the same moment, a branch origin and a later
 * manual save — and without an explicit rule the choice would follow storage
 * iteration order, so two clients could replay from different bytes and
 * disagree about what happened. They would still reach the same state, but
 * "still correct by luck" is not a property worth relying on.
 */
export function selectSaveForTick(
  saves: readonly SnapshotSummary[],
  targetTick: number,
): SnapshotSummary | null {
  let best: SnapshotSummary | null = null;
  for (const save of saves) {
    if (save.tick > targetTick) {
      continue;
    }
    if (
      best === null ||
      save.tick > best.tick ||
      (save.tick === best.tick && save.snapshotId < best.snapshotId)
    ) {
      best = save;
    }
  }
  return best;
}
