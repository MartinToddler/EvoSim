/**
 * Environment field transport: the static terrain and the vegetation stream
 * (task G05, docs/06 §2).
 *
 * The environment is a 256² grid, so a whole field is 65 536 bytes — small
 * enough to send outright and far cheaper than describing it. Two messages
 * carry it, because the two halves change at wildly different rates:
 *
 * - **Terrain** (biome, elevation and — since layout 2 — temperature,
 *   moisture, fertility and plant capacity, for the Milestone 7 world layers)
 *   is sent once with WORLD_READY. Nothing in Milestones 0-7 edits any of it;
 *   the player interventions of Milestone 9 (tasks J03-J05) are what will make
 *   these fields move, and when they land they will resend the affected field
 *   rather than stream it — exactly the plan already recorded here for terrain
 *   raise/lower.
 * - **Vegetation** is sent on its own low-rate cadence. docs/06 §2 puts plant
 *   display at ~2-5 Hz: biomass changes slowly, the environment phase only
 *   runs every `time.environmentInterval` ticks, and a 64 KB field at 60 Hz
 *   would cost more bandwidth than every organism in the world combined.
 *
 * Both are quantized to bytes. These are display fields: the authoritative
 * values stay in the engine at full precision, and the renderer only needs
 * enough resolution to choose a colour.
 */

/** `"EONT"` */
export const TERRAIN_SNAPSHOT_MAGIC = 0x454f4e54;
/** `"EONV"` */
export const VEGETATION_SNAPSHOT_MAGIC = 0x454f4e56;

/**
 * Bumped to 2 for Milestone 7: the terrain snapshot grew four display planes
 * (temperature, moisture, fertility, plant capacity) for the world layers.
 * The vegetation snapshot's shape is unchanged, but it shares this constant —
 * both ends of the wire always ship together, and one number that must match
 * is simpler than two that usually do.
 */
export const FIELD_SNAPSHOT_LAYOUT_VERSION = 2;

/** Byte planes in a terrain snapshot, in buffer order. */
const TERRAIN_PLANES = 7;

export const FieldHeader = {
  Magic: 0,
  LayoutVersion: 1,
  CellCount: 2,
  /** Grid edge length in cells; the grid is square. */
  GridSize: 3,
  /** Authoritative tick the field was read at. */
  Tick: 4,
  Reserved: 5,
} as const;

export const FIELD_HEADER_FIELDS = 6;
const HEADER_BYTES = FIELD_HEADER_FIELDS * 8;

export class FieldSnapshotFormatError extends Error {
  override readonly name = "FieldSnapshotFormatError";
}

function writeHeader(buffer: ArrayBuffer, magic: number, gridSize: number): Float64Array {
  const header = new Float64Array(buffer, 0, FIELD_HEADER_FIELDS);
  header[FieldHeader.Magic] = magic;
  header[FieldHeader.LayoutVersion] = FIELD_SNAPSHOT_LAYOUT_VERSION;
  header[FieldHeader.CellCount] = gridSize * gridSize;
  header[FieldHeader.GridSize] = gridSize;
  return header;
}

function readHeader(buffer: ArrayBuffer, magic: number, kind: string): Float64Array {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new FieldSnapshotFormatError(
      `${kind} buffer is too small to hold a header: ${buffer.byteLength} bytes`,
    );
  }
  const header = new Float64Array(buffer, 0, FIELD_HEADER_FIELDS);
  if (header[FieldHeader.Magic] !== magic) {
    throw new FieldSnapshotFormatError(
      `buffer is not a ${kind} (magic ${String(header[FieldHeader.Magic])})`,
    );
  }
  if (header[FieldHeader.LayoutVersion] !== FIELD_SNAPSHOT_LAYOUT_VERSION) {
    throw new FieldSnapshotFormatError(
      `${kind} layout ${String(header[FieldHeader.LayoutVersion])} is not supported ` +
        `(expected ${FIELD_SNAPSHOT_LAYOUT_VERSION})`,
    );
  }
  return header;
}

function validateGridSize(gridSize: number): number {
  if (!Number.isSafeInteger(gridSize) || gridSize <= 0) {
    throw new FieldSnapshotFormatError(
      `grid size must be a positive safe integer, got ${gridSize}`,
    );
  }
  return gridSize * gridSize;
}

// --- Terrain -----------------------------------------------------------------

export interface TerrainSnapshotView {
  readonly buffer: ArrayBuffer;
  readonly header: Float64Array;
  readonly gridSize: number;
  readonly cellCount: number;
  /** Biome index per cell, matching the engine's `Biome` enum. */
  readonly biome: Uint8Array;
  /** Elevation rescaled to 0-255 for shading. */
  readonly elevation: Uint8Array;
  /** Plant biomass as a fraction of that cell's capacity, 0-255. */
  readonly vegetation: Uint8Array;
  /**
   * Temperature rescaled to 0-255 over the display range published in
   * `WorldSummaryDto.display` (layout 2, Milestone 7 world layers).
   */
  readonly temperature: Uint8Array;
  /** Effective moisture as a fraction of full saturation, 0-255. */
  readonly moisture: Uint8Array;
  /** Soil fertility as a fraction of maximum, 0-255. */
  readonly fertility: Uint8Array;
  /**
   * Plant capacity as a fraction of the display reference in
   * `WorldSummaryDto.display.capacityDisplayReference`, 0-255.
   */
  readonly capacity: Uint8Array;
}

export function createTerrainBuffer(gridSize: number): ArrayBuffer {
  const cellCount = validateGridSize(gridSize);
  const buffer = new ArrayBuffer(HEADER_BYTES + cellCount * TERRAIN_PLANES);
  writeHeader(buffer, TERRAIN_SNAPSHOT_MAGIC, gridSize);
  return buffer;
}

export function viewTerrainSnapshot(buffer: ArrayBuffer): TerrainSnapshotView {
  const header = readHeader(buffer, TERRAIN_SNAPSHOT_MAGIC, "terrain snapshot");
  const gridSize = header[FieldHeader.GridSize] as number;
  const cellCount = header[FieldHeader.CellCount] as number;
  if (buffer.byteLength !== HEADER_BYTES + cellCount * TERRAIN_PLANES) {
    throw new FieldSnapshotFormatError(
      `terrain snapshot buffer is ${buffer.byteLength} bytes but its header describes ` +
        `${HEADER_BYTES + cellCount * TERRAIN_PLANES}`,
    );
  }
  const plane = (index: number): Uint8Array =>
    new Uint8Array(buffer, HEADER_BYTES + cellCount * index, cellCount);
  return {
    buffer,
    header,
    gridSize,
    cellCount,
    biome: plane(0),
    elevation: plane(1),
    vegetation: plane(2),
    temperature: plane(3),
    moisture: plane(4),
    fertility: plane(5),
    capacity: plane(6),
  };
}

// --- Vegetation --------------------------------------------------------------

export interface VegetationSnapshotView {
  readonly buffer: ArrayBuffer;
  readonly header: Float64Array;
  readonly gridSize: number;
  readonly cellCount: number;
  readonly vegetation: Uint8Array;
}

export function createVegetationBuffer(gridSize: number): ArrayBuffer {
  const cellCount = validateGridSize(gridSize);
  const buffer = new ArrayBuffer(HEADER_BYTES + cellCount);
  writeHeader(buffer, VEGETATION_SNAPSHOT_MAGIC, gridSize);
  return buffer;
}

export function viewVegetationSnapshot(buffer: ArrayBuffer): VegetationSnapshotView {
  const header = readHeader(buffer, VEGETATION_SNAPSHOT_MAGIC, "vegetation snapshot");
  const gridSize = header[FieldHeader.GridSize] as number;
  const cellCount = header[FieldHeader.CellCount] as number;
  if (buffer.byteLength !== HEADER_BYTES + cellCount) {
    throw new FieldSnapshotFormatError(
      `vegetation snapshot buffer is ${buffer.byteLength} bytes but its header describes ` +
        `${HEADER_BYTES + cellCount}`,
    );
  }
  return {
    buffer,
    header,
    gridSize,
    cellCount,
    vegetation: new Uint8Array(buffer, HEADER_BYTES, cellCount),
  };
}

/**
 * Bounded pool for vegetation buffers.
 *
 * Same contract as {@link RenderBufferPool} in `./renderSnapshot`, minus the
 * per-entity columns: two buffers are enough because the cadence is a few Hz,
 * and a skipped vegetation update is invisible — the previous field stays on
 * screen until the next one lands.
 */
export class VegetationBufferPool {
  readonly gridSize: number;
  readonly maxBuffers: number;

  readonly #idle: ArrayBuffer[] = [];
  #created = 0;
  #inFlight = 0;
  #dropped = 0;

  constructor(gridSize: number, maxBuffers = 2) {
    if (!Number.isSafeInteger(maxBuffers) || maxBuffers < 1) {
      throw new FieldSnapshotFormatError(
        `vegetation buffer pool needs at least one buffer, got ${maxBuffers}`,
      );
    }
    this.gridSize = gridSize;
    this.maxBuffers = maxBuffers;
    this.#idle.push(createVegetationBuffer(gridSize));
    this.#created = 1;
  }

  get idle(): number {
    return this.#idle.length;
  }

  get created(): number {
    return this.#created;
  }

  get droppedSnapshots(): number {
    return this.#dropped;
  }

  /** Buffers currently transferred to the consumer. */
  get inFlight(): number {
    return this.#inFlight;
  }

  acquire(): ArrayBuffer | null {
    const pooled = this.#idle.pop();
    if (pooled !== undefined) {
      this.#inFlight += 1;
      return pooled;
    }
    if (this.#created < this.maxBuffers) {
      this.#created += 1;
      this.#inFlight += 1;
      return createVegetationBuffer(this.gridSize);
    }
    this.#dropped += 1;
    return null;
  }

  /** Same counter discipline as `RenderBufferPool.release`; see the note there. */
  release(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength === 0) {
      if (this.#inFlight > 0) {
        this.#inFlight -= 1;
        this.#created -= 1;
      }
      return false;
    }
    try {
      if (viewVegetationSnapshot(buffer).gridSize !== this.gridSize) {
        return false;
      }
    } catch {
      return false;
    }
    if (this.#inFlight > 0) {
      this.#inFlight -= 1;
    }
    this.#idle.push(buffer);
    return true;
  }
}
