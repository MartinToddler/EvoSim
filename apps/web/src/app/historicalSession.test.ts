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
import type { HistoricalStatus } from "./WorldPersistence";
import { WorldSession, type SessionRenderer, type SessionWorker } from "./WorldSession";

/**
 * The app-shell half of Milestone 11: what the *session* does around a rewind.
 *
 * The Worker is faked — what it computes is covered by `hostM11.test.ts` — so
 * what is under test here is the orchestration only this side can get wrong:
 * choosing which stored save to replay from, refusing to rewind a world with no
 * save that early, discarding a superseded request's answer, and writing a
 * branch as a new world that leaves its parent alone.
 */

interface PostedMessage {
  type: string;
  payload: Record<string, unknown>;
  requestId?: number;
}

class FakeWorker implements SessionWorker {
  readonly posted: PostedMessage[] = [];
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
  terminate(): void {}
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
  readonly camera = { fitWorld: (): void => undefined };
  applyTerrain(): void {}
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
  destroy(): void {}
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
    environmentHash: "feedfacefeedface",
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
    speed: "x1",
    phaseMillis: [],
    traitMeans: {},
    deathsByCause: [],
    memory: {
      engineTotalBytes: 0,
      engineBytesByCategory: [],
      renderPoolBytes: 0,
      organismCapacity: 0,
      bytesPerOrganismSlot: 0,
    },
  } as unknown as TelemetryDto;
}

let indexedDb: IDBFactory;
let idCounter = 0;

interface Harness {
  session: WorldSession;
  worker: FakeWorker;
  historical: HistoricalStatus[];
  worlds: (readonly StoredWorld[])[];
  latestWorlds: () => readonly StoredWorld[];
  ready: () => Promise<void>;
  answerSave: (tick: number) => Promise<void>;
  /** Answer the newest REQUEST_REWIND, optionally reporting progress first. */
  answerRewind: (options: {
    tick: number;
    presentTick: number;
    progress?: { ticksReplayed: number; ticksTotal: number }[];
    requestId?: number | undefined;
  }) => Promise<void>;
  answerBranch: (tick: number) => Promise<void>;
  flush: () => Promise<void>;
}

function createHarness(): Harness {
  const worker = new FakeWorker();
  const historical: HistoricalStatus[] = [];
  const worlds: (readonly StoredWorld[])[] = [];

  const session = WorldSession.start({
    canvas: {} as HTMLCanvasElement,
    viewport: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } as HTMLElement,
    seed: 7,
    initialSpeed: "x1",
    appVersion: "test-build",
    callbacks: {
      onWorldReady: () => {},
      onTelemetry: () => {},
      onSelectionChange: () => {},
      onEntityDetails: () => {},
      onFollowChange: () => {},
      onHistorical: (status) => {
        historical.push(status);
      },
      onWorldsChanged: (list) => {
        worlds.push(list);
      },
      onError: () => {},
    },
    createWorker: () => worker,
    createRenderer: () => Promise.resolve(new FakeRenderer()),
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
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    session,
    worker,
    historical,
    worlds,
    latestWorlds: () => worlds[worlds.length - 1] ?? [],
    flush,
    ready: async () => {
      worker.emit({
        protocolVersion: PROTOCOL_VERSION,
        type: "WORLD_READY",
        payload: {
          world: worldFixture(),
          hostRuntime: { ...DEFAULT_HOST_RUNTIME_CONFIG },
          terrain: createTerrainBuffer(8),
          telemetry: telemetryFixture(0),
        },
      });
      await flush();
    },
    answerSave: async (tick) => {
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
          environmentHash: "feedfacefeedface",
          seed: 7,
          reason: request.payload["reason"],
        },
      });
      await flush();
    },
    answerRewind: async ({ tick, presentTick, progress = [], requestId }) => {
      const request = worker.last("REQUEST_REWIND");
      const id = requestId ?? request?.requestId;
      if (id === undefined) {
        throw new Error("no REQUEST_REWIND was posted");
      }
      for (const step of progress) {
        worker.emit({
          protocolVersion: PROTOCOL_VERSION,
          requestId: id,
          type: "REWIND_PROGRESS",
          payload: { targetTick: tick, fromTick: 0, currentTick: tick, ...step },
        });
      }
      worker.emit({
        protocolVersion: PROTOCOL_VERSION,
        requestId: id,
        type: "HISTORICAL_MODE_READY",
        payload: { tick, presentTick, stateHash: `hash-${tick}`, earliestTick: 0 },
      });
      await flush();
    },
    answerBranch: async (tick) => {
      const request = worker.last("CREATE_BRANCH");
      if (request?.requestId === undefined) {
        throw new Error("no CREATE_BRANCH was posted");
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
          seed: 7,
          reason: "branch",
        },
      });
      await flush();
    },
  };
}

/** Save a world at `tick`, so it has a save to rewind from. */
async function saveAt(harness: Harness, tick: number): Promise<void> {
  void harness.session.saveWorld();
  await harness.flush();
  await harness.answerSave(tick);
}

beforeEach(() => {
  indexedDb = new IDBFactory();
  idCounter = 0;
});

describe("rewinding from the session", () => {
  it("replays from the newest save at or before the target", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);
    await saveAt(harness, 400);
    await saveAt(harness, 900);

    const pending = harness.session.rewindTo(600);
    await harness.flush();

    const request = harness.worker.last("REQUEST_REWIND");
    expect(request?.payload["targetTick"]).toBe(600);
    // 400, not 900 (later than the target) and not 100 (older than needed).
    expect((request?.payload["snapshot"] as ArrayBuffer).byteLength).toBeGreaterThan(0);

    await harness.answerRewind({ tick: 600, presentTick: 900 });
    expect(await pending).toBe(true);
    expect(harness.session.historical.mode).toBe("historical");
    expect(harness.session.historical.tick).toBe(600);
    expect(harness.session.historical.presentTick).toBe(900);
  });

  it("pauses the live world before reconstructing", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);

    void harness.session.rewindTo(50);
    await harness.flush();

    expect(harness.worker.last("SET_RUN_STATE")?.payload["speed"]).toBe("paused");
  });

  it("refuses a tick with no save at or before it", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 500);

    const ok = await harness.session.rewindTo(100);
    expect(ok).toBe(false);
    expect(harness.worker.last("REQUEST_REWIND")).toBeUndefined();
    expect(harness.session.historical.mode).toBe("live");
    expect(harness.session.historical.failed).toBe(true);
    expect(harness.session.historical.message).toMatch(/no save at or before/);
  });

  it("refuses to rewind a world that has never been saved", async () => {
    const harness = createHarness();
    await harness.ready();

    const ok = await harness.session.rewindTo(10);
    expect(ok).toBe(false);
    expect(harness.session.historical.message).toMatch(/Save this world/);
  });

  it("reports progress while replaying", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);

    const pending = harness.session.rewindTo(900);
    await harness.flush();
    await harness.answerRewind({
      tick: 900,
      presentTick: 900,
      progress: [
        { ticksReplayed: 0, ticksTotal: 800 },
        { ticksReplayed: 400, ticksTotal: 800 },
      ],
    });
    await pending;

    const seen = harness.historical.filter((status) => status.progress !== null);
    expect(seen.map((status) => status.progress?.ticksReplayed)).toContain(400);
  });

  it("discards the answer to a superseded rewind", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);

    const stale = harness.session.rewindTo(300);
    await harness.flush();
    const staleRequestId = harness.worker.last("REQUEST_REWIND")?.requestId;

    const fresh = harness.session.rewindTo(700);
    await harness.flush();
    const freshRequestId = harness.worker.last("REQUEST_REWIND")?.requestId;
    expect(freshRequestId).not.toBe(staleRequestId);

    // The newer request lands first, then the older one straggles in.
    await harness.answerRewind({ tick: 700, presentTick: 900, requestId: freshRequestId });
    await harness.answerRewind({ tick: 300, presentTick: 900, requestId: staleRequestId });

    expect(await fresh).toBe(true);
    expect(await stale).toBe(false);
    // The screen shows what was asked for last, not what answered last.
    expect(harness.session.historical.tick).toBe(700);
  });

  it("ignores progress from a superseded rewind", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);

    void harness.session.rewindTo(300);
    await harness.flush();
    const staleRequestId = harness.worker.last("REQUEST_REWIND")?.requestId ?? 0;

    const fresh = harness.session.rewindTo(700);
    await harness.flush();
    harness.historical.length = 0;

    harness.worker.emit({
      protocolVersion: PROTOCOL_VERSION,
      requestId: staleRequestId,
      type: "REWIND_PROGRESS",
      payload: {
        targetTick: 300,
        fromTick: 100,
        currentTick: 250,
        ticksReplayed: 150,
        ticksTotal: 200,
      },
    });
    await harness.flush();

    expect(harness.historical).toHaveLength(0);
    await harness.answerRewind({ tick: 700, presentTick: 900 });
    await fresh;
  });

  it("returns to the present and tells the worker to as well", async () => {
    const harness = createHarness();
    await harness.ready();
    // A save at or before the target is what makes the target reachable.
    await saveAt(harness, 0);
    await saveAt(harness, 100);
    const pending = harness.session.rewindTo(50);
    await harness.flush();
    await harness.answerRewind({ tick: 50, presentTick: 100 });
    await pending;

    harness.session.returnToPresent();

    expect(harness.worker.last("RETURN_TO_PRESENT")).toBeDefined();
    expect(harness.session.historical.mode).toBe("live");
    expect(harness.session.historical.tick).toBeNull();
  });
});

describe("branching from the session", () => {
  it("writes the branch as a new world and leaves the parent alone", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);
    await saveAt(harness, 400);
    const parentId = harness.session.persistenceStatus.worldId;
    const parentBefore = harness
      .latestWorlds()
      .find((world) => world.manifest.worldId === parentId)?.manifest;

    const pending = harness.session.rewindTo(200);
    await harness.flush();
    await harness.answerRewind({ tick: 200, presentTick: 400 });
    await pending;

    const branching = harness.session.branchHere("What if");
    await harness.flush();
    await harness.answerBranch(200);
    const branched = await branching;
    const branchId = branched.worldId;

    expect(branched.opened).toBe(true);
    expect(branchId).not.toBeNull();
    expect(branchId).not.toBe(parentId);

    const worlds = harness.latestWorlds();
    const branch = worlds.find((world) => world.manifest.worldId === branchId)?.manifest;
    expect(branch?.parentWorldId).toBe(parentId);
    expect(branch?.branchTick).toBe(200);
    expect(branch?.worldName).toBe("What if");

    const parentAfter = worlds.find((world) => world.manifest.worldId === parentId)?.manifest;
    expect(parentAfter).toEqual(parentBefore);
  });

  it("refuses to branch outside historical mode", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 400);

    expect(await harness.session.branchHere("nope")).toEqual({ worldId: null, opened: false });
    expect(harness.worker.last("CREATE_BRANCH")).toBeUndefined();
  });

  it("opens the branch automatically, paused at the branch tick (ADR 0025)", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);
    await saveAt(harness, 400);
    const parentId = harness.session.persistenceStatus.worldId;

    const pending = harness.session.rewindTo(200);
    await harness.flush();
    await harness.answerRewind({ tick: 200, presentTick: 400 });
    await pending;

    const branching = harness.session.branchHere("Alternative");
    await harness.flush();
    await harness.answerBranch(200);
    const branched = await branching;
    const branchId = branched.worldId;
    await harness.flush();

    expect(branched.opened).toBe(true);
    expect(branchId).not.toBeNull();
    // The preview was left…
    expect(harness.worker.last("RETURN_TO_PRESENT")).toBeDefined();
    expect(harness.session.historical.mode).toBe("live");
    // …and the branch became the OPEN world, loaded paused at its origin tick.
    expect(harness.session.persistenceStatus.worldId).toBe(branchId);
    expect(harness.session.persistenceStatus.worldName).toBe("Alternative");
    expect(harness.session.persistenceStatus.lastSavedTick).toBe(200);
    const load = harness.worker.last("LOAD_WORLD");
    expect(load).toBeDefined();
    expect(load?.payload["speed"]).toBe("paused");
    expect(harness.session.paused).toBe(true);
    // The parent is untouched and still listed under its own identity.
    const worlds = harness.latestWorlds();
    expect(worlds.some((world) => world.manifest.worldId === parentId)).toBe(true);
  });

  it("keeps later saves inside the branch, never the parent (ADR 0025)", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);
    const parentId = harness.session.persistenceStatus.worldId;
    const pending = harness.session.rewindTo(100);
    await harness.flush();
    await harness.answerRewind({ tick: 100, presentTick: 100 });
    await pending;

    const branching = harness.session.branchHere("Fork");
    await harness.flush();
    await harness.answerBranch(100);
    const branchId = (await branching).worldId;
    await harness.flush();
    // The Worker adopts the branch and answers with WORLD_READY, which is what
    // confirms the session is bound to the world actually running. Saving is
    // suspended until it arrives (a load the Worker refuses must never take
    // the binding with it), so the flow has to include it.
    await harness.ready();

    // A save issued after the switch belongs to the branch's manifest.
    harness.session.saveWorld();
    await harness.answerSave(150);

    const worlds = harness.latestWorlds();
    const parent = worlds.find((world) => world.manifest.worldId === parentId);
    const branch = worlds.find((world) => world.manifest.worldId === branchId);
    expect(parent?.manifest.latestTick).toBe(100);
    expect(branch?.manifest.latestTick).toBe(150);
    expect(branch?.manifest.parentWorldId).toBe(parentId);
  });
});

describe("a preview is read-only, and a load leaves it (ADR 0025, corrected)", () => {
  it("fires no autosave on historical telemetry", async () => {
    // While a preview is open the Worker's telemetry describes the HISTORICAL
    // engine, so its tick is a past one. Autosaving on it asks the Worker to
    // save while previewing — which it refuses — and reports a failure the
    // user did not cause, on a live world that is paused and unchanged.
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);

    const pending = harness.session.rewindTo(100);
    await harness.flush();
    await harness.answerRewind({ tick: 100, presentTick: 100 });
    await pending;

    const savesBefore = harness.worker.all("REQUEST_SAVE").length;
    // A telemetry frame far past the autosave interval, carrying the
    // historical engine's tick.
    harness.worker.emit({
      protocolVersion: PROTOCOL_VERSION,
      type: "TELEMETRY",
      payload: telemetryFixture(100 + DEFAULT_HOST_RUNTIME_CONFIG.autosaveCheckInterval * 3),
    });
    await harness.flush();

    expect(harness.worker.all("REQUEST_SAVE").length).toBe(savesBefore);
    expect(harness.session.persistenceStatus.failed).toBe(false);
    harness.session.destroy();
  });

  it("saves nothing on pagehide while previewing", async () => {
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);

    const pending = harness.session.rewindTo(100);
    await harness.flush();
    await harness.answerRewind({ tick: 100, presentTick: 100 });
    await pending;

    const savesBefore = harness.worker.all("REQUEST_SAVE").length;
    harness.session.saveOnHide();
    await harness.flush();

    expect(harness.worker.all("REQUEST_SAVE").length).toBe(savesBefore);
    expect(harness.session.persistenceStatus.failed).toBe(false);
    harness.session.destroy();
  });

  it("returns the history status to live when a load replaces the world", async () => {
    // The past on screen belonged to the world being replaced. Without this the
    // panel kept reporting the OLD world's preview over the newly loaded one.
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);
    const worldId = harness.session.persistenceStatus.worldId as string;

    const pending = harness.session.rewindTo(100);
    await harness.flush();
    await harness.answerRewind({ tick: 100, presentTick: 100 });
    await pending;
    expect(harness.session.historical.mode).toBe("historical");

    harness.session.loadWorld(worldId);
    await harness.flush();

    expect(harness.session.historical.mode).toBe("live");
    expect(harness.session.historical.tick).toBeNull();
    harness.session.destroy();
  });

  it("keeps the previous binding when the Worker refuses a load", async () => {
    // The Worker validates harder than the store: it restores the snapshot and
    // re-checks its hash, and on refusal it keeps the PREVIOUS world running.
    // A session that stayed bound to the refused world would file the running
    // world's next autosave under the refused world's manifest.
    const harness = createHarness();
    await harness.ready();
    await saveAt(harness, 100);
    const openWorldId = harness.session.persistenceStatus.worldId as string;

    harness.session.loadWorld(openWorldId);
    await harness.flush();
    // No WORLD_READY: the Worker rejects the bytes instead.
    harness.worker.emit({
      protocolVersion: PROTOCOL_VERSION,
      type: "ERROR",
      payload: {
        message: "restored state hash does not match the save",
        fatal: false,
        tick: null,
        seed: 7,
        engineVersion: "test",
        whileHandling: "LOAD_WORLD",
      },
    });
    await harness.flush();

    const status = harness.session.persistenceStatus;
    expect(status.worldId).toBe(openWorldId);
    expect(status.failed).toBe(true);
    expect(status.message).toMatch(/still open/);
    // And saving works again, against the world that is actually running.
    harness.session.saveWorld();
    await harness.flush();
    expect(harness.worker.last("REQUEST_SAVE")).toBeDefined();
    harness.session.destroy();
  });
});
