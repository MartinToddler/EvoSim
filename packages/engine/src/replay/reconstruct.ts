import { SimulationEngine } from "../SimulationEngine";
import type { CommandLogSnapshot } from "../commands/CommandLog";
import type { EngineCoreSnapshot } from "../snapshot/EngineSnapshot";

/**
 * Historical reconstruction (Milestone 11, tasks K07–K09; docs/06 §24).
 *
 * THE MODEL
 *
 *   state at tick T = nearest save at tick S <= T
 *                   + the command log that save carries
 *                   + deterministic forward simulation of (T - S) ticks
 *
 * No full state is stored per tick. Saves are periodic; everything between them
 * is recomputed, which is sound only because authoritative state is a pure
 * function of (seed, config, commands, engine version) — the contract every
 * other rule in CLAUDE.md exists to protect.
 *
 * TICK SEMANTICS (already fixed by Milestone 9; restated because rewind is
 * where an off-by-one would do its damage)
 *
 * `step()` applies the commands targeting the current tick, runs the phases,
 * then increments. So "state at tick T" means: T completed steps, every command
 * with `tick < T` applied, no command with `tick >= T` applied. Therefore:
 *
 * - a save taken at tick S holds the state BEFORE S's commands run;
 * - replay from S to T is exactly `T - S` steps;
 * - those steps apply the commands targeting `[S, T-1]`;
 * - a command targeting exactly T is NOT applied — it belongs to the step that
 *   leaves T;
 * - reconstructing a tick that has its own save replays nothing at all.
 *
 * `SimulationEngine.fromSnapshot` already enforces the matching invariant on
 * the restored log: applied commands target ticks before the snapshot tick,
 * pending ones target it or later.
 *
 * This module is pure and synchronous. Choosing which save to load, yielding to
 * an event loop and discarding stale requests are host concerns and live in the
 * Worker host and the persistence layer.
 */

/** Error thrown when a historical state cannot be reconstructed. */
export class ReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconstructionError";
  }
}

/** Progress of a replay in flight. Wall-clock free by construction. */
export interface ReconstructionProgress {
  /** Tick of the save the replay started from. */
  fromTick: number;
  targetTick: number;
  currentTick: number;
  ticksReplayed: number;
  ticksTotal: number;
}

export interface ReconstructionOptions {
  /** The save payload to restore. */
  snapshot: EngineCoreSnapshot;
  targetTick: number;
  /**
   * The world line's FULL command log — normally the live engine's — so the
   * replay applies every command the real history applied, not just the ones
   * the base save happened to know about (docs/06 §24 step 3).
   *
   * A save taken at tick S carries only the commands accepted by then. A
   * command accepted later but targeting a tick inside the replay window would
   * otherwise be silently omitted, and the reconstruction would show a past
   * that never happened — a meteor dropped since the last autosave would be
   * missing from the very preview meant to revisit it. The log is append-only
   * and every save embeds its prefix, so the live log is authoritative for
   * every save of the same world line; the adoption validates that containment
   * rather than assuming it.
   *
   * Omitted, the replay runs on the save's own log alone — correct only when
   * no command was accepted after the save, which is what the engine-only
   * tests use.
   */
  authoritativeLog?: CommandLogSnapshot;
}

/**
 * Replace `engine`'s restored command log with the world line's full log,
 * re-cursored to the engine's tick.
 *
 * The invariant this preserves is the tick convention above: commands
 * targeting ticks before the engine's current tick form the applied prefix,
 * everything else is pending. The engine's own log MUST be contained in the
 * adopted one — same id, tick and sequence for every command — or the adopted
 * log belongs to a different world line and replaying it would fabricate
 * history rather than reproduce it.
 */
function adoptAuthoritativeLog(engine: SimulationEngine, log: CommandLogSnapshot): void {
  const byId = new Map(log.commands.map((command) => [command.id, command]));
  for (const own of engine.commands.list()) {
    const adopted = byId.get(own.id);
    if (adopted === undefined || adopted.tick !== own.tick || adopted.sequence !== own.sequence) {
      throw new ReconstructionError(
        `the supplied command log does not contain command ${own.id} (tick ${own.tick}, ` +
          `sequence ${own.sequence}) from the save's own log; it belongs to a different world line`,
      );
    }
  }

  let cursor = 0;
  while (cursor < log.commands.length && (log.commands[cursor]?.tick ?? Infinity) < engine.tick) {
    cursor += 1;
  }
  engine.commands.restore({
    nextCommandId: log.nextCommandId,
    nextSequence: log.nextSequence,
    cursor,
    commands: log.commands,
  });
}

/**
 * A reconstruction in progress: a fresh engine restored from a save, plus the
 * bookkeeping to walk it forward in slices.
 *
 * Resumable rather than one-shot so the Worker can yield between slices —
 * replaying tens of thousands of ticks in one synchronous call would freeze the
 * Worker, stall the message port, and make progress reporting impossible. The
 * stepping itself stays inside the engine, so yielding cannot change the
 * result: the host chooses WHEN ticks run, never HOW.
 */
export class Reconstruction {
  /**
   * The engine being replayed.
   *
   * Always built fresh from the save payload — never a caller's live engine.
   * That is what makes a historical view structurally incapable of touching the
   * present: there is no path from here to the live world's state.
   */
  readonly engine: SimulationEngine;
  readonly fromTick: number;
  readonly targetTick: number;

  constructor(options: ReconstructionOptions) {
    const { snapshot, targetTick } = options;

    if (!Number.isSafeInteger(targetTick) || targetTick < 0) {
      throw new ReconstructionError(
        `target tick must be a non-negative safe integer, got ${targetTick}`,
      );
    }
    if (targetTick < snapshot.tick) {
      throw new ReconstructionError(
        `cannot replay backwards: the save is at tick ${snapshot.tick}, the target is ` +
          `${targetTick}. Reconstruction only ever moves forward from an earlier save.`,
      );
    }

    this.engine = SimulationEngine.fromSnapshot(snapshot);
    if (options.authoritativeLog !== undefined) {
      adoptAuthoritativeLog(this.engine, options.authoritativeLog);
    }
    this.fromTick = this.engine.tick;
    this.targetTick = targetTick;
  }

  get done(): boolean {
    return this.engine.tick >= this.targetTick;
  }

  get progress(): ReconstructionProgress {
    return {
      fromTick: this.fromTick,
      targetTick: this.targetTick,
      currentTick: this.engine.tick,
      ticksReplayed: this.engine.tick - this.fromTick,
      ticksTotal: this.targetTick - this.fromTick,
    };
  }

  /** Replay at most `maxTicks` further ticks. Returns true once the target is reached. */
  advance(maxTicks: number): boolean {
    const remaining = this.targetTick - this.engine.tick;
    if (remaining > 0) {
      this.engine.stepMany(Math.min(Math.max(1, maxTicks), remaining));
    }
    if (this.engine.tick > this.targetTick) {
      // Unreachable unless stepMany breaks its contract. Asserted rather than
      // assumed because every guarantee downstream — the preview, the branch
      // point, the equivalence hash — rests on landing exactly on T.
      throw new ReconstructionError(
        `reconstruction overshot tick ${this.targetTick} and landed on ${this.engine.tick}`,
      );
    }
    return this.done;
  }
}

export interface ReconstructAtOptions extends ReconstructionOptions {
  /** Called once before any work, then after every slice. */
  onProgress?: (progress: ReconstructionProgress) => void;
  /** Ticks per slice. Reporting granularity only; never affects the result. */
  sliceTicks?: number;
}

const DEFAULT_SLICE_TICKS = 500;

/** Synchronous driver — reconstruct in one call (tests, headless, fixtures). */
export function reconstructAt(options: ReconstructAtOptions): SimulationEngine {
  const reconstruction = new Reconstruction(options);
  const slice = Math.max(1, options.sliceTicks ?? DEFAULT_SLICE_TICKS);

  // Reported up front so a caller always sees a 0-of-N state, including the
  // zero-work case where the target already has its own save.
  options.onProgress?.(reconstruction.progress);

  while (!reconstruction.done) {
    reconstruction.advance(slice);
    options.onProgress?.(reconstruction.progress);
  }

  return reconstruction.engine;
}

/**
 * Turn a save of the state at tick B into the origin save of a branch
 * (task K10, docs/06 §30).
 *
 * A branch inherits its parent's history **only through the branch point**, so
 * the pending suffix of the command log is dropped. Those commands target ticks
 * at or after B — the restore invariant guarantees it — which makes them part
 * of the parent's *future*, not of the history the branch inherits. A player
 * who queued a meteor for tick B+100 and then branched at B did not ask for
 * that meteor in the new world.
 *
 * What is deliberately KEPT is the identity counters (`nextCommandId`,
 * `nextSequence`). Continuing them means a branch's own commands can never
 * collide with an inherited id or sequence, so the two worlds' logs stay
 * comparable and a merged view of both histories is unambiguous.
 *
 * The applied prefix is untouched, so a branch with no commands of its own
 * replays exactly the history its parent replayed — which is what makes the
 * equivalence property in the Milestone 11 acceptance test exact.
 *
 * The returned snapshot shares typed arrays with `snapshot`; it is meant to be
 * encoded or restored immediately, from a snapshot the caller just serialized.
 */
export function prepareBranchSnapshot(
  snapshot: EngineCoreSnapshot,
  branchTick: number,
): EngineCoreSnapshot {
  if (snapshot.tick !== branchTick) {
    throw new ReconstructionError(
      `branch save is at tick ${snapshot.tick} but the branch point is ${branchTick}; a branch ` +
        "must start from the exact state it claims",
    );
  }

  const log = snapshot.commands;
  const inherited = log.commands.slice(0, log.cursor);

  return {
    ...snapshot,
    commands: {
      nextCommandId: log.nextCommandId,
      nextSequence: log.nextSequence,
      cursor: log.cursor,
      commands: inherited,
    },
  };
}
