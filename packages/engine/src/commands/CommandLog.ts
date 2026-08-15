import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";
import {
  BrushFalloff,
  COMMAND_SCHEMA_VERSION,
  InterventionKind,
  isBrushKind,
  type BrushCommand,
  type CommandInput,
  type SimulationCommand,
} from "./SimulationCommand";

/**
 * The authoritative command log (task J01, docs/06 §23, docs/10 §16).
 *
 * Append-only, ordered by `(tick, sequence)`, with a cursor separating applied
 * history from pending commands. The WHOLE log is authoritative state: the
 * applied prefix is the world's immutable intervention history (replay input,
 * docs/06 §24), the pending suffix will change future state, and the cursor is
 * what guarantees a restored world neither re-applies nor skips a command. All
 * of it is hashed and serialized.
 *
 * Commands are frozen at acceptance and never mutated, reordered relative to
 * their `(tick, sequence)` key, or dropped — dropping would break replay, which
 * is the log's reason to exist. Milestone 10 chunks history to storage; until
 * then the in-memory log IS the history.
 */

/** Serializable command-log state (snapshot schema 8). */
export interface CommandLogSnapshot {
  nextCommandId: number;
  nextSequence: number;
  cursor: number;
  commands: SimulationCommand[];
}

/** Error thrown when a command-log snapshot cannot be restored. */
export class CommandLogSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandLogSnapshotError";
  }
}

function freezeCommand(command: SimulationCommand): SimulationCommand {
  if (isBrushKind(command.kind)) {
    const brush = command as BrushCommand;
    Object.freeze(brush.samplesXLU);
    Object.freeze(brush.samplesYLU);
  }
  return Object.freeze(command);
}

export class CommandLog {
  #commands: SimulationCommand[] = [];
  #cursor = 0;
  #nextCommandId = 1;
  #nextSequence = 1;

  /** Total accepted commands, applied and pending. */
  get length(): number {
    return this.#commands.length;
  }

  /** Index of the next command to apply; also the count already applied. */
  get cursor(): number {
    return this.#cursor;
  }

  /** Commands accepted but not yet applied. */
  get pendingCount(): number {
    return this.#commands.length - this.#cursor;
  }

  get nextCommandId(): number {
    return this.#nextCommandId;
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  /** Read one accepted command (applied or pending). */
  at(index: number): SimulationCommand {
    const command = this.#commands[index];
    assert(command !== undefined, `command index ${index} out of range (${this.#commands.length})`);
    return command;
  }

  /** All accepted commands in application order. The array is a copy. */
  list(): SimulationCommand[] {
    return [...this.#commands];
  }

  /**
   * Stamp identity onto a validated input and insert it in application order.
   *
   * `tick` is the target tick decided by the engine (current executable tick,
   * or the input's explicit future tick). The command is inserted before the
   * first PENDING command with a strictly later tick, so the pending suffix
   * stays `(tick, sequence)`-sorted even when a future-targeted command was
   * accepted first. Insertion can never land inside the applied prefix because
   * the engine rejects ticks earlier than the next executable one.
   */
  accept(input: CommandInput, tick: number): SimulationCommand {
    const id = this.#nextCommandId;
    const sequence = this.#nextSequence;
    this.#nextCommandId += 1;
    this.#nextSequence += 1;

    let command: SimulationCommand;
    if (input.kind === InterventionKind.SetGlobalTemperature) {
      command = {
        schemaVersion: COMMAND_SCHEMA_VERSION,
        id,
        tick,
        sequence,
        kind: input.kind,
        offsetCentiC: input.offsetCentiC,
      };
    } else if (input.kind === InterventionKind.Meteor) {
      command = {
        schemaVersion: COMMAND_SCHEMA_VERSION,
        id,
        tick,
        sequence,
        kind: input.kind,
        centerXLU: input.centerXLU,
        centerYLU: input.centerYLU,
        radiusLU: input.radiusLU,
      };
    } else {
      command = {
        schemaVersion: COMMAND_SCHEMA_VERSION,
        id,
        tick,
        sequence,
        kind: input.kind,
        radiusLU: input.radiusLU,
        strength: input.strength,
        falloff: input.falloff,
        samplesXLU: [...input.samplesXLU],
        samplesYLU: [...input.samplesYLU],
      };
    }
    freezeCommand(command);

    let insertAt = this.#commands.length;
    while (
      insertAt > this.#cursor &&
      (this.#commands[insertAt - 1] as SimulationCommand).tick > tick
    ) {
      insertAt -= 1;
    }
    this.#commands.splice(insertAt, 0, command);
    return command;
  }

  /** The next pending command, or null when nothing is pending. */
  peek(): SimulationCommand | null {
    return this.#cursor < this.#commands.length
      ? (this.#commands[this.#cursor] as SimulationCommand)
      : null;
  }

  /** Move the cursor past the command just applied. */
  advance(): void {
    assert(this.#cursor < this.#commands.length, "cannot advance past the end of the command log");
    this.#cursor += 1;
  }

  /**
   * Feed the log into the canonical state hash.
   *
   * Covers identity counters, the cursor and every accepted command — applied
   * history included, because two worlds with different intervention histories
   * are different worlds even when their arrays momentarily agree.
   */
  hashInto(hasher: StateHash): void {
    hasher.word(this.#nextCommandId);
    hasher.word(this.#nextSequence);
    hasher.word(this.#cursor);
    hasher.word(this.#commands.length);
    for (const command of this.#commands) {
      hasher.word(command.schemaVersion);
      hasher.word(command.id);
      hasher.safeInteger(command.tick);
      hasher.word(command.sequence);
      hasher.word(command.kind);
      if (command.kind === InterventionKind.SetGlobalTemperature) {
        hasher.word(command.offsetCentiC | 0);
      } else if (command.kind === InterventionKind.Meteor) {
        hasher.word(command.centerXLU);
        hasher.word(command.centerYLU);
        hasher.word(command.radiusLU);
      } else {
        hasher.word(command.radiusLU);
        hasher.word(command.strength | 0);
        hasher.word(command.falloff);
        hasher.array(HASH_TAG.i32, new Int32Array(command.samplesXLU));
        hasher.array(HASH_TAG.i32, new Int32Array(command.samplesYLU));
      }
    }
  }

  /** Copy the full log state out for serialization. */
  capture(): CommandLogSnapshot {
    return {
      nextCommandId: this.#nextCommandId,
      nextSequence: this.#nextSequence,
      cursor: this.#cursor,
      commands: this.#commands.map((command) => {
        if (isBrushKind(command.kind)) {
          const brush = command as BrushCommand;
          return { ...brush, samplesXLU: [...brush.samplesXLU], samplesYLU: [...brush.samplesYLU] };
        }
        return { ...command };
      }),
    };
  }

  /**
   * Replace this log's state from a snapshot, validating the schema
   * (docs/10 §16: replay revalidates schema, not UI-level bounds).
   *
   * The rules restore enforces are exactly the invariants `accept` maintains:
   * strictly increasing `(tick, sequence)` in array order — which is what makes
   * duplicate sequences and unordered logs unrepresentable — unique positive
   * ids below `nextCommandId`, unique sequences below `nextSequence`, and a
   * cursor inside the log. Payload structure is checked per kind; payload
   * BOUNDS are not re-checked against the config, because the snapshot carries
   * the same config the commands were validated against at acceptance.
   */
  restore(snapshot: CommandLogSnapshot): void {
    if (
      !Number.isSafeInteger(snapshot.nextCommandId) ||
      snapshot.nextCommandId < 1 ||
      !Number.isSafeInteger(snapshot.nextSequence) ||
      snapshot.nextSequence < 1
    ) {
      throw new CommandLogSnapshotError(
        `command log counters must be positive integers, got id ${snapshot.nextCommandId}, ` +
          `sequence ${snapshot.nextSequence}`,
      );
    }
    if (
      !Number.isSafeInteger(snapshot.cursor) ||
      snapshot.cursor < 0 ||
      snapshot.cursor > snapshot.commands.length
    ) {
      throw new CommandLogSnapshotError(
        `command log cursor ${snapshot.cursor} is outside [0, ${snapshot.commands.length}]`,
      );
    }

    const seenIds = new Set<number>();
    const seenSequences = new Set<number>();
    const restored: SimulationCommand[] = [];
    let previous: SimulationCommand | null = null;

    for (let i = 0; i < snapshot.commands.length; i += 1) {
      const command = snapshot.commands[i] as SimulationCommand;
      validateRecordedCommand(command, i, snapshot);
      if (seenIds.has(command.id)) {
        throw new CommandLogSnapshotError(
          `command log entry ${i} duplicates command id ${command.id}`,
        );
      }
      if (seenSequences.has(command.sequence)) {
        throw new CommandLogSnapshotError(
          `command log entry ${i} duplicates sequence ${command.sequence}`,
        );
      }
      seenIds.add(command.id);
      seenSequences.add(command.sequence);
      if (
        previous !== null &&
        (command.tick < previous.tick ||
          (command.tick === previous.tick && command.sequence <= previous.sequence))
      ) {
        throw new CommandLogSnapshotError(
          `command log entry ${i} (tick ${command.tick}, sequence ${command.sequence}) does not ` +
            `follow entry ${i - 1} (tick ${previous.tick}, sequence ${previous.sequence}); the ` +
            "log must be strictly (tick, sequence)-ordered",
        );
      }
      previous = command;
      restored.push(freezeCommand(cloneCommand(command)));
    }

    this.#commands = restored;
    this.#cursor = snapshot.cursor;
    this.#nextCommandId = snapshot.nextCommandId;
    this.#nextSequence = snapshot.nextSequence;
  }
}

function cloneCommand(command: SimulationCommand): SimulationCommand {
  if (isBrushKind(command.kind)) {
    const brush = command as BrushCommand;
    return { ...brush, samplesXLU: [...brush.samplesXLU], samplesYLU: [...brush.samplesYLU] };
  }
  return { ...command };
}

function checkInt(value: unknown, entry: number, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CommandLogSnapshotError(
      `command log entry ${entry} field ${name} must be a safe integer, got ${String(value)}`,
    );
  }
}

function validateRecordedCommand(
  command: SimulationCommand,
  entry: number,
  snapshot: CommandLogSnapshot,
): void {
  if (command === null || typeof command !== "object") {
    throw new CommandLogSnapshotError(`command log entry ${entry} is not an object`);
  }
  const schemaVersion = (command as { schemaVersion: number }).schemaVersion;
  if (schemaVersion !== COMMAND_SCHEMA_VERSION) {
    throw new CommandLogSnapshotError(
      `command log entry ${entry} has schema ${schemaVersion}; this engine ` +
        `speaks command schema ${COMMAND_SCHEMA_VERSION}`,
    );
  }
  checkInt(command.id, entry, "id");
  checkInt(command.tick, entry, "tick");
  checkInt(command.sequence, entry, "sequence");
  if (command.id < 1 || command.id >= snapshot.nextCommandId) {
    throw new CommandLogSnapshotError(
      `command log entry ${entry} id ${command.id} is outside [1, ${snapshot.nextCommandId - 1}]`,
    );
  }
  if (command.sequence < 1 || command.sequence >= snapshot.nextSequence) {
    throw new CommandLogSnapshotError(
      `command log entry ${entry} sequence ${command.sequence} is outside ` +
        `[1, ${snapshot.nextSequence - 1}]`,
    );
  }
  if (command.tick < 0) {
    throw new CommandLogSnapshotError(
      `command log entry ${entry} targets negative tick ${command.tick}`,
    );
  }

  if (command.kind === InterventionKind.SetGlobalTemperature) {
    checkInt(command.offsetCentiC, entry, "offsetCentiC");
    return;
  }
  if (command.kind === InterventionKind.Meteor) {
    checkInt(command.centerXLU, entry, "centerXLU");
    checkInt(command.centerYLU, entry, "centerYLU");
    checkInt(command.radiusLU, entry, "radiusLU");
    return;
  }
  const kind = (command as { kind: number }).kind;
  if (!isBrushKind(kind)) {
    throw new CommandLogSnapshotError(`command log entry ${entry} has unknown kind ${kind}`);
  }
  const brush = command;
  checkInt(brush.radiusLU, entry, "radiusLU");
  checkInt(brush.strength, entry, "strength");
  if (brush.falloff !== BrushFalloff.Linear && brush.falloff !== BrushFalloff.Hard) {
    throw new CommandLogSnapshotError(
      `command log entry ${entry} falloff must be 0 or 1, got ${String(brush.falloff)}`,
    );
  }
  if (!Array.isArray(brush.samplesXLU) || !Array.isArray(brush.samplesYLU)) {
    throw new CommandLogSnapshotError(`command log entry ${entry} samples must be arrays`);
  }
  if (brush.samplesXLU.length !== brush.samplesYLU.length || brush.samplesXLU.length === 0) {
    throw new CommandLogSnapshotError(
      `command log entry ${entry} sample arrays must be parallel and non-empty, got ` +
        `${brush.samplesXLU.length} and ${brush.samplesYLU.length}`,
    );
  }
  for (let i = 0; i < brush.samplesXLU.length; i += 1) {
    checkInt(brush.samplesXLU[i], entry, `samplesXLU[${i}]`);
    checkInt(brush.samplesYLU[i], entry, `samplesYLU[${i}]`);
  }
}
