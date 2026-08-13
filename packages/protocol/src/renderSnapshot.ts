/**
 * Render snapshot wire format (task G04, docs/02 §10, docs/06 §§1-4).
 *
 * ## Why one ArrayBuffer
 *
 * A render snapshot is the only high-frequency message in the system, so its
 * cost is the system's cost. Three rules shape this layout:
 *
 * 1. **No JSON.** docs/02 §10 forbids one object per organism per frame. Every
 *    per-entity field is a TypedArray element.
 * 2. **One transfer, not seventeen.** Each `ArrayBuffer` in a `postMessage`
 *    transfer list is a separate neutering + reattachment. Seventeen parallel
 *    arrays would mean seventeen buffers per frame; instead every array is a
 *    view into a single buffer, so a snapshot costs exactly one transfer and
 *    one recycle.
 * 3. **Reusable.** The buffer is allocated once per pool entry and refilled,
 *    so a world running for hours allocates a bounded number of snapshot
 *    buffers rather than one per frame (docs/02 §10).
 *
 * ## Structure of Arrays, not array of structs
 *
 * Same reason the engine uses SoA: the writer fills whole columns in ascending
 * slot order, and the renderer reads whole columns into Pixi particles.
 *
 * ## What is deliberately NOT here
 *
 * No genome, no brain weights, no per-organism sensor values, no authoritative
 * fixed-point internals. A render snapshot answers "what should be drawn",
 * nothing else; anything an inspector needs is fetched on demand for one
 * entity via QUERY_ENTITY. Positions are renderer floats in location units
 * derived from authoritative fixed-point state — the renderer never sees, and
 * therefore can never write back, an authoritative coordinate.
 */

/** `"EONR"` — guards against a recycled buffer of the wrong kind being adopted. */
export const RENDER_SNAPSHOT_MAGIC = 0x454f4e52;

/**
 * Layout version for the packed buffer.
 *
 * Separate from PROTOCOL_VERSION on purpose: this is the binary shape of one
 * message, and a mismatch is detectable inside a buffer that has already been
 * transferred, where the envelope's version is no longer at hand.
 */
export const RENDER_SNAPSHOT_LAYOUT_VERSION = 1;

/** Header slot indices (see {@link RenderSnapshotView.header}). */
export const RenderHeader = {
  Magic: 0,
  LayoutVersion: 1,
  OrganismCapacity: 2,
  CarcassCapacity: 3,
  OrganismCount: 4,
  CarcassCount: 5,
  /** Authoritative tick this snapshot projects. A safe integer, hence Float64. */
  Tick: 6,
  Reserved: 7,
} as const;

export const RENDER_HEADER_FIELDS = 8;

/**
 * Per-organism render flags.
 *
 * Every bit is read straight from an authoritative row — the renderer is told
 * what is true, never asked to infer it.
 */
export const RenderFlag = {
  /** Development has not reached adult size yet. */
  Juvenile: 1 << 0,
  /** Attacked recently enough that the attack cooldown is still running. */
  Attacking: 1 << 1,
  /** Took damage on the previous tick. */
  Injured: 1 << 2,
  /** Diet gene leans carnivore (diet > 0). */
  CarnivoreLeaning: 1 << 3,
} as const;

/** Bytes per element, by section element type. */
const F64 = 8;
const U32 = 4;
const F32 = 4;
const U16 = 2;
const U8 = 1;

interface SectionOffsets {
  readonly headerBytes: number;
  readonly organismId: number;
  readonly organismX: number;
  readonly organismY: number;
  readonly organismRotation: number;
  readonly organismRadiusLU: number;
  readonly organismSpeciesId: number;
  readonly organismHueDeg: number;
  readonly organismFlags: number;
  readonly organismHealth: number;
  readonly organismEnergy: number;
  readonly organismDiet: number;
  readonly organismSpeed: number;
  readonly carcassId: number;
  readonly carcassX: number;
  readonly carcassY: number;
  readonly carcassRadiusLU: number;
  readonly totalBytes: number;
}

/** Round `offset` up to the next multiple of `alignment`. */
function align(offset: number, alignment: number): number {
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + (alignment - remainder);
}

/**
 * Byte offsets of every section, for the given capacities.
 *
 * Sections are laid out widest-first and each is explicitly aligned to its
 * element size: a `Float32Array` view over a non-multiple-of-4 offset throws,
 * and relying on "the capacities happen to be powers of two" would make the
 * layout silently fragile the first time a config used an odd cap.
 */
export function computeRenderSnapshotLayout(
  organismCapacity: number,
  carcassCapacity: number,
): SectionOffsets {
  let at = RENDER_HEADER_FIELDS * F64;
  const headerBytes = at;

  const take = (bytes: number, elementSize: number): number => {
    at = align(at, elementSize);
    const start = at;
    at += bytes;
    return start;
  };

  const organismId = take(organismCapacity * U32, U32);
  const organismX = take(organismCapacity * F32, F32);
  const organismY = take(organismCapacity * F32, F32);
  const organismRotation = take(organismCapacity * F32, F32);
  const organismRadiusLU = take(organismCapacity * F32, F32);
  const organismSpeciesId = take(organismCapacity * U32, U32);
  const organismHueDeg = take(organismCapacity * U16, U16);
  const organismFlags = take(organismCapacity * U16, U16);
  const organismHealth = take(organismCapacity * U8, U8);
  const organismEnergy = take(organismCapacity * U8, U8);
  const organismDiet = take(organismCapacity * U8, U8);
  const organismSpeed = take(organismCapacity * U8, U8);

  const carcassId = take(carcassCapacity * U32, U32);
  const carcassX = take(carcassCapacity * F32, F32);
  const carcassY = take(carcassCapacity * F32, F32);
  const carcassRadiusLU = take(carcassCapacity * F32, F32);

  return {
    headerBytes,
    organismId,
    organismX,
    organismY,
    organismRotation,
    organismRadiusLU,
    organismSpeciesId,
    organismHueDeg,
    organismFlags,
    organismHealth,
    organismEnergy,
    organismDiet,
    organismSpeed,
    carcassId,
    carcassX,
    carcassY,
    carcassRadiusLU,
    totalBytes: at,
  };
}

/**
 * Typed views over one render snapshot buffer.
 *
 * The organism columns are exactly the writer surface the engine fills
 * (`RenderSnapshotWriter` in `@eon/engine`); the match is structural, so the
 * engine never imports this package and this package never imports the engine.
 */
export interface RenderSnapshotView {
  readonly buffer: ArrayBuffer;
  readonly header: Float64Array;

  readonly organismId: Uint32Array;
  readonly organismX: Float32Array;
  readonly organismY: Float32Array;
  readonly organismRotation: Float32Array;
  readonly organismRadiusLU: Float32Array;
  readonly organismSpeciesId: Uint32Array;
  readonly organismHueDeg: Uint16Array;
  readonly organismFlags: Uint16Array;
  readonly organismHealth: Uint8Array;
  readonly organismEnergy: Uint8Array;
  readonly organismDiet: Int8Array;
  readonly organismSpeed: Uint8Array;

  readonly carcassId: Uint32Array;
  readonly carcassX: Float32Array;
  readonly carcassY: Float32Array;
  readonly carcassRadiusLU: Float32Array;

  readonly organismCapacity: number;
  readonly carcassCapacity: number;
}

export class RenderSnapshotFormatError extends Error {
  override readonly name = "RenderSnapshotFormatError";
}

/** Allocate one snapshot buffer and stamp its header. */
export function createRenderSnapshotBuffer(
  organismCapacity: number,
  carcassCapacity: number,
): ArrayBuffer {
  if (!Number.isSafeInteger(organismCapacity) || organismCapacity <= 0) {
    throw new RenderSnapshotFormatError(
      `organism capacity must be a positive safe integer, got ${organismCapacity}`,
    );
  }
  if (!Number.isSafeInteger(carcassCapacity) || carcassCapacity < 0) {
    throw new RenderSnapshotFormatError(
      `carcass capacity must be a non-negative safe integer, got ${carcassCapacity}`,
    );
  }
  const layout = computeRenderSnapshotLayout(organismCapacity, carcassCapacity);
  const buffer = new ArrayBuffer(layout.totalBytes);
  const header = new Float64Array(buffer, 0, RENDER_HEADER_FIELDS);
  header[RenderHeader.Magic] = RENDER_SNAPSHOT_MAGIC;
  header[RenderHeader.LayoutVersion] = RENDER_SNAPSHOT_LAYOUT_VERSION;
  header[RenderHeader.OrganismCapacity] = organismCapacity;
  header[RenderHeader.CarcassCapacity] = carcassCapacity;
  return buffer;
}

/**
 * Build views over a snapshot buffer, validating its self-describing header.
 *
 * Validation is not paranoia: buffers travel by transfer and come back through
 * a recycle message that any main-thread code could in principle send, and a
 * detached or foreign buffer must fail loudly here rather than produce
 * organisms at coordinate NaN.
 */
export function viewRenderSnapshot(buffer: ArrayBuffer): RenderSnapshotView {
  if (buffer.byteLength < RENDER_HEADER_FIELDS * F64) {
    throw new RenderSnapshotFormatError(
      `render snapshot buffer is too small to hold a header: ${buffer.byteLength} bytes`,
    );
  }
  const header = new Float64Array(buffer, 0, RENDER_HEADER_FIELDS);
  if (header[RenderHeader.Magic] !== RENDER_SNAPSHOT_MAGIC) {
    throw new RenderSnapshotFormatError(
      `buffer is not a render snapshot (magic ${String(header[RenderHeader.Magic])})`,
    );
  }
  if (header[RenderHeader.LayoutVersion] !== RENDER_SNAPSHOT_LAYOUT_VERSION) {
    throw new RenderSnapshotFormatError(
      `render snapshot layout ${String(header[RenderHeader.LayoutVersion])} is not supported ` +
        `(expected ${RENDER_SNAPSHOT_LAYOUT_VERSION})`,
    );
  }

  const organismCapacity = header[RenderHeader.OrganismCapacity] as number;
  const carcassCapacity = header[RenderHeader.CarcassCapacity] as number;
  const layout = computeRenderSnapshotLayout(organismCapacity, carcassCapacity);
  if (buffer.byteLength !== layout.totalBytes) {
    throw new RenderSnapshotFormatError(
      `render snapshot buffer is ${buffer.byteLength} bytes but its header describes ` +
        `${layout.totalBytes}`,
    );
  }

  return {
    buffer,
    header,
    organismId: new Uint32Array(buffer, layout.organismId, organismCapacity),
    organismX: new Float32Array(buffer, layout.organismX, organismCapacity),
    organismY: new Float32Array(buffer, layout.organismY, organismCapacity),
    organismRotation: new Float32Array(buffer, layout.organismRotation, organismCapacity),
    organismRadiusLU: new Float32Array(buffer, layout.organismRadiusLU, organismCapacity),
    organismSpeciesId: new Uint32Array(buffer, layout.organismSpeciesId, organismCapacity),
    organismHueDeg: new Uint16Array(buffer, layout.organismHueDeg, organismCapacity),
    organismFlags: new Uint16Array(buffer, layout.organismFlags, organismCapacity),
    organismHealth: new Uint8Array(buffer, layout.organismHealth, organismCapacity),
    organismEnergy: new Uint8Array(buffer, layout.organismEnergy, organismCapacity),
    organismDiet: new Int8Array(buffer, layout.organismDiet, organismCapacity),
    organismSpeed: new Uint8Array(buffer, layout.organismSpeed, organismCapacity),
    carcassId: new Uint32Array(buffer, layout.carcassId, carcassCapacity),
    carcassX: new Float32Array(buffer, layout.carcassX, carcassCapacity),
    carcassY: new Float32Array(buffer, layout.carcassY, carcassCapacity),
    carcassRadiusLU: new Float32Array(buffer, layout.carcassRadiusLU, carcassCapacity),
    organismCapacity,
    carcassCapacity,
  };
}

/** How many organisms/carcasses the producer actually wrote. */
export function readRenderSnapshotCounts(view: RenderSnapshotView): {
  organismCount: number;
  carcassCount: number;
  tick: number;
} {
  return {
    organismCount: view.header[RenderHeader.OrganismCount] as number,
    carcassCount: view.header[RenderHeader.CarcassCount] as number,
    tick: view.header[RenderHeader.Tick] as number,
  };
}

/**
 * Bounded pool of reusable snapshot buffers (docs/02 §10).
 *
 * ## The lifecycle this pool encodes
 *
 * A buffer is either *in the pool* (idle, owned by the worker) or *in flight*
 * (transferred to the main thread, detached here). `acquire` takes one from
 * the pool, or mints one while the total is under `maxBuffers`, or returns
 * `null`. Returning `null` is the whole point: it is what turns "the main
 * thread is not keeping up" into a *dropped render snapshot* rather than into
 * unbounded allocation. Render snapshots are droppable; authoritative ticks
 * are not (docs/02 §8).
 *
 * `release` takes a buffer back from the main thread. A detached buffer is
 * dropped rather than pooled — a transfer that crossed with a recycle would
 * otherwise poison the pool with a zero-length buffer.
 */
export class RenderBufferPool {
  readonly organismCapacity: number;
  readonly carcassCapacity: number;
  readonly maxBuffers: number;

  readonly #idle: ArrayBuffer[] = [];
  #created = 0;
  #inFlight = 0;
  #dropped = 0;

  constructor(organismCapacity: number, carcassCapacity: number, maxBuffers = 3) {
    if (!Number.isSafeInteger(maxBuffers) || maxBuffers < 1) {
      throw new RenderSnapshotFormatError(
        `render buffer pool needs at least one buffer, got ${maxBuffers}`,
      );
    }
    this.organismCapacity = organismCapacity;
    this.carcassCapacity = carcassCapacity;
    this.maxBuffers = maxBuffers;
    // Validate the capacities once, here, rather than on the first frame.
    this.#idle.push(createRenderSnapshotBuffer(organismCapacity, carcassCapacity));
    this.#created = 1;
  }

  /** Buffers currently transferred to the consumer. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Buffers ever allocated by this pool. Bounded by {@link maxBuffers}. */
  get created(): number {
    return this.#created;
  }

  /** Idle buffers waiting to be filled. */
  get idle(): number {
    return this.#idle.length;
  }

  /** Snapshots skipped because every buffer was still in flight. */
  get droppedSnapshots(): number {
    return this.#dropped;
  }

  /**
   * Take a buffer to fill, or `null` when the consumer holds them all.
   *
   * A `null` result is a normal, expected outcome under back-pressure, not an
   * error: the caller skips this snapshot and keeps ticking.
   */
  acquire(): ArrayBuffer | null {
    const pooled = this.#idle.pop();
    if (pooled !== undefined) {
      this.#inFlight += 1;
      return pooled;
    }
    if (this.#created < this.maxBuffers) {
      this.#created += 1;
      this.#inFlight += 1;
      return createRenderSnapshotBuffer(this.organismCapacity, this.carcassCapacity);
    }
    this.#dropped += 1;
    return null;
  }

  /**
   * Return a buffer the consumer is done with.
   *
   * Returns whether the buffer rejoined the pool. Anything that is not one of
   * ours — detached, wrong size, foreign magic — is dropped rather than pooled,
   * because the alternative is a rendering thread quietly reading garbage.
   */
  release(buffer: ArrayBuffer): boolean {
    if (this.#inFlight > 0) {
      this.#inFlight -= 1;
    }
    // A detached buffer reports byteLength 0; there is nothing to reuse.
    if (buffer.byteLength === 0) {
      this.#created -= 1;
      return false;
    }
    try {
      const view = viewRenderSnapshot(buffer);
      if (
        view.organismCapacity !== this.organismCapacity ||
        view.carcassCapacity !== this.carcassCapacity
      ) {
        this.#created -= 1;
        return false;
      }
    } catch {
      this.#created -= 1;
      return false;
    }
    this.#idle.push(buffer);
    return true;
  }
}
