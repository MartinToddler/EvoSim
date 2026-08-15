/**
 * Self-describing binary codec for the engine snapshot value graph.
 *
 * ## What it encodes
 *
 * `EngineCoreSnapshot` is deliberately a plain data graph: numbers, booleans,
 * strings, arrays, plain objects and typed arrays (see `EngineSnapshot.ts` in
 * `@eon/engine` — "no class prototype serialization", docs/06 §21). This module
 * encodes exactly that grammar and nothing else. Anything outside it — a
 * function, a `Map`, a class instance, `undefined`, a cyclic reference — is a
 * *bug in a capture function*, and is rejected loudly at save time rather than
 * silently dropped into a file that would restore a different world.
 *
 * ## Why one generic codec instead of a field-by-field writer
 *
 * A hand-written writer for ~150 fields across nine stores would have to be
 * edited in lockstep with every future authoritative field, and the failure
 * mode of forgetting is the worst one this project has: a save that loads
 * successfully and then diverges. Here, capture and encode cannot drift —
 * whatever `serialize()` returns is what lands in the file. The *shape* is
 * still checked, separately and strictly, on load (`snapshotShape.ts`), so
 * "generic" never means "untyped".
 *
 * ## Canonical output
 *
 * Object keys are sorted before writing, so the same state always produces the
 * same bytes and therefore the same checksum, on any host. That is a property
 * worth having in a project whose whole thesis is reproducibility: two saves of
 * the same tick are comparable byte for byte.
 */

import { BinaryReadError, ByteReader, ByteWriter, type SupportedTypedArray } from "./binary";

/** Value tags. Stable on disk: never renumber, only append. */
export const ValueTag = {
  False: 0x01,
  True: 0x02,
  /** Every JS number, stored as float64 — lossless for safe integers too. */
  Number: 0x03,
  String: 0x04,
  Array: 0x05,
  Object: 0x06,
  Null: 0x07,

  Uint8: 0x10,
  Int8: 0x11,
  Uint16: 0x12,
  Int16: 0x13,
  Uint32: 0x14,
  Int32: 0x15,
  Float32: 0x16,
  Float64: 0x17,
} as const;

export type ValueTagCode = (typeof ValueTag)[keyof typeof ValueTag];

/** Thrown when a value outside the supported grammar reaches the encoder. */
export class ValueEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueEncodeError";
  }
}

/** Thrown when a byte stream is not a well-formed value graph. */
export class ValueDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueDecodeError";
  }
}

interface TypedArrayKind {
  tag: ValueTagCode;
  bytesPerElement: number;
  construct: (length: number) => never;
}

/** A recognized typed array, with the tag and width it will be written as. */
interface TypedArrayMatch {
  tag: ValueTagCode;
  bytesPerElement: number;
  array: SupportedTypedArray;
}

/**
 * Keys that must never be written into a decoded object.
 *
 * A decoded snapshot is untrusted input (docs/06 §32 treats imported worlds as
 * untrusted, and a value read back out of IndexedDB deserves the same care).
 * Assigning a `__proto__` key would mutate the object's prototype instead of
 * adding a field, so the decoder refuses the key outright rather than trying to
 * sanitize it.
 */
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * Upper bounds on decoded container sizes.
 *
 * A corrupt length prefix would otherwise ask for an allocation of up to 4 GB
 * before the truncation check could fire. These caps are far above anything a
 * real world produces (the largest single array is the environment grid at
 * 65 536 entries, the largest genome block scales with `maxOrganisms`), and far
 * below "kill the tab".
 */
const MAX_ELEMENTS = 1 << 28;
const MAX_CONTAINER_ENTRIES = 1 << 24;

function typedArrayKind(value: object): TypedArrayMatch | null {
  if (value instanceof Uint8Array) {
    return { tag: ValueTag.Uint8, bytesPerElement: 1, array: value };
  }
  if (value instanceof Int8Array) {
    return { tag: ValueTag.Int8, bytesPerElement: 1, array: value };
  }
  if (value instanceof Uint16Array) {
    return { tag: ValueTag.Uint16, bytesPerElement: 2, array: value };
  }
  if (value instanceof Int16Array) {
    return { tag: ValueTag.Int16, bytesPerElement: 2, array: value };
  }
  if (value instanceof Uint32Array) {
    return { tag: ValueTag.Uint32, bytesPerElement: 4, array: value };
  }
  if (value instanceof Int32Array) {
    return { tag: ValueTag.Int32, bytesPerElement: 4, array: value };
  }
  if (value instanceof Float32Array) {
    return { tag: ValueTag.Float32, bytesPerElement: 4, array: value };
  }
  if (value instanceof Float64Array) {
    return { tag: ValueTag.Float64, bytesPerElement: 8, array: value };
  }
  return null;
}

// Constructors as plain functions so the tag table stays data, not a switch.
// The `never` return type is what `ByteReader.elements` wants; each call site
// knows the concrete array type from the tag it just read.
const uint8 = (n: number): never => new Uint8Array(n) as never;
const int8 = (n: number): never => new Int8Array(n) as never;
const uint16 = (n: number): never => new Uint16Array(n) as never;
const int16 = (n: number): never => new Int16Array(n) as never;
const uint32 = (n: number): never => new Uint32Array(n) as never;
const int32 = (n: number): never => new Int32Array(n) as never;
const float32 = (n: number): never => new Float32Array(n) as never;
const float64 = (n: number): never => new Float64Array(n) as never;

const KIND_BY_TAG = new Map<number, TypedArrayKind>([
  [ValueTag.Uint8, { tag: ValueTag.Uint8, bytesPerElement: 1, construct: uint8 }],
  [ValueTag.Int8, { tag: ValueTag.Int8, bytesPerElement: 1, construct: int8 }],
  [ValueTag.Uint16, { tag: ValueTag.Uint16, bytesPerElement: 2, construct: uint16 }],
  [ValueTag.Int16, { tag: ValueTag.Int16, bytesPerElement: 2, construct: int16 }],
  [ValueTag.Uint32, { tag: ValueTag.Uint32, bytesPerElement: 4, construct: uint32 }],
  [ValueTag.Int32, { tag: ValueTag.Int32, bytesPerElement: 4, construct: int32 }],
  [ValueTag.Float32, { tag: ValueTag.Float32, bytesPerElement: 4, construct: float32 }],
  [ValueTag.Float64, { tag: ValueTag.Float64, bytesPerElement: 8, construct: float64 }],
]);

/** Encode one value graph into a fresh byte array. */
export function encodeValue(value: unknown, initialCapacity?: number): Uint8Array {
  const writer = new ByteWriter(initialCapacity);
  writeValue(writer, value, "$");
  return writer.toUint8Array();
}

function writeValue(writer: ByteWriter, value: unknown, path: string): void {
  if (value === null) {
    writer.u8(ValueTag.Null);
    return;
  }
  switch (typeof value) {
    case "boolean":
      writer.u8(value ? ValueTag.True : ValueTag.False);
      return;
    case "number":
      if (!Number.isFinite(value)) {
        // NaN and infinities cannot appear in authoritative state (it is all
        // integers and fixed-point), so one here means a capture bug. Refusing
        // is better than storing a value the engine can never validate back.
        throw new ValueEncodeError(`${path} is ${String(value)}; snapshots store finite numbers`);
      }
      writer.u8(ValueTag.Number);
      writer.f64(value);
      return;
    case "string":
      writer.u8(ValueTag.String);
      writer.string(value);
      return;
    case "object":
      break;
    default:
      throw new ValueEncodeError(`${path} has unsupported type ${typeof value}`);
  }

  const kind = typedArrayKind(value);
  if (kind !== null) {
    writer.u8(kind.tag);
    writer.u32(kind.array.length);
    writer.elements(kind.array, kind.bytesPerElement);
    return;
  }

  if (Array.isArray(value)) {
    writer.u8(ValueTag.Array);
    writer.u32(value.length);
    for (let i = 0; i < value.length; i += 1) {
      writeValue(writer, value[i], `${path}[${i}]`);
    }
    return;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new ValueEncodeError(
      `${path} is a class instance (${value.constructor.name}); snapshots store plain data only`,
    );
  }

  // Sorted keys make the encoding canonical: same state, same bytes.
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  writer.u8(ValueTag.Object);
  writer.u32(keys.length);
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) {
      // `{ a: undefined }` and `{}` must not both encode to `{}` and then
      // restore as the same thing; an optional authoritative field would go
      // missing without a sound. Capture functions never produce one.
      throw new ValueEncodeError(`${path}.${key} is undefined; snapshots store explicit values`);
    }
    writer.string(key);
    writeValue(writer, entry, `${path}.${key}`);
  }
}

/**
 * Decode one value graph. The stream must be fully consumed: trailing bytes
 * mean the payload is not what it claims to be.
 */
export function decodeValue(bytes: Uint8Array): unknown {
  const reader = new ByteReader(bytes);
  let value: unknown;
  try {
    value = readValue(reader, "$", 0);
  } catch (cause) {
    if (cause instanceof BinaryReadError) {
      throw new ValueDecodeError(cause.message);
    }
    throw cause;
  }
  if (reader.remaining !== 0) {
    throw new ValueDecodeError(
      `snapshot payload has ${reader.remaining} trailing bytes after a complete value`,
    );
  }
  return value;
}

/**
 * Nesting limit. The engine's snapshot is five levels deep at most; this stops
 * a corrupt stream from turning into unbounded recursion.
 */
const MAX_DEPTH = 32;

function readValue(reader: ByteReader, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new ValueDecodeError(`snapshot value at ${path} nests deeper than ${MAX_DEPTH} levels`);
  }
  const tag = reader.u8();
  switch (tag) {
    case ValueTag.Null:
      return null;
    case ValueTag.False:
      return false;
    case ValueTag.True:
      return true;
    case ValueTag.Number:
      return reader.f64();
    case ValueTag.String:
      return reader.string();
    case ValueTag.Array: {
      const count = readCount(reader, MAX_CONTAINER_ENTRIES, path, "array entries");
      const array: unknown[] = [];
      for (let i = 0; i < count; i += 1) {
        array.push(readValue(reader, `${path}[${i}]`, depth + 1));
      }
      return array;
    }
    case ValueTag.Object: {
      const count = readCount(reader, MAX_CONTAINER_ENTRIES, path, "object entries");
      // Null prototype: a decoded snapshot is data, and nothing should be able
      // to reach Object.prototype through it.
      const record = Object.create(null) as Record<string, unknown>;
      let previousKey: string | null = null;
      for (let i = 0; i < count; i += 1) {
        const key = reader.string();
        if (FORBIDDEN_KEYS.includes(key)) {
          throw new ValueDecodeError(`snapshot object ${path} contains forbidden key ${key}`);
        }
        if (previousKey !== null && key <= previousKey) {
          // Canonical order is part of the format, so violating it means the
          // payload was not produced by this encoder — and duplicate keys,
          // whose last writer would silently win, become unrepresentable.
          throw new ValueDecodeError(
            `snapshot object ${path} keys are not strictly sorted (${previousKey} then ${key})`,
          );
        }
        previousKey = key;
        record[key] = readValue(reader, `${path}.${key}`, depth + 1);
      }
      return record;
    }
    default: {
      const kind = KIND_BY_TAG.get(tag);
      if (kind === undefined) {
        throw new ValueDecodeError(
          `snapshot value at ${path} has unknown tag 0x${tag.toString(16)}`,
        );
      }
      const count = readCount(reader, MAX_ELEMENTS, path, "array elements");
      return reader.elements(kind.construct, count, kind.bytesPerElement);
    }
  }
}

function readCount(reader: ByteReader, limit: number, path: string, what: string): number {
  const count = reader.u32();
  if (count > limit) {
    throw new ValueDecodeError(
      `snapshot value at ${path} claims ${count} ${what}, above the ${limit} limit`,
    );
  }
  return count;
}
