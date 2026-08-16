import { DEFAULT_CONFIG, SimulationEngine, cloneConfig } from "@eon/engine";
import { encodeDurableSnapshot, WorldStore, type StoredWorld } from "@eon/persistence";
import {
  DEFAULT_HOST_RUNTIME_CONFIG,
  PROTOCOL_VERSION,
  createTerrainBuffer,
  type TelemetryDto,
  type WorldSummaryDto,
} from "@eon/protocol";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { PersistenceStatus } from "./WorldPersistence";
import { WorldSession, type SessionRenderer, type SessionWorker } from "./WorldSession";

/**
 * The app-shell half of Milestone 10: what the *session* does around a save.
 *
 * The Worker is faked (what it computes is covered by `hostM10.test.ts`) and
 * IndexedDB is `fake-indexeddb`, so this exercises the wiring the user actually
 * drives — press Save, see a status, see the world in the list, press Load, see
 * the world replaced — including the rules that only exist here: autosave is
 * armed rather than automatic, a new world does not inherit the previous
 * world's identity, and a load keeps it.
 */

/** The environment digest the fixture world reports on WORLD_READY. */
const FIXTURE_ENVIRONMENT_HASH = "feedfacefeedface";

interface PostedMessage {
  type: string;
  payload: Record<string, unknown>;
  requestId?: number;
}

class FakeWorker implements SessionWorker {
  readonly posted: PostedMessage[] = [];
  terminated = false;
  #listener: ((event: { data: unknown }) => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message as PostedMessage);
  }

  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.#listener = listener;
  }

  removeEventListener(): void {
    this.#listener = null;
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.#listener?.({ data });
  }

  last(type: string): PostedMessage | undefined {
    for (let i = this.posted.length - 1; i >= 0; i -= 1) {
      const message = this.posted[i] as PostedMessage;
      if (message.type === type) {
        return message;
      }
    }
    return undefined;
  }

  all(type: string): PostedMessage[] {
    return this.posted.filter((message) => message.type === type);
  }
}

class FakeRenderer implements SessionRenderer {
  // The session frames the world through the camera once the renderer exists.
  readonly camera = { fitWorld: (): void => undefined };
  readonly calls: string[] = [];
  destroyed = false;
  applyTerrain(): void {
    this.calls.push("applyTerrain");
  }
  applyVegetation(): void {}
  applyRenderSnapshot(): void {}
  setSelected(): void {}
  setFollowed(): void {}
  setDebugOverlay(): void {}
  stats() {
    return {
      drawnOrganisms: 0,
      drawnCarcasses: 0,
      detailedOrganisms: 0,
      snapshotTick: 0,
      zoom: 1,
      fps: 60,
    };
  }
  setToolCapture(): void {}
  setWorldLayer(): void {}
  setLayerOpacity(): void {}
  focusEntity(): boolean {
    return true;
  }
  resize(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

/** A real durable container for a real (tiny) world — no hand-made bytes. */
function realSnapshotBytes(tick: number): { bytes: Uint8Array; stateHash: string } {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = 32;
  config.world.sizeLU = 32 * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = 4;
  config.world.initialOrganisms = 8;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = 64;
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 64,
  );
  const engine = new SimulationEngine({ seed: 7, config });
  engine.stepMany(tick);
  const stateHash = engine.computeStateHash();
  return {
    bytes: encodeDurableSnapshot({
      snapshot: engine.serialize(),
      stateHash,
      configHash: engine.configHash,
    }),
    stateHash,
  };
}

function worldFixture(): WorldSummaryDto {
  return {
    seed: 7,
    seedHex: "0x00000007",
    engineVersion: "test",
    protocolVersion: PROTOCOL_VERSION,
    configSchemaVersion: 1,
    snapshotSchemaVersion: 1,
    configHash: "0123456789abcdef",
    environmentHash: FIXTURE_ENVIRONMENT_HASH,
    worldSizeLU: 256,
    gridSize: 8,
    cellSizeLU: 32,
    generationAttempt: 0,
    maxOrganisms: 64,
    maxCarcasses: 32,
    founderCentreXLU: 128,
    founderCentreYLU: 128,
    display: {
      brainInputLabels: [],
      brainIntentLabels: [],
      deathCauseLabels: [],
      eventTypeLabels: [],
      eventSeverityLabels: [],
      speciesEndReasonLabels: [],
      traitDimensionLabels: [],
      interventionKindLabels: [],
      temperatureDisplayMinC: -20,
      temperatureDisplayMaxC: 40,
      capacityDisplayReference: 1000,
      tickPhaseLabels: ["total", "environment", "sensing", "brain"],
      interventions: {
        brushSampleSpacingLU: 8,
        maxBrushSamplesPerCommand: 64,
        minBrushRadiusLU: 4,
        maxBrushRadiusLU: 128,
        maxTemperatureBrushStrengthCentiC: 500,
        maxMoistureBrushStrengthQ: 1024,
        maxFertilityBrushStrengthQ: 1024,
        maxTerrainBrushStrengthQ: 256,
        maxBiomassBrushStrengthUnits: 4000,
        maxGlobalTemperatureOffsetCentiC: 2000,
        meteorMinRadiusLU: 16,
        meteorMaxRadiusLU: 256,
      },
    },
  };
}

function telemetryFixture(tick: number): TelemetryDto {
  return {
    tick,
    population: 3,
    plantBiomass: 1000,
    organismMass: 10,
    totalBirths: 1,
    totalDeaths: 0,
    deathsByCause: [],
    achievedTicksPerSecond: 20,
    behindTarget: false,
    speed: "x1",
    maxGeneration: 1,
    capRejectedBirths: 0,
    meanDiet: 0.5,
    meanSpeedLUPerTick: 1,
    meanVisionLU: 20,
    meanAdultRadiusLU: 2,
    meanEnergyFraction: 0.5,
    traitMeans: [],
    phaseMillis: [],
    memory: {
      engineTotalBytes: 0,
      engineBytesByCategory: [],
      renderPoolBytes: 0,
      organismCapacity: 0,
      bytesPerOrganismSlot: 0,
    },
    activeSpeciesCount: 1,
    extinctSpeciesCount: 0,
    totalSpeciesCount: 1,
    latestEventId: 0,
    pendingCommandCount: 0,
    carcassCount: 0,
    carcassMeat: 0,
  } as unknown as TelemetryDto;
}

interface Harness {
  session: WorldSession;
  worker: FakeWorker;
  /** Every renderer the session created, in order. */
  renderers: FakeRenderer[];
  errors: string[];
  statuses: PersistenceStatus[];
  worlds: (readonly StoredWorld[])[];
  latestWorlds: () => readonly StoredWorld[];
  status: () => PersistenceStatus;
  ready: (options?: { telemetryTick?: number }) => Promise<void>;
  /** WORLD_READY for a world whose summary differs from the fixture's. */
  readyWith: (overrides: Partial<WorldSummaryDto>) => Promise<void>;
  /** Answer the newest REQUEST_SAVE with a genuine durable container. */
  answerSave: (tick: number) => Promise<void>;
  telemetry: (tick: number) => void;
  flush: () => Promise<void>;
}

let indexedDb: IDBFactory;
let idCounter = 0;

function createHarness(
  extra: { persistBaseline?: { name: string; expectedEnvironmentHash: string } } = {},
): Harness {
  const worker = new FakeWorker();
  const statuses: PersistenceStatus[] = [];
  const errors: string[] = [];
  const worlds: (readonly StoredWorld[])[] = [];
  const renderers: FakeRenderer[] = [];

  const session = WorldSession.start({
    canvas: {} as HTMLCanvasElement,
    viewport: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } as HTMLElement,
    seed: 7,
    initialSpeed: "x1",
    ...(extra.persistBaseline === undefined ? {} : { persistBaseline: extra.persistBaseline }),
    appVersion: "test-build",
    callbacks: {
      onWorldReady: () => {},
      onTelemetry: () => {},
      onSelectionChange: () => {},
      onEntityDetails: () => {},
      onFollowChange: () => {},
      onPersistenceStatus: (status) => {
        statuses.push(status);
      },
      onWorldsChanged: (list) => {
        worlds.push(list);
      },
      onError: (error) => {
        errors.push(error.message);
      },
    },
    createWorker: () => worker,
    createRenderer: () => {
      const renderer = new FakeRenderer();
      renderers.push(renderer);
      return Promise.resolve(renderer);
    },
    createWorldStore: () =>
      new WorldStore({
        indexedDb: indexedDb as unknown as never,
        newId: () => {
          idCounter += 1;
          return `id-${idCounter}`;
        },
      }),
  });

  const flush = async (): Promise<void> => {
    // Several awaited IndexedDB round trips happen per save; a handful of
    // macrotask turns lets all of them settle.
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    session,
    worker,
    renderers,
    errors,
    statuses,
    worlds,
    latestWorlds: () => worlds[worlds.length - 1] ?? [],
    status: () => session.persistenceStatus,
    ready: async (options = {}): Promise<void> => {
      worker.emit({
        protocolVersion: PROTOCOL_VERSION,
        type: "WORLD_READY",
        payload: {
          world: worldFixture(),
          hostRuntime: { ...DEFAULT_HOST_RUNTIME_CONFIG },
          terrain: createTerrainBuffer(8),
          telemetry: telemetryFixture(options.telemetryTick ?? 0),
        },
      });
      await flush();
    },
    readyWith: async (overrides): Promise<void> => {
      worker.emit({
        protocolVersion: PROTOCOL_VERSION,
        type: "WORLD_READY",
        payload: {
          world: { ...worldFixture(), ...overrides },
          hostRuntime: { ...DEFAULT_HOST_RUNTIME_CONFIG },
          terrain: createTerrainBuffer(8),
          telemetry: telemetryFixture(0),
        },
      });
      await flush();
    },
    answerSave: async (tick): Promise<void> => {
      const request = worker.last("REQUEST_SAVE");
      if (request?.requestId === undefined) {
        throw new Error("no REQUEST_SAVE was posted");
      }
      const { bytes, stateHash } = realSnapshotBytes(tick);
      worker.emit({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "SNAPSHOT_DATA",
        payload: {
          buffer: bytes.slice().buffer,
          tick,
          stateHash,
          engineVersion: "test",
          snapshotSchemaVersion: 1,
          configHash: "0123456789abcdef",
          environmentHash: FIXTURE_ENVIRONMENT_HASH,
          seed: 7,
          reason: request.payload["reason"],
        },
      });
      await flush();
    },
    telemetry: (tick): void => {
      worker.emit({
        protocolVersion: PROTOCOL_VERSION,
        type: "TELEMETRY",
        payload: telemetryFixture(tick),
      });
    },
    flush,
  };
}

beforeEach(() => {
  indexedDb = new IDBFactory();
  idCounter = 0;
});

describe("saving from the app shell", () => {
  it("asks the worker for bytes and stores them under the given name", async () => {
    const harness = createHarness();
    await harness.ready();

    harness.session.saveWorld("Eden");
    await harness.flush();
    expect(harness.worker.last("REQUEST_SAVE")?.payload["reason"]).toBe("manual");

    await harness.answerSave(1200);

    const status = harness.status();
    expect(status.worldId).not.toBeNull();
    expect(status.worldName).toBe("Eden");
    expect(status.lastSavedTick).toBe(1200);
    expect(status.failed).toBe(false);
    expect(status.message).toContain("Eden");

    const listed = harness.latestWorlds();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.manifest.worldName).toBe("Eden");
    expect(listed[0]?.manifest.latestTick).toBe(1200);
    expect(listed[0]?.manifest.appVersion).toBe("test-build");
    harness.session.destroy();
  });

  it("saves again into the same world rather than making a second one", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");
    await harness.answerSave(100);
    const firstId = harness.status().worldId;

    harness.session.saveWorld();
    await harness.answerSave(600);

    expect(harness.status().worldId).toBe(firstId);
    const listed = harness.latestWorlds();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.saves).toHaveLength(2);
    expect(listed[0]?.manifest.latestTick).toBe(600);
    harness.session.destroy();
  });

  it("reports a failure without pretending the world was stored", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");

    const request = harness.worker.last("REQUEST_SAVE");
    harness.worker.emit({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request?.requestId,
      type: "ERROR",
      payload: {
        message: "cannot save before a world is initialized",
        fatal: false,
        tick: null,
        seed: null,
        engineVersion: "test",
        whileHandling: "REQUEST_SAVE",
      },
    });
    await harness.flush();

    const status = harness.status();
    expect(status.failed).toBe(true);
    expect(status.message).toMatch(/Save failed/);
    expect(status.worldId).toBeNull();
    harness.session.destroy();
  });
});

describe("autosave", () => {
  it("does nothing until the world has been saved once", async () => {
    const harness = createHarness();
    await harness.ready();

    // Well past several autosave intervals: an unbound world must not create
    // rows the user never asked for.
    harness.telemetry(DEFAULT_HOST_RUNTIME_CONFIG.autosaveCheckInterval * 3);
    await harness.flush();

    expect(harness.worker.all("REQUEST_SAVE")).toHaveLength(0);
    expect(harness.status().autosaveArmed).toBe(false);
    harness.session.destroy();
  });

  it("fires on cadence once the world is bound, and keeps the same world", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");
    await harness.answerSave(0);
    const worldId = harness.status().worldId;
    expect(harness.errors).toEqual([]);
    expect(harness.status().autosaveArmed).toBe(true);

    harness.telemetry(DEFAULT_HOST_RUNTIME_CONFIG.autosaveCheckInterval);
    await harness.flush();
    expect(harness.worker.last("REQUEST_SAVE")?.payload["reason"]).toBe("autosave");

    await harness.answerSave(DEFAULT_HOST_RUNTIME_CONFIG.autosaveCheckInterval);
    expect(harness.status().worldId).toBe(worldId);
    expect(harness.status().message).toMatch(/Autosaved/);

    const listed = harness.latestWorlds();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.saves).toHaveLength(2);
    harness.session.destroy();
  });

  it("does not swallow a manual save that lands while an autosave is running", async () => {
    // The click has already been acknowledged on screen, and it carries a name.
    // Dropping it because an autosave happened to be in flight would discard
    // both the save and the rename with nothing said (A19 review).
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");
    await harness.answerSave(0);

    const interval = DEFAULT_HOST_RUNTIME_CONFIG.autosaveCheckInterval;
    harness.telemetry(interval);
    await harness.flush();
    expect(harness.worker.last("REQUEST_SAVE")?.payload["reason"]).toBe("autosave");

    // The user clicks Save, renaming the world, while that autosave is still
    // waiting on the Worker.
    harness.session.saveWorld("Renamed mid-autosave");
    await harness.answerSave(interval); // completes the autosave
    await harness.flush();
    await harness.answerSave(interval + 5); // completes the manual save

    const status = harness.status();
    expect(status.worldName).toBe("Renamed mid-autosave");
    expect(status.message).toMatch(/Saved/);
    expect(status.failed).toBe(false);

    const listed = harness.latestWorlds();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.manifest.worldName).toBe("Renamed mid-autosave");
    expect(listed[0]?.saves.length).toBeGreaterThanOrEqual(3);
    harness.session.destroy();
  });

  it("does not fire twice within one interval", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");
    await harness.answerSave(0);

    const interval = DEFAULT_HOST_RUNTIME_CONFIG.autosaveCheckInterval;
    harness.telemetry(interval);
    await harness.flush();
    await harness.answerSave(interval);
    const afterFirst = harness.worker.all("REQUEST_SAVE").length;

    harness.telemetry(interval + Math.floor(interval / 2));
    await harness.flush();
    expect(harness.worker.all("REQUEST_SAVE")).toHaveLength(afterFirst);
    harness.session.destroy();
  });
});

describe("loading from the app shell", () => {
  it("sends the stored bytes to the worker and keeps the world bound", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");
    await harness.answerSave(900);
    const worldId = harness.status().worldId;
    expect(worldId).not.toBeNull();

    harness.session.loadWorld(worldId as string);
    await harness.flush();

    const load = harness.worker.last("LOAD_WORLD");
    expect(load).toBeDefined();
    expect((load?.payload["snapshot"] as ArrayBuffer).byteLength).toBeGreaterThan(0);
    expect(harness.status().message).toMatch(/Loaded/);

    // The WORLD_READY the worker answers with must NOT unbind the session:
    // this is the same world, restored.
    await harness.ready({ telemetryTick: 900 });
    expect(harness.status().worldId).toBe(worldId);
    harness.session.destroy();
  });

  it("unbinds when a brand-new world is created, so Save cannot overwrite", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");
    await harness.answerSave(900);
    expect(harness.status().worldId).not.toBeNull();

    // A fresh WORLD_READY that was not requested by a load = a new world.
    await harness.ready();
    expect(harness.status().worldId).toBeNull();
    expect(harness.status().autosaveArmed).toBe(false);
    harness.session.destroy();
  });

  it("rebuilds the renderer for the loaded world instead of leaving the old picture", async () => {
    // A load replaces the world, and with it the renderer: the previous one's
    // WebGL context belongs to a world that is gone, and a canvas whose context
    // was destroyed cannot host a new one. Without this the loaded world shows
    // as a blank canvas — which is exactly what the first deployed build did.
    const harness = createHarness();
    await harness.ready();
    const first = harness.renderers[0];
    expect(first).toBeDefined();

    harness.session.saveWorld("Eden");
    await harness.answerSave(900);
    harness.session.loadWorld(harness.status().worldId as string);
    await harness.flush();
    await harness.ready({ telemetryTick: 900 });

    expect(harness.renderers).toHaveLength(2);
    expect(first?.destroyed).toBe(true);
    expect(harness.renderers[1]?.destroyed).toBe(false);
    // The new renderer was handed the restored world's terrain.
    expect(harness.renderers[1]?.calls).toContain("applyTerrain");
    harness.session.destroy();
  });

  it("drops the previous world's selection and event cursor on load", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");
    await harness.answerSave(900);

    harness.session.loadWorld(harness.status().worldId as string);
    await harness.flush();
    await harness.ready({ telemetryTick: 900 });

    // A restored world re-pulls its own history from the beginning rather than
    // from the replaced world's watermark.
    const request = harness.worker.last("REQUEST_HISTORY_RANGE");
    expect(request?.payload["sinceEventId"] ?? 0).toBe(0);
    harness.session.destroy();
  });

  it("reports a load failure and leaves the binding alone", async () => {
    const harness = createHarness();
    await harness.ready();

    harness.session.loadWorld("does-not-exist");
    await harness.flush();

    expect(harness.worker.all("LOAD_WORLD")).toHaveLength(0);
    expect(harness.status().failed).toBe(true);
    expect(harness.status().message).toMatch(/Load failed/);
    harness.session.destroy();
  });
});

describe("the tick-0 baseline of a created world (ADR 0025)", () => {
  it("persists a tick-0 baseline, binds the manifest and arms autosave without user action", async () => {
    const harness = createHarness({
      persistBaseline: { name: "Genesis", expectedEnvironmentHash: FIXTURE_ENVIRONMENT_HASH },
    });
    await harness.ready();

    // Create World is an explicit persistence intent: the session itself must
    // have asked for the save the moment the world was ready.
    expect(harness.worker.last("REQUEST_SAVE")).toBeDefined();
    await harness.answerSave(0);

    const status = harness.status();
    expect(status.worldId).not.toBeNull();
    expect(status.worldName).toBe("Genesis");
    expect(status.lastSavedTick).toBe(0);
    expect(status.autosaveArmed).toBe(true);

    const stored = harness.latestWorlds();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.saves.some((save) => save.tick === 0)).toBe(true);
    harness.session.destroy();
  });

  it("refuses to persist — or run — a world that is not the map the user accepted", async () => {
    // The preview-identity invariant (ADR 0025). If the world the Worker built
    // ever disagrees with the previewed map, determinism itself is broken: the
    // session must say so and must NOT store that world under the accepted
    // name.
    const harness = createHarness({
      persistBaseline: { name: "Genesis", expectedEnvironmentHash: "0000000000000000" },
    });
    await harness.ready();

    expect(harness.worker.last("REQUEST_SAVE")).toBeUndefined();
    expect(harness.status().worldId).toBeNull();
    expect(harness.errors.some((message) => /world identity mismatch/.test(message))).toBe(true);
    // The banner claims the simulation stopped, so it is stopped.
    expect(harness.worker.last("SET_RUN_STATE")?.payload["speed"]).toBe("paused");
    harness.session.destroy();
  });

  it("checks the accepted map against the created world only, never a later load", async () => {
    // Regression: the check used to run on EVERY WORLD_READY, comparing a
    // tick-0 preview digest against worlds that legitimately differ — a loaded
    // world has grown plants, and another world is another map — so a healthy
    // in-session load raised a fatal "world identity mismatch" banner.
    const harness = createHarness({
      persistBaseline: { name: "Genesis", expectedEnvironmentHash: FIXTURE_ENVIRONMENT_HASH },
    });
    await harness.ready();
    await harness.answerSave(0);
    const worldId = harness.status().worldId as string;

    harness.session.loadWorld(worldId);
    await harness.flush();
    // The world that comes back reports a different map digest: plants grew.
    await harness.readyWith({ environmentHash: "0f0f0f0f0f0f0f0f" });

    expect(harness.errors.filter((message) => /world identity mismatch/.test(message))).toEqual([]);
    harness.session.destroy();
  });

  it("writes no baseline when none was requested (a preview that was discarded never got here)", async () => {
    const harness = createHarness();
    await harness.ready();

    expect(harness.worker.last("REQUEST_SAVE")).toBeUndefined();
    expect(harness.status().worldId).toBeNull();
    harness.session.destroy();
  });
});

describe("deleting from the app shell", () => {
  it("removes the world and unbinds the session when it was the open one", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.saveWorld("Eden");
    await harness.answerSave(400);
    const worldId = harness.status().worldId as string;

    harness.session.deleteWorld(worldId);
    await harness.flush();

    expect(harness.latestWorlds()).toHaveLength(0);
    expect(harness.status().worldId).toBeNull();
    expect(harness.status().message).toMatch(/Deleted/);
    harness.session.destroy();
  });
});
