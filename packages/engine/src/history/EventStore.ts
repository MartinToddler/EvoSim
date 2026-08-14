import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";

/**
 * World event types (docs/05 §§12–13, task I06).
 *
 * The numbering is a storage contract: it is hashed, serialized and crosses the
 * protocol. `PlayerIntervention` is reserved here so Milestone 9 does not have
 * to renumber anything.
 */
export const WorldEventType = {
  WorldCreated: 0,
  SpeciesSplit: 1,
  SpeciesExtinct: 2,
  PopulationBoom: 3,
  PopulationCrash: 4,
  FirstPredation: 5,
  CarnivoreLineageDetected: 6,
  MassExtinction: 7,
  PopulationCapReached: 8,
  PlayerIntervention: 9,
} as const;

export type WorldEventType = (typeof WorldEventType)[keyof typeof WorldEventType];

export const WORLD_EVENT_TYPE_COUNT = 10;

/** Human-readable event type names, indexed by type value. Diagnostics/DTOs. */
export const WORLD_EVENT_TYPE_NAMES: readonly string[] = [
  "worldCreated",
  "speciesSplit",
  "speciesExtinct",
  "populationBoom",
  "populationCrash",
  "firstPredation",
  "carnivoreLineageDetected",
  "massExtinction",
  "populationCapReached",
  "playerIntervention",
];

/** Event severity (docs/05 §12). Numeric here; the protocol maps to names. */
export const EventSeverity = {
  Info: 0,
  Notable: 1,
  Major: 2,
} as const;

export type EventSeverity = (typeof EventSeverity)[keyof typeof EventSeverity];

export const EVENT_SEVERITY_NAMES: readonly string[] = ["info", "notable", "major"];

/**
 * One timeline event (docs/05 §12).
 *
 * Every field is a plain integer or an array of them — nothing here needs a
 * string or a nested object, which keeps hashing and serialization exact. The
 * optional region is flattened to three fields with `regionRadiusPos === -1`
 * meaning "no region".
 *
 * `payload` is the versioned payload of docs/05 §12 reduced to numbers; what
 * each position means is defined per type in eventDetection.ts and mirrored by
 * the protocol DTO layer.
 */
export interface WorldEventRecord {
  readonly id: number;
  readonly tick: number;
  readonly type: WorldEventType;
  readonly severity: EventSeverity;
  readonly speciesIds: readonly number[];
  readonly entityIds: readonly number[];
  /** World sub-units; -1 radius means the event has no region. */
  readonly regionXPos: number;
  readonly regionYPos: number;
  readonly regionRadiusPos: number;
  readonly payloadVersion: number;
  readonly payload: readonly number[];
}

/** Fields a caller provides; id is assigned by the store, region defaults to none. */
export interface WorldEventInput {
  tick: number;
  type: WorldEventType;
  severity: EventSeverity;
  speciesIds?: readonly number[];
  entityIds?: readonly number[];
  regionXPos?: number;
  regionYPos?: number;
  regionRadiusPos?: number;
  payloadVersion: number;
  payload: readonly number[];
}

/** Serializable event log state. */
export interface EventStoreSnapshot {
  nextEventId: number;
  droppedEventCount: number;
  events: WorldEventRecord[];
}

/** Error thrown when an event snapshot cannot be restored. */
export class EventSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventSnapshotError";
  }
}

/**
 * The append-only world event log (docs/05 §12, task I06).
 *
 * ## Memory bound
 *
 * The log keeps at most `limits.maxTimelineEventsInMemoryBeforeChunk` events.
 * When a new event would exceed that, the OLDEST events are dropped and
 * counted, keeping the most recent window intact — the timeline UI degrades at
 * the far past, never at the present. Milestone 10 (persistence) will chunk
 * events out to storage before they are dropped; the counter is what makes any
 * loss visible until then. Event detection never reads the log — detector
 * state lives in EventDetectors — so dropping old events can never change
 * which future events fire.
 *
 * ## Determinism
 *
 * Emission order inside a tick follows the authoritative phase order, and
 * every detector is deterministic, so event IDs are as reproducible as any
 * other authoritative value. The log is hashed (IDs, ticks, types, payloads)
 * to make that reproducibility testable.
 */
export class EventStore {
  readonly #capacity: number;
  #events: WorldEventRecord[] = [];
  #nextEventId = 1;
  #droppedEventCount = 0;

  constructor(capacity: number) {
    assert(
      Number.isSafeInteger(capacity) && capacity > 0,
      `event capacity must be positive, got ${capacity}`,
    );
    this.#capacity = capacity;
  }

  /** Events currently retained, oldest first. Do not mutate. */
  get events(): readonly WorldEventRecord[] {
    return this.#events;
  }

  /** ID the next appended event will receive. */
  get nextEventId(): number {
    return this.#nextEventId;
  }

  /** ID of the newest event, or 0 when none has ever been emitted. */
  get latestEventId(): number {
    return this.#nextEventId - 1;
  }

  /** Events dropped so far to keep the log inside its memory bound. */
  get droppedEventCount(): number {
    return this.#droppedEventCount;
  }

  /** Append one event, assigning its ID. Returns the stored record. */
  append(input: WorldEventInput): WorldEventRecord {
    // Payload entries are SIGNED 32-bit integers by contract since engine
    // 0.7.0: intervention payloads legitimately carry negative values (a
    // cooling brush strength, a negative global offset). The bound is asserted
    // at the one place payloads enter, so hashing them as 32-bit words below
    // can never truncate.
    for (const value of input.payload) {
      assert(
        Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647,
        `event payload entries must be signed 32-bit integers, got ${value}`,
      );
    }
    const record: WorldEventRecord = {
      id: this.#nextEventId,
      tick: input.tick,
      type: input.type,
      severity: input.severity,
      speciesIds: input.speciesIds === undefined ? [] : [...input.speciesIds],
      entityIds: input.entityIds === undefined ? [] : [...input.entityIds],
      regionXPos: input.regionXPos ?? 0,
      regionYPos: input.regionYPos ?? 0,
      regionRadiusPos: input.regionRadiusPos ?? -1,
      payloadVersion: input.payloadVersion,
      payload: [...input.payload],
    };
    this.#nextEventId += 1;
    this.#events.push(record);
    if (this.#events.length > this.#capacity) {
      const excess = this.#events.length - this.#capacity;
      this.#events.splice(0, excess);
      this.#droppedEventCount += excess;
    }
    return record;
  }

  /** Retained events with `id > sinceEventId`, oldest first (protocol backfill). */
  eventsSince(sinceEventId: number): WorldEventRecord[] {
    // The log is ordered by id, so scan back to the boundary instead of
    // filtering the whole array.
    let start = this.#events.length;
    while (start > 0 && (this.#events[start - 1] as WorldEventRecord).id > sinceEventId) {
      start -= 1;
    }
    return this.#events.slice(start);
  }

  /**
   * Feed the event log into the canonical state hash. The retained window,
   * the next ID and the dropped count together pin the log's exact state.
   */
  hashInto(hasher: StateHash): void {
    hasher.word(this.#capacity);
    hasher.word(this.#nextEventId);
    hasher.safeInteger(this.#droppedEventCount);
    hasher.word(this.#events.length);
    for (const event of this.#events) {
      hasher.word(event.id);
      hasher.safeInteger(event.tick);
      hasher.word(event.type);
      hasher.word(event.severity);
      hasher.array(HASH_TAG.u32, event.speciesIds);
      hasher.array(HASH_TAG.u32, event.entityIds);
      hasher.word(event.regionXPos);
      hasher.word(event.regionYPos);
      hasher.word(event.regionRadiusPos);
      hasher.word(event.payloadVersion);
      hasher.word(event.payload.length);
      for (const value of event.payload) {
        // Signed 32-bit by the append contract; the word hash keeps the
        // two's-complement bit pattern, so -1 and 4294967295 cannot collide
        // with each other's neighbours the way a truncating cast would.
        hasher.word(value | 0);
      }
    }
  }

  /** Capture the log for a snapshot. Records are immutable, so sharing is safe. */
  capture(): EventStoreSnapshot {
    return {
      nextEventId: this.#nextEventId,
      droppedEventCount: this.#droppedEventCount,
      events: [...this.#events],
    };
  }

  /** Drop everything and restore from a snapshot. */
  restore(snapshot: EventStoreSnapshot): void {
    if (!Number.isSafeInteger(snapshot.nextEventId) || snapshot.nextEventId < 1) {
      throw new EventSnapshotError(`restored nextEventId out of range: ${snapshot.nextEventId}`);
    }
    if (snapshot.events.length > this.#capacity) {
      throw new EventSnapshotError(
        `snapshot retains ${snapshot.events.length} events, capacity is ${this.#capacity}`,
      );
    }
    let previousId = 0;
    for (const event of snapshot.events) {
      if (!Number.isSafeInteger(event.id) || event.id <= previousId) {
        throw new EventSnapshotError(`event ids are not strictly increasing at ${event.id}`);
      }
      if (event.id >= snapshot.nextEventId) {
        throw new EventSnapshotError(
          `event ${event.id} was never issued (nextEventId ${snapshot.nextEventId})`,
        );
      }
      previousId = event.id;
      for (const value of event.payload) {
        if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
          throw new EventSnapshotError(
            `event ${event.id} payload entry ${value} is outside the signed 32-bit contract`,
          );
        }
      }
    }
    this.#nextEventId = snapshot.nextEventId;
    this.#droppedEventCount = snapshot.droppedEventCount;
    this.#events = snapshot.events.map((event) => ({
      id: event.id,
      tick: event.tick,
      type: event.type,
      severity: event.severity,
      speciesIds: [...event.speciesIds],
      entityIds: [...event.entityIds],
      regionXPos: event.regionXPos,
      regionYPos: event.regionYPos,
      regionRadiusPos: event.regionRadiusPos,
      payloadVersion: event.payloadVersion,
      payload: [...event.payload],
    }));
  }
}
