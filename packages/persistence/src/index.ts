/**
 * @eon/persistence — durable snapshot format and the browser storage adapter
 * (Milestone 10, tasks K01–K06).
 *
 * Two layers, deliberately separable:
 *
 * - **the container** (`durableSnapshot`, `valueCodec`, `snapshotShape`,
 *   `binary`, `crc32`) is pure data handling with no storage API in sight, so
 *   the Worker can encode a save without knowing IndexedDB exists;
 * - **the store** (`WorldStore`, `db`, `manifests`) is the IndexedDB adapter.
 *
 * Neither decides simulation rules (CLAUDE.md): this package moves engine state
 * to and from bytes, and never changes what that state means.
 */

// The storage-free codec, also importable on its own as
// `@eon/persistence/codec` — see `codec.ts` for why that split exists.
export * from "./codec";

export {
  DATABASE_NAME,
  DATABASE_VERSION,
  WORLD_STORE,
  SNAPSHOT_STORE,
  openWorldDatabase,
  type IndexedDbFactoryLike,
} from "./db";

export { PersistenceError, describePersistenceError, type PersistenceErrorKind } from "./errors";

export type {
  SaveKind,
  SnapshotBlob,
  SnapshotRecord,
  SnapshotSummary,
  StoredWorld,
  WorldManifest,
  WorldStatus,
} from "./manifests";

export {
  WorldStore,
  DEFAULT_AUTOSAVE_RETENTION,
  type WorldStoreOptions,
  type SaveWorldRequest,
  type SaveWorldResult,
  type LoadWorldResult,
  type RejectedSave,
} from "./WorldStore";
