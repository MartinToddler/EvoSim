/**
 * Save/load orchestration for the app shell (Milestone 10, tasks K04/K05).
 *
 * This is the piece that knows *when* to persist and what to tell the user; it
 * owns neither the bytes (the Worker serializes those) nor the database (the
 * `WorldStore` in `@eon/persistence` owns that). Three layers, three jobs:
 *
 * ```text
 *   Worker   engine -> durable bytes            (REQUEST_SAVE / SNAPSHOT_DATA)
 *   here     when to save, which world, status  (this file)
 *   store    rows, transactions, retention      (@eon/persistence)
 * ```
 *
 * ## Autosave is armed, not automatic
 *
 * A world starts unbound: it has no row in the database and autosave does
 * nothing. Pressing Save (or loading a stored world) binds the session to a
 * world id, and only then does autosave begin, every
 * `hostRuntime.autosaveCheckInterval` ticks. Opening the page must not quietly
 * fill a user's storage quota with worlds they never asked to keep; once they
 * have said "keep this one", keeping it current is exactly what they asked for.
 *
 * ## Saving cannot change the simulation
 *
 * Nothing here touches the engine. A save is a request for bytes the Worker
 * produces by reading state it already has, so an autosave firing at tick
 * 4 000 cannot alter what happens at tick 4 001 (see `SimulationHost`). Which
 * also means autosave cadence is a host setting, not a simulation constant —
 * changing it changes no world hash.
 */

import type { SimulationSpeed } from "@eon/protocol";
import {
  PersistenceError,
  WorldStore,
  describePersistenceError,
  selectSaveForTick,
  type StoredWorld,
  type WorldStore as WorldStoreType,
} from "@eon/persistence";
import type { WorkerClient } from "../worker/WorkerClient";
import { requestPersistentStorage, type StoragePersistence } from "./storagePersistence";

/** What the UI shows about storage, as one immutable object. */
export interface PersistenceStatus {
  /** Set once this session is bound to a stored world. */
  worldId: string | null;
  worldName: string | null;
  /** True while a save or load is in flight; the UI disables its buttons. */
  busy: boolean;
  /** Autosave runs only for a bound world. */
  autosaveArmed: boolean;
  /** Tick of the newest successful save of this session, if any. */
  lastSavedTick: number | null;
  lastSavedAtIso: string | null;
  /** Last outcome, phrased for a human. */
  message: string;
  /** True when {@link message} describes a failure. */
  failed: boolean;
  /**
   * Whether the browser exempts saved worlds from eviction (task M07).
   *
   * `null` until this session has saved something and asked — the question is
   * only worth putting to the browser once the user has chosen to keep a world.
   */
  storagePersistence: StoragePersistence | null;
}

const IDLE_STATUS: PersistenceStatus = Object.freeze({
  worldId: null,
  worldName: null,
  busy: false,
  autosaveArmed: false,
  lastSavedTick: null,
  lastSavedAtIso: null,
  message: "Not saved yet",
  failed: false,
  storagePersistence: null,
});

/**
 * Where historical navigation stands (Milestone 11).
 *
 * Separate from {@link PersistenceStatus} because it answers a different
 * question: that one says whether the world is safely stored, this one says
 * which tick is on screen.
 */
export interface HistoricalStatus {
  mode: "live" | "reconstructing" | "historical";
  /** Tick being reconstructed or previewed; null in the present. */
  tick: number | null;
  /** Tick the live world is paused at while a preview is open. */
  presentTick: number | null;
  /** Replay progress, or null when nothing is replaying. */
  progress: { ticksReplayed: number; ticksTotal: number } | null;
  message: string;
  failed: boolean;
}

const LIVE_HISTORICAL_STATUS: HistoricalStatus = Object.freeze({
  mode: "live" as const,
  tick: null,
  presentTick: null,
  progress: null,
  message: "",
  failed: false,
});

export interface WorldPersistenceOptions {
  client: WorkerClient;
  /** App build identifier, recorded in every manifest. */
  appVersion: string;
  onStatus: (status: PersistenceStatus) => void;
  onWorldsChanged: (worlds: readonly StoredWorld[]) => void;
  /** Historical mode changes: entering, progress, leaving, failing. */
  onHistorical?: (status: HistoricalStatus) => void;
  /** Test seam: supply a store backed by a fake IndexedDB. */
  createStore?: () => WorldStoreType;
}

export class WorldPersistence {
  readonly #options: WorldPersistenceOptions;
  readonly #store: WorldStore;
  #status: PersistenceStatus = IDLE_STATUS;
  /** Ticks between autosaves; 0 disables. Set from the host runtime config. */
  #autosaveInterval = 0;
  /** Tick of the last autosave attempt, so cadence survives speed changes. */
  #lastAutosaveTick = 0;
  #inFlight = false;
  #historical: HistoricalStatus = LIVE_HISTORICAL_STATUS;
  /**
   * Token of the newest rewind request.
   *
   * A scrubber asks for ticks far faster than a replay can answer, so an older
   * request can resolve after a newer one and install a state nobody asked to
   * see. Every request captures the token it was issued under and discards its
   * own result — and its own progress reports — once it is no longer the newest.
   */
  #rewindToken = 0;
  /** Worker request id of the rewind whose progress is worth showing. */
  #activeRewindRequestId = -1;
  /** The save or load currently running, so a manual save can wait for it. */
  #current: Promise<unknown> = Promise.resolve();
  #disposed = false;

  constructor(options: WorldPersistenceOptions) {
    this.#options = options;
    this.#store = options.createStore?.() ?? new WorldStore();
  }

  get status(): PersistenceStatus {
    return this.#status;
  }

  /**
   * Bind autosave cadence to the host's runtime config, and forget any world
   * identity when a *new* world is created (a fresh world is not a save of the
   * previous one, and must not overwrite it).
   */
  onWorldReady(autosaveCheckInterval: number, options: { keepBinding: boolean }): void {
    this.#autosaveInterval = autosaveCheckInterval;
    this.#lastAutosaveTick = 0;
    if (!options.keepBinding) {
      this.#update({ ...IDLE_STATUS });
    }
  }

  /**
   * Ask the browser to exempt saved worlds from eviction, at most once per
   * session (task M07, docs/02 §20).
   *
   * Deliberately fire-and-forget: the answer changes what the UI *says*, never
   * whether the save succeeded, and a browser that never answers must not leave
   * a save looking unfinished.
   */
  async #ensureStoragePersistence(): Promise<void> {
    if (this.#disposed || this.#status.storagePersistence !== null) {
      return;
    }
    const state = await requestPersistentStorage(globalThis.navigator?.storage);
    if (!this.#disposed) {
      this.#update({ ...this.#status, storagePersistence: state });
    }
  }

  /** Called at telemetry cadence; fires an autosave when one is due. */
  onTelemetryTick(tick: number): void {
    if (
      this.#disposed ||
      this.#inFlight ||
      this.#autosaveInterval <= 0 ||
      this.#status.worldId === null ||
      tick - this.#lastAutosaveTick < this.#autosaveInterval
    ) {
      return;
    }
    this.#lastAutosaveTick = tick;
    void this.save({ kind: "autosave" });
  }

  /** Every stored world, newest first. */
  async refresh(): Promise<readonly StoredWorld[]> {
    try {
      const worlds = await this.#store.listWorlds();
      this.#options.onWorldsChanged(worlds);
      return worlds;
    } catch (error) {
      this.#update({ ...this.#status, message: describePersistenceError(error), failed: true });
      return [];
    }
  }

  /**
   * Save the running world.
   *
   * The Worker produces the bytes; this writes them. A failure at either step
   * leaves the previous save untouched (see `WorldStore`), and says so.
   */
  async save(options: { kind: "manual" | "autosave"; name?: string }): Promise<boolean> {
    if (this.#disposed) {
      return false;
    }
    if (this.#inFlight && options.kind === "autosave") {
      // An autosave that collides with anything is simply redundant: the next
      // one is due in a couple of thousand ticks and will capture more.
      return false;
    }
    // A manual save is not redundant. It is an explicit act, it may carry a
    // rename, and the click that started it has already been acknowledged in
    // the UI — dropping it because an autosave happened to be in flight would
    // discard both the save and the new name without telling anyone. Wait for
    // whatever is running and then take it.
    while (this.#inFlight) {
      await this.#current.catch(() => undefined);
      if (this.#disposed) {
        return false;
      }
    }
    const run = this.#saveNow(options);
    this.#current = run;
    return await run;
  }

  async #saveNow(options: { kind: "manual" | "autosave"; name?: string }): Promise<boolean> {
    this.#inFlight = true;
    this.#update({
      ...this.#status,
      busy: true,
      message: options.kind === "autosave" ? "Autosaving…" : "Saving…",
      failed: false,
    });

    try {
      const payload = await this.#options.client.requestSave(options.kind);
      const worldName = options.name ?? this.#status.worldName ?? defaultWorldName(payload.seed);
      const result = await this.#store.save({
        ...(this.#status.worldId === null ? {} : { worldId: this.#status.worldId }),
        worldName,
        kind: options.kind,
        bytes: new Uint8Array(payload.buffer),
        appVersion: this.#options.appVersion,
        configSchemaVersion: payload.snapshotSchemaVersion,
      });

      this.#update({
        worldId: result.manifest.worldId,
        worldName: result.manifest.worldName,
        busy: false,
        autosaveArmed: this.#autosaveInterval > 0,
        lastSavedTick: result.save.tick,
        lastSavedAtIso: result.save.savedAtIso,
        message:
          options.kind === "autosave"
            ? `Autosaved at tick ${result.save.tick.toLocaleString()}`
            : `Saved “${result.manifest.worldName}” at tick ${result.save.tick.toLocaleString()}`,
        failed: false,
        storagePersistence: this.#status.storagePersistence,
      });
      void this.refresh();
      // Now that the user has kept something, it is worth asking the browser to
      // stop evicting it (task M07). Once per session, after the first save,
      // and never on the critical path of the save itself.
      void this.#ensureStoragePersistence();
      return true;
    } catch (error) {
      this.#update({
        ...this.#status,
        busy: false,
        message: `Save failed: ${describePersistenceError(error)}`,
        failed: true,
      });
      return false;
    } finally {
      this.#inFlight = false;
    }
  }

  /**
   * Load a stored world into the running Worker.
   *
   * The bytes are transferred to the Worker, so the copy read out of the
   * database is handed over whole. If the Worker refuses them the currently
   * running world keeps running and the error is reported here; success
   * arrives as an ordinary WORLD_READY.
   */
  async load(worldId: string, speed: SimulationSpeed, snapshotId?: string): Promise<boolean> {
    if (this.#disposed || this.#inFlight) {
      return false;
    }
    this.#inFlight = true;
    const done = this.#loadNow(worldId, speed, snapshotId);
    this.#current = done;
    return await done;
  }

  async #loadNow(worldId: string, speed: SimulationSpeed, snapshotId?: string): Promise<boolean> {
    this.#update({ ...this.#status, busy: true, message: "Loading…", failed: false });
    try {
      // The store validates as it reads, so a damaged newest save is detected
      // here and an older one is chosen — that decision needs the decode. The
      // Worker is then handed the *stored bytes*, not the decoded state, and
      // validates them again on its own side of the port: the build that will
      // run the world is the build that checks it.
      const result = await this.#store.load(worldId, snapshotId);
      this.#options.client.loadWorld({ snapshot: result.bytes, speed });
      await this.#store.touch(worldId);

      const fallback =
        result.rejected.length === 0
          ? ""
          : ` (fell back past ${result.rejected.length} unreadable save${
              result.rejected.length === 1 ? "" : "s"
            })`;
      this.#update({
        worldId,
        worldName: result.manifest.worldName,
        busy: false,
        autosaveArmed: this.#autosaveInterval > 0,
        lastSavedTick: result.save.tick,
        lastSavedAtIso: result.save.savedAtIso,
        message: `Loaded “${result.manifest.worldName}” at tick ${result.save.tick.toLocaleString()}${fallback}`,
        failed: false,
        storagePersistence: this.#status.storagePersistence,
      });
      this.#lastAutosaveTick = result.save.tick;
      void this.refresh();
      // Now that the user has kept something, it is worth asking the browser to
      // stop evicting it (task M07). Once per session, after the first save,
      // and never on the critical path of the save itself.
      void this.#ensureStoragePersistence();
      return true;
    } catch (error) {
      this.#update({
        ...this.#status,
        busy: false,
        message: `Load failed: ${describePersistenceError(error)}`,
        failed: true,
      });
      void this.refresh();
      return false;
    } finally {
      this.#inFlight = false;
    }
  }

  // --- Historical mode (Milestone 11, tasks K07-K10) --------------------------

  get historical(): HistoricalStatus {
    return this.#historical;
  }

  /** Progress from the Worker, ignored once its request has been superseded. */
  reportRewindProgress(
    progress: { ticksReplayed: number; ticksTotal: number },
    requestId: number,
  ): void {
    if (requestId !== this.#activeRewindRequestId || this.#historical.mode !== "reconstructing") {
      return;
    }
    this.#updateHistorical({ ...this.#historical, progress });
  }

  /**
   * Reconstruct `targetTick` and enter historical mode.
   *
   * The save is chosen here because only this side can see the database: the
   * newest one at or before the target, by the rule in `selectSaveForTick`. A
   * world with no save that early cannot be rewound there at all, and says so
   * rather than silently landing somewhere else.
   */
  async rewindTo(targetTick: number, presentTick?: number): Promise<boolean> {
    const worldId = this.#status.worldId;
    if (this.#disposed || worldId === null) {
      this.#updateHistorical({
        ...LIVE_HISTORICAL_STATUS,
        message: "Save this world before exploring its history",
        failed: true,
      });
      return false;
    }

    const token = ++this.#rewindToken;
    this.#updateHistorical({
      mode: "reconstructing",
      tick: targetTick,
      // The caller saw the live world last; while previewing, the Worker's
      // telemetry describes the historical engine, so this is the only honest
      // "present" the UI can show during the reconstruction (ADR 0025).
      presentTick: presentTick ?? this.#historical.presentTick,
      progress: { ticksReplayed: 0, ticksTotal: 0 },
      message: `Reconstructing tick ${targetTick.toLocaleString()}…`,
      failed: false,
    });

    try {
      const worlds = await this.#store.listWorlds();
      const stored = worlds.find((world) => world.manifest.worldId === worldId);
      const save = selectSaveForTick(stored?.saves ?? [], targetTick);
      if (save === null) {
        throw new PersistenceError(
          "not-found",
          `no save at or before tick ${targetTick.toLocaleString()}`,
        );
      }

      const loaded = await this.#store.load(worldId, save.snapshotId);
      if (token !== this.#rewindToken) {
        return false;
      }

      const ready = await this.#options.client.requestRewind(loaded.bytes, targetTick, (id) => {
        this.#activeRewindRequestId = id;
      });
      if (token !== this.#rewindToken) {
        // A newer rewind is already running or the user returned to the
        // present. Its answer owns the screen, not this one.
        return false;
      }

      this.#updateHistorical({
        mode: "historical",
        tick: ready.tick,
        presentTick: ready.presentTick,
        progress: null,
        message: `Viewing tick ${ready.tick.toLocaleString()} of ${ready.presentTick.toLocaleString()}`,
        failed: false,
      });
      return true;
    } catch (error) {
      if (token !== this.#rewindToken) {
        return false;
      }
      this.#updateHistorical({
        ...LIVE_HISTORICAL_STATUS,
        message: `Rewind failed: ${describePersistenceError(error)}`,
        failed: true,
      });
      return false;
    }
  }

  /** Leave historical mode; any rewind still in flight stops mattering. */
  returnToPresent(): void {
    if (this.#historical.mode === "live") {
      return;
    }
    this.#rewindToken += 1;
    this.#activeRewindRequestId = -1;
    this.#options.client.returnToPresent();
    this.#updateHistorical({ ...LIVE_HISTORICAL_STATUS, message: "Back in the present" });
  }

  /**
   * Branch the open preview into a new world.
   *
   * The Worker produces the origin bytes; this side writes them under a NEW
   * manifest that records the parent and the branch tick. The source world is
   * never written to, which is what makes branching safe to try.
   */
  async createBranch(name: string): Promise<string | null> {
    const parentWorldId = this.#status.worldId;
    const branchTick = this.#historical.tick;
    if (this.#disposed || parentWorldId === null || this.#historical.mode !== "historical") {
      return null;
    }

    this.#updateHistorical({
      ...this.#historical,
      message: `Branching at tick ${(branchTick ?? 0).toLocaleString()}…`,
    });

    try {
      const origin = await this.#options.client.createBranch(branchTick ?? 0);
      const saved = await this.#store.save({
        worldName: name,
        kind: "branch",
        bytes: new Uint8Array(origin.buffer),
        appVersion: this.#options.appVersion,
        configSchemaVersion: origin.snapshotSchemaVersion,
        branchedFrom: { parentWorldId, branchTick: origin.tick },
      });

      this.#updateHistorical({
        ...this.#historical,
        message: `Branched “${name}” at tick ${origin.tick.toLocaleString()}`,
        failed: false,
      });
      void this.refresh();
      return saved.manifest.worldId;
    } catch (error) {
      this.#updateHistorical({
        ...this.#historical,
        message: `Branch failed: ${describePersistenceError(error)}`,
        failed: true,
      });
      return null;
    }
  }

  #updateHistorical(status: HistoricalStatus): void {
    this.#historical = status;
    this.#options.onHistorical?.(status);
  }

  /** Delete a stored world. Unbinds the session if it was the one loaded. */
  async deleteWorld(worldId: string): Promise<boolean> {
    if (this.#disposed) {
      return false;
    }
    try {
      await this.#store.deleteWorld(worldId);
      if (this.#status.worldId === worldId) {
        this.#update({ ...IDLE_STATUS, message: "Deleted; this world is no longer stored" });
      } else {
        this.#update({ ...this.#status, message: "Deleted", failed: false });
      }
      void this.refresh();
      // Now that the user has kept something, it is worth asking the browser to
      // stop evicting it (task M07). Once per session, after the first save,
      // and never on the critical path of the save itself.
      void this.#ensureStoragePersistence();
      return true;
    } catch (error) {
      this.#update({
        ...this.#status,
        message: `Delete failed: ${describePersistenceError(error)}`,
        failed: true,
      });
      return false;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#store.close();
  }

  #update(status: PersistenceStatus): void {
    this.#status = Object.freeze(status);
    if (!this.#disposed) {
      this.#options.onStatus(this.#status);
    }
  }
}

/** A world's default name: its seed, which is the one thing that identifies it. */
export function defaultWorldName(seed: number): string {
  return `World 0x${seed.toString(16).toUpperCase().padStart(8, "0")}`;
}
