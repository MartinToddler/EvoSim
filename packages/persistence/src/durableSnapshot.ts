/**
 * The durable snapshot container (task K03, docs/06 §21).
 *
 * ## Layout
 *
 * A save is a fixed 96-byte header followed by one encoded value graph:
 *
 * ```text
 *   0   magic            8   "EONSNAP\0"
 *   8   containerVersion 2   u16, this file format's own version
 *  10   headerBytes      2   u16, always HEADER_BYTES for containerVersion 1
 *  12   schemaVersion    4   u32, engine SNAPSHOT_SCHEMA_VERSION of the payload
 *  16   engineVersion   16   ASCII, zero padded
 *  32   configHash      16   ASCII, canonical digest of the stored config
 *  48   stateHash       16   ASCII, canonical state hash at the saved tick
 *  64   seed             4   u32
 *  68   tickLow          4   u32   } the tick as a safe integer, not a uint32:
 *  72   tickHigh         4   u32   } 2^32 ticks apart must not look identical
 *  76   payloadBytes     4   u32
 *  80   payloadChecksum  4   u32, CRC-32 of the payload
 *  84   flags            4   u32, reserved, must be 0
 *  88   reserved         4   u32, must be 0
 *  92   headerChecksum   4   u32, CRC-32 of bytes 0..91
 *  96   payload          payloadBytes
 * ```
 *
 * The header is checksummed separately from the payload for a practical
 * reason: the world list reads headers only. A damaged header must be
 * detectable without paying to read — and to trust — several megabytes of
 * payload behind it.
 *
 * ## Two versions, two jobs
 *
 * `containerVersion` versions *this framing*. `schemaVersion` versions the
 * engine state inside it. They move independently: the framing could gain a
 * compression flag without the engine changing at all, and the engine changes
 * its payload most milestones without the framing moving.
 *
 * ## What a load refuses
 *
 * Everything docs/06 §27 lists: wrong magic, unknown container version, wrong
 * engine version, wrong snapshot schema, damaged header, damaged payload,
 * truncation, a config whose digest disagrees with the header, and any payload
 * that does not match the declared shape. Each refusal carries a
 * {@link SnapshotFormatCode} so the UI can say which one happened, and none of
 * them deletes anything: rejecting a save is a read-side decision.
 */

import { ENGINE_VERSION, SNAPSHOT_SCHEMA_VERSION, hashConfig } from "@eon/engine";
import type { EngineCoreSnapshot } from "@eon/engine";
import { ByteWriter } from "./binary";
import { crc32 } from "./crc32";
import { normalizeSnapshotShape, SnapshotShapeError } from "./snapshotShape";
import { decodeValue, encodeValue, ValueDecodeError } from "./valueCodec";

/** ASCII "EONSNAP\0" — the eight bytes every save starts with. */
export const SNAPSHOT_MAGIC = "EONSNAP\0";
const MAGIC_BYTES = Uint8Array.from(SNAPSHOT_MAGIC, (character) => character.charCodeAt(0));

/** Version of the framing described above. Bump when the framing changes. */
export const SNAPSHOT_CONTAINER_VERSION = 1;

/** Fixed header size for container version 1. */
export const HEADER_BYTES = 96;

const OFFSET_MAGIC = 0;
const OFFSET_CONTAINER_VERSION = 8;
const OFFSET_HEADER_BYTES = 10;
const OFFSET_SCHEMA_VERSION = 12;
const OFFSET_ENGINE_VERSION = 16;
const OFFSET_CONFIG_HASH = 32;
const OFFSET_STATE_HASH = 48;
const OFFSET_SEED = 64;
const OFFSET_TICK_LOW = 68;
const OFFSET_TICK_HIGH = 72;
const OFFSET_PAYLOAD_BYTES = 76;
const OFFSET_PAYLOAD_CHECKSUM = 80;
const OFFSET_FLAGS = 84;
const OFFSET_RESERVED = 88;
const OFFSET_HEADER_CHECKSUM = 92;

/** Fixed-width ASCII fields. Both engine versions and digests fit comfortably. */
const ENGINE_VERSION_BYTES = 16;
const HASH_BYTES = 16;

/** Why a snapshot was refused. Stable strings: tests and the UI both read them. */
export type SnapshotFormatCode =
  | "not-a-snapshot"
  | "unsupported-container"
  | "unsupported-schema"
  | "engine-mismatch"
  | "header-corrupt"
  | "payload-corrupt"
  | "truncated"
  | "config-mismatch"
  | "state-hash-mismatch"
  | "malformed-payload";

/** Refusal to trust a stored snapshot. Carries a machine-readable {@link code}. */
export class SnapshotFormatError extends Error {
  readonly code: SnapshotFormatCode;

  constructor(code: SnapshotFormatCode, message: string) {
    super(message);
    this.name = "SnapshotFormatError";
    this.code = code;
  }
}

/** Everything the header carries, decoded. */
export interface DurableSnapshotHeader {
  containerVersion: number;
  schemaVersion: number;
  engineVersion: string;
  configHash: string;
  /** Canonical state hash at `tick`, recorded when the save was written. */
  stateHash: string;
  seed: number;
  tick: number;
  payloadBytes: number;
  payloadChecksum: number;
}

/** What the engine host hands to {@link encodeDurableSnapshot}. */
export interface DurableSnapshotInput {
  snapshot: EngineCoreSnapshot;
  /** `engine.computeStateHash()` at the saved tick. */
  stateHash: string;
  /** `engine.configHash`. */
  configHash: string;
}

function writeAscii(target: Uint8Array, offset: number, value: string, width: number): void {
  if (value.length > width) {
    throw new SnapshotFormatError(
      "malformed-payload",
      `"${value}" does not fit the ${width}-byte header field`,
    );
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0x7f) {
      throw new SnapshotFormatError(
        "malformed-payload",
        `"${value}" is not ASCII and cannot go in a fixed-width header field`,
      );
    }
    target[offset + i] = code;
  }
}

function readAscii(bytes: Uint8Array, offset: number, width: number): string {
  let end = offset;
  while (end < offset + width && bytes[end] !== 0) {
    end += 1;
  }
  let text = "";
  for (let i = offset; i < end; i += 1) {
    text += String.fromCharCode(bytes[i] as number);
  }
  return text;
}

/**
 * Encode a snapshot into durable bytes.
 *
 * Pure: it reads the snapshot the engine already handed over and touches
 * neither the engine nor its PRNG. Saving cannot change a world.
 */
export function encodeDurableSnapshot(input: DurableSnapshotInput): Uint8Array {
  const { snapshot, stateHash, configHash } = input;

  // Start the growable payload buffer near the true size: environment grid
  // plus a generous slack. Getting this roughly right avoids several full
  // copies of a multi-megabyte buffer on every save.
  const payload = encodeValue(snapshot, 1 << 21);

  const out = new ByteWriter(HEADER_BYTES + payload.length);
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC_BYTES, OFFSET_MAGIC);
  const view = new DataView(header.buffer);
  view.setUint16(OFFSET_CONTAINER_VERSION, SNAPSHOT_CONTAINER_VERSION, true);
  view.setUint16(OFFSET_HEADER_BYTES, HEADER_BYTES, true);
  view.setUint32(OFFSET_SCHEMA_VERSION, snapshot.schemaVersion, true);
  writeAscii(header, OFFSET_ENGINE_VERSION, snapshot.engineVersion, ENGINE_VERSION_BYTES);
  writeAscii(header, OFFSET_CONFIG_HASH, configHash, HASH_BYTES);
  writeAscii(header, OFFSET_STATE_HASH, stateHash, HASH_BYTES);
  view.setUint32(OFFSET_SEED, snapshot.seed >>> 0, true);
  // Ticks are safe integers; split rather than truncated (see hashState.ts).
  view.setUint32(OFFSET_TICK_LOW, snapshot.tick >>> 0, true);
  view.setUint32(OFFSET_TICK_HIGH, Math.floor(snapshot.tick / 2 ** 32), true);
  view.setUint32(OFFSET_PAYLOAD_BYTES, payload.length, true);
  view.setUint32(OFFSET_PAYLOAD_CHECKSUM, crc32(payload), true);
  view.setUint32(OFFSET_FLAGS, 0, true);
  view.setUint32(OFFSET_RESERVED, 0, true);
  view.setUint32(OFFSET_HEADER_CHECKSUM, crc32(header.subarray(0, OFFSET_HEADER_CHECKSUM)), true);

  out.raw(header);
  out.raw(payload);
  return out.toUint8Array();
}

/**
 * Read and validate the header only.
 *
 * This is what listing a stored world costs: 96 bytes, one CRC, no payload.
 */
export function readSnapshotHeader(bytes: Uint8Array): DurableSnapshotHeader {
  if (bytes.length < HEADER_BYTES) {
    throw new SnapshotFormatError(
      "truncated",
      `snapshot is ${bytes.length} bytes, shorter than the ${HEADER_BYTES}-byte header`,
    );
  }
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new SnapshotFormatError("not-a-snapshot", "data does not begin with the EON magic");
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);

  const storedHeaderChecksum = view.getUint32(OFFSET_HEADER_CHECKSUM, true);
  const actualHeaderChecksum = crc32(bytes.subarray(0, OFFSET_HEADER_CHECKSUM));
  if (storedHeaderChecksum !== actualHeaderChecksum) {
    throw new SnapshotFormatError(
      "header-corrupt",
      `snapshot header checksum ${hex(storedHeaderChecksum)} does not match ` +
        `${hex(actualHeaderChecksum)}; the header is damaged`,
    );
  }

  const containerVersion = view.getUint16(OFFSET_CONTAINER_VERSION, true);
  if (containerVersion !== SNAPSHOT_CONTAINER_VERSION) {
    throw new SnapshotFormatError(
      "unsupported-container",
      `snapshot container version ${containerVersion} is not supported ` +
        `(this build writes and reads ${SNAPSHOT_CONTAINER_VERSION})`,
    );
  }
  const headerBytes = view.getUint16(OFFSET_HEADER_BYTES, true);
  if (headerBytes !== HEADER_BYTES) {
    throw new SnapshotFormatError(
      "header-corrupt",
      `snapshot declares a ${headerBytes}-byte header; container version ` +
        `${SNAPSHOT_CONTAINER_VERSION} has ${HEADER_BYTES}`,
    );
  }
  if (view.getUint32(OFFSET_FLAGS, true) !== 0 || view.getUint32(OFFSET_RESERVED, true) !== 0) {
    // Reserved fields are how a future container version signals something
    // this build cannot honour (compression, chunking). Ignoring them would
    // mean misreading such a file rather than refusing it.
    throw new SnapshotFormatError(
      "unsupported-container",
      "snapshot sets reserved header bits this build does not understand",
    );
  }

  const tickLow = view.getUint32(OFFSET_TICK_LOW, true);
  const tickHigh = view.getUint32(OFFSET_TICK_HIGH, true);
  const tick = tickHigh * 2 ** 32 + tickLow;
  if (!Number.isSafeInteger(tick)) {
    throw new SnapshotFormatError(
      "header-corrupt",
      `snapshot tick ${tick} is not a safe integer; the header is damaged`,
    );
  }

  return {
    containerVersion,
    schemaVersion: view.getUint32(OFFSET_SCHEMA_VERSION, true),
    engineVersion: readAscii(bytes, OFFSET_ENGINE_VERSION, ENGINE_VERSION_BYTES),
    configHash: readAscii(bytes, OFFSET_CONFIG_HASH, HASH_BYTES),
    stateHash: readAscii(bytes, OFFSET_STATE_HASH, HASH_BYTES),
    seed: view.getUint32(OFFSET_SEED, true),
    tick,
    payloadBytes: view.getUint32(OFFSET_PAYLOAD_BYTES, true),
    payloadChecksum: view.getUint32(OFFSET_PAYLOAD_CHECKSUM, true),
  };
}

/** A validated snapshot, ready for `SimulationEngine.fromSnapshot`. */
export interface DecodedDurableSnapshot {
  header: DurableSnapshotHeader;
  snapshot: EngineCoreSnapshot;
}

/**
 * Fully validate stored bytes and return the engine snapshot inside.
 *
 * Order matters and is deliberate: cheap structural checks first, then the
 * payload checksum, then the (comparatively expensive) decode, then shape, then
 * the config digest. Nothing that could throw a `TypeError` from inside engine
 * code is reached before the payload has been proven well-formed.
 */
export function decodeDurableSnapshot(bytes: Uint8Array): DecodedDurableSnapshot {
  const header = readSnapshotHeader(bytes);

  if (header.engineVersion !== ENGINE_VERSION) {
    throw new SnapshotFormatError(
      "engine-mismatch",
      `snapshot was written by engine ${header.engineVersion}; this build is ${ENGINE_VERSION}. ` +
        "Replaying it here would produce a different history, so it is kept but not loaded.",
    );
  }
  if (header.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotFormatError(
      "unsupported-schema",
      `snapshot uses state schema ${header.schemaVersion}; this build reads ` +
        `${SNAPSHOT_SCHEMA_VERSION}`,
    );
  }

  const available = bytes.length - HEADER_BYTES;
  if (available !== header.payloadBytes) {
    throw new SnapshotFormatError(
      "truncated",
      `snapshot declares a ${header.payloadBytes}-byte payload but carries ${available}`,
    );
  }

  const payload = bytes.subarray(HEADER_BYTES);
  const actualChecksum = crc32(payload);
  if (actualChecksum !== header.payloadChecksum) {
    throw new SnapshotFormatError(
      "payload-corrupt",
      `snapshot payload checksum ${hex(header.payloadChecksum)} does not match ` +
        `${hex(actualChecksum)}; the save is damaged`,
    );
  }

  let decoded: unknown;
  try {
    decoded = decodeValue(payload);
  } catch (cause) {
    if (cause instanceof ValueDecodeError) {
      throw new SnapshotFormatError("malformed-payload", cause.message);
    }
    throw cause;
  }

  let normalized: unknown;
  try {
    normalized = normalizeSnapshotShape(decoded);
  } catch (cause) {
    if (cause instanceof SnapshotShapeError) {
      throw new SnapshotFormatError("malformed-payload", cause.message);
    }
    throw cause;
  }

  const snapshot = normalized as EngineCoreSnapshot;

  // Header and payload must agree. A disagreement means one of them was
  // edited, and the header is what the world list has been showing the user.
  if (snapshot.schemaVersion !== header.schemaVersion) {
    throw new SnapshotFormatError(
      "malformed-payload",
      `snapshot payload claims schema ${snapshot.schemaVersion}, header says ${header.schemaVersion}`,
    );
  }
  if (snapshot.engineVersion !== header.engineVersion) {
    throw new SnapshotFormatError(
      "malformed-payload",
      `snapshot payload claims engine ${snapshot.engineVersion}, header says ${header.engineVersion}`,
    );
  }
  if (snapshot.tick !== header.tick || snapshot.seed >>> 0 !== header.seed) {
    throw new SnapshotFormatError(
      "malformed-payload",
      `snapshot payload identity (seed ${snapshot.seed}, tick ${snapshot.tick}) disagrees with ` +
        `the header (seed ${header.seed}, tick ${header.tick})`,
    );
  }

  // docs/06 §27: the config hash is part of what a load validates. Recomputing
  // it here catches an edited config before the engine builds a world from it.
  const actualConfigHash = hashConfig(snapshot.config);
  if (actualConfigHash !== header.configHash) {
    throw new SnapshotFormatError(
      "config-mismatch",
      `snapshot config digest ${actualConfigHash} does not match the header's ${header.configHash}`,
    );
  }

  return { header, snapshot };
}

/**
 * Confirm a restored engine really is the world that was saved.
 *
 * The end-to-end check: the header carries the canonical state hash from save
 * time, and a world restored from it must hash the same. A checksum proves the
 * bytes survived; this proves the *simulation state* did — including that this
 * build interprets those bytes the way the writing build did.
 */
export function verifyRestoredStateHash(header: DurableSnapshotHeader, actualHash: string): void {
  if (actualHash !== header.stateHash) {
    throw new SnapshotFormatError(
      "state-hash-mismatch",
      `restored world hashes ${actualHash} but the save recorded ${header.stateHash} at tick ` +
        `${header.tick}; the restored state is not the state that was saved`,
    );
  }
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}
