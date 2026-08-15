/**
 * Little-endian byte reader/writer for the durable snapshot container.
 *
 * Everything the persistence layer writes is explicitly little-endian, host
 * byte order notwithstanding: a save written on one machine must decode on
 * another, and "whatever `new Uint16Array(buffer)` happens to mean here" is not
 * a file format. The fast paths below only take the raw-byte shortcut after
 * proving at runtime that this host is little-endian, so a big-endian host
 * produces byte-identical files through the element-wise path.
 *
 * There are no DOM or IndexedDB references in this module: it is pure data
 * handling that the Worker can use without touching storage APIs.
 */

/**
 * True when this host stores multi-byte integers little-endian first.
 *
 * Probed once, from an actual typed-array write — not assumed, and not read
 * from a platform string. Every x86 and ARM target in practice says `true`;
 * the point is that correctness does not depend on that being true.
 */
const HOST_IS_LITTLE_ENDIAN = (() => {
  const probe = new Uint16Array([0x0102]);
  return new Uint8Array(probe.buffer)[0] === 0x02;
})();

/** Element byte widths, by the typed-array constructors this format supports. */
export type SupportedTypedArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

/** Thrown when a buffer ends before the value it claims to contain. */
export class BinaryReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryReadError";
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Growable little-endian writer.
 *
 * Grows by doubling; snapshots are megabytes, so the alternative — measuring
 * the exact size in a first pass and then writing in a second — would double
 * the traversal cost of the whole engine state to save a handful of copies.
 */
export class ByteWriter {
  #bytes: Uint8Array;
  #view: DataView;
  #length = 0;

  constructor(initialCapacity = 1 << 16) {
    this.#bytes = new Uint8Array(Math.max(16, initialCapacity));
    this.#view = new DataView(this.#bytes.buffer);
  }

  get length(): number {
    return this.#length;
  }

  #reserve(extra: number): number {
    const offset = this.#length;
    const needed = offset + extra;
    if (needed > this.#bytes.length) {
      let capacity = this.#bytes.length;
      while (capacity < needed) {
        capacity *= 2;
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.#bytes.subarray(0, offset));
      this.#bytes = grown;
      this.#view = new DataView(grown.buffer);
    }
    this.#length = needed;
    return offset;
  }

  u8(value: number): void {
    const at = this.#reserve(1);
    this.#view.setUint8(at, value);
  }

  u16(value: number): void {
    const at = this.#reserve(2);
    this.#view.setUint16(at, value, true);
  }

  u32(value: number): void {
    const at = this.#reserve(4);
    this.#view.setUint32(at, value, true);
  }

  f64(value: number): void {
    const at = this.#reserve(8);
    this.#view.setFloat64(at, value, true);
  }

  /** UTF-8 bytes with a u32 byte-length prefix. */
  string(value: string): void {
    const encoded = TEXT_ENCODER.encode(value);
    this.u32(encoded.length);
    const at = this.#reserve(encoded.length);
    this.#bytes.set(encoded, at);
  }

  /** Raw bytes, no length prefix. */
  raw(bytes: Uint8Array): void {
    const at = this.#reserve(bytes.length);
    this.#bytes.set(bytes, at);
  }

  /**
   * Typed-array elements, no length prefix (the caller writes the count).
   *
   * On a little-endian host the whole backing region is one `set` call; the
   * element-wise fallback exists so the bytes are identical anywhere.
   */
  elements(array: SupportedTypedArray, bytesPerElement: number): void {
    const byteLength = array.length * bytesPerElement;
    const at = this.#reserve(byteLength);
    if (HOST_IS_LITTLE_ENDIAN || bytesPerElement === 1) {
      this.#bytes.set(new Uint8Array(array.buffer, array.byteOffset, byteLength), at);
      return;
    }
    writeElementsBigEndianHost(this.#view, at, array, bytesPerElement);
  }

  /** Detached copy of everything written so far. */
  toUint8Array(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }
}

/** Element-wise write path for the (rare) big-endian host. */
function writeElementsBigEndianHost(
  view: DataView,
  at: number,
  array: SupportedTypedArray,
  bytesPerElement: number,
): void {
  for (let i = 0; i < array.length; i += 1) {
    const offset = at + i * bytesPerElement;
    const value = array[i] as number;
    if (array instanceof Float64Array) {
      view.setFloat64(offset, value, true);
    } else if (array instanceof Float32Array) {
      view.setFloat32(offset, value, true);
    } else if (bytesPerElement === 4) {
      view.setInt32(offset, value, true);
    } else {
      view.setInt16(offset, value, true);
    }
  }
}

/** Bounds-checked little-endian reader over an immutable byte range. */
export class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  #take(size: number, what: string): number {
    if (size < 0 || size > this.remaining) {
      throw new BinaryReadError(
        `truncated snapshot: ${what} needs ${size} bytes at offset ${this.#offset}, ` +
          `${this.remaining} remain`,
      );
    }
    const at = this.#offset;
    this.#offset += size;
    return at;
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1, "u8"));
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2, "u16"), true);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4, "u32"), true);
  }

  f64(): number {
    return this.#view.getFloat64(this.#take(8, "f64"), true);
  }

  string(): string {
    const byteLength = this.u32();
    const at = this.#take(byteLength, "string");
    try {
      return TEXT_DECODER.decode(this.#bytes.subarray(at, at + byteLength));
    } catch (cause) {
      throw new BinaryReadError(
        `snapshot string at offset ${at} is not valid UTF-8: ${String(cause)}`,
      );
    }
  }

  /**
   * Read `count` elements into a fresh typed array of the given constructor.
   *
   * The bytes are always copied into a new aligned buffer rather than viewed in
   * place: a stored payload is a byte stream at arbitrary offsets, and a
   * `Uint32Array` view demands 4-byte alignment the stream cannot promise.
   */
  elements<T extends SupportedTypedArray>(
    construct: (length: number) => T,
    count: number,
    bytesPerElement: number,
  ): T {
    const byteLength = count * bytesPerElement;
    const at = this.#take(byteLength, `${count} elements`);
    const target = construct(count);
    if (HOST_IS_LITTLE_ENDIAN || bytesPerElement === 1) {
      new Uint8Array(target.buffer, target.byteOffset, byteLength).set(
        this.#bytes.subarray(at, at + byteLength),
      );
      return target;
    }
    for (let i = 0; i < count; i += 1) {
      const offset = at + i * bytesPerElement;
      if (target instanceof Float64Array) {
        target[i] = this.#view.getFloat64(offset, true);
      } else if (target instanceof Float32Array) {
        target[i] = this.#view.getFloat32(offset, true);
      } else if (bytesPerElement === 4) {
        target[i] = this.#view.getInt32(offset, true);
      } else {
        target[i] = this.#view.getInt16(offset, true);
      }
    }
    return target;
  }

  /** Raw byte view (not copied) of the next `size` bytes. */
  rawView(size: number): Uint8Array {
    const at = this.#take(size, "raw bytes");
    return this.#bytes.subarray(at, at + size);
  }
}
