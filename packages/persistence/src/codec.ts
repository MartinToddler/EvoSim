/**
 * The storage-free half of `@eon/persistence`: engine state <-> bytes.
 *
 * Imported as `@eon/persistence/codec`, and deliberately reachable without the
 * package's IndexedDB half. Two consumers need exactly this and nothing more:
 *
 * - the **simulation Worker**, which owns the engine and must encode and decode
 *   saves, but has no business touching a database (docs/02 §3);
 * - **headless tooling** in Node, where the DOM's IndexedDB types do not exist
 *   at all — importing the store from a script would fail to typecheck for
 *   types it can never use.
 *
 * Nothing in this module or its dependencies references a storage API, a DOM
 * type or a wall clock.
 */

export {
  SNAPSHOT_MAGIC,
  SNAPSHOT_CONTAINER_VERSION,
  HEADER_BYTES,
  encodeDurableSnapshot,
  decodeDurableSnapshot,
  readSnapshotHeader,
  verifyRestoredStateHash,
  SnapshotFormatError,
  type SnapshotFormatCode,
  type DurableSnapshotHeader,
  type DurableSnapshotInput,
  type DecodedDurableSnapshot,
} from "./durableSnapshot";

export {
  encodeValue,
  decodeValue,
  ValueTag,
  ValueEncodeError,
  ValueDecodeError,
} from "./valueCodec";

export {
  SNAPSHOT_SHAPE,
  normalizeSnapshotShape,
  SnapshotShapeError,
  type FieldSpec,
} from "./snapshotShape";

export { crc32 } from "./crc32";
export { ByteReader, ByteWriter, BinaryReadError } from "./binary";
