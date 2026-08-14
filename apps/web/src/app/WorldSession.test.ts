import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_RUNTIME_CONFIG,
  PROTOCOL_VERSION,
  createTerrainBuffer,
  type EntityDetailsDto,
  type EntityDetailsPayload,
  type TelemetryDto,
  type WorldSummaryDto,
} from "@eon/protocol";
import type { WorldLayerId } from "@eon/renderer/palette";
import {
  WorldSession,
  type FollowEndReason,
  type RendererFactoryOptions,
  type SessionRenderer,
  type SessionWorker,
  type WorldSessionCallbacks,
} from "./WorldSession";

/**
 * Session behavior tests (tasks H01-H03, docs/10 §22).
 *
 * The Worker and the renderer are the two async, browser-bound edges of the
 * session; both are injected as fakes here so the *wiring* — selection, stale
 * query handling, follow lifecycles, layer isolation, teardown — is tested
 * deterministically in Node. What the real Worker computes is covered by the
 * SimulationHost tests; what the real renderer draws needs a GPU and is
 * covered by the manual browser pass.
 */

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

  /** Deliver a worker→main message as the real port would. */
  emit(message: unknown): void {
    this.#listener?.({ data: message });
  }

  all(type: string): PostedMessage[] {
    return this.posted.filter((message) => message.type === type);
  }

  last(type: string): PostedMessage | undefined {
    return this.all(type).at(-1);
  }
}

class FakeRenderer implements SessionRenderer {
  readonly camera = { fitWorld: (): void => undefined };
  readonly calls: string[] = [];
  selected: number | null = null;
  followed: number | null = null;
  layer: WorldLayerId = "terrain";
  destroyed = false;

  applyTerrain(): void {
    this.calls.push("applyTerrain");
  }
  applyVegetation(): void {
    this.calls.push("applyVegetation");
  }
  applyRenderSnapshot(): void {
    this.calls.push("applyRenderSnapshot");
  }
  setSelected(entityId: number | null): void {
    this.selected = entityId;
  }
  setFollowed(entityId: number | null): void {
    this.followed = entityId;
  }
  setDebugOverlay(): void {
    this.calls.push("setDebugOverlay");
  }
  setWorldLayer(layer: WorldLayerId): void {
    this.layer = layer;
    this.calls.push(`setWorldLayer:${layer}`);
  }
  setLayerOpacity(): void {
    this.calls.push("setLayerOpacity");
  }
  focusEntity(): boolean {
    this.calls.push("focusEntity");
    return true;
  }
  resize(): void {
    this.calls.push("resize");
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function worldFixture(): WorldSummaryDto {
  return {
    seed: 7,
    seedHex: "0x00000007",
    engineVersion: "0.5.0",
    protocolVersion: PROTOCOL_VERSION,
    configSchemaVersion: 6,
    snapshotSchemaVersion: 6,
    configHash: "cafe",
    worldSizeLU: 128,
    gridSize: 8,
    cellSizeLU: 16,
    generationAttempt: 0,
    maxOrganisms: 64,
    maxCarcasses: 16,
    founderCentreXLU: 64,
    founderCentreYLU: 64,
    display: {
      brainInputLabels: ["bias"],
      brainIntentLabels: ["throttle"],
      deathCauseLabels: ["none"],
      temperatureDisplayMinC: -25,
      temperatureDisplayMaxC: 35,
      capacityDisplayReference: 4000,
    },
  };
}

function telemetryFixture(tick: number): TelemetryDto {
  return {
    tick,
    population: 10,
    totalBirths: 2,
    totalDeaths: 1,
    capRejectedBirths: 0,
    deathsByCause: [0],
    carcassCount: 0,
    plantBiomass: 100,
    plantCapacity: 200,
    maxGeneration: 1,
    organismMass: 500,
    meanEnergyFraction: 0.5,
    traitMeans: {
      diet: 0,
      maxSpeedLUPerTick: 0.2,
      adultRadiusLU: 1,
      visionRangeLU: 30,
      attack: 0,
      armor: 0,
      metabolicPace: 0.5,
      thermalOptimumC: 20,
    },
    speed: "x1",
    achievedTicksPerSecond: 20,
    targetTicksPerSecond: 20,
    behindTarget: false,
    renderBuffersInFlight: 0,
    droppedRenderSnapshots: 0,
    phaseMillis: [],
  };
}

function detailsFixture(entityId: number): EntityDetailsDto {
  return {
    entityId,
    speciesId: 1,
    generation: 1,
    parentEntityId: 0,
    ageTicks: 10,
    xLU: 5,
    yLU: 6,
    headingRadians: 0,
    speedLUPerTick: 0.1,
    energy: 100,
    maxEnergy: 200,
    health: 1,
    development: 1,
    radiusLU: 1,
    mass: 10,
    diet: 0,
    maxSpeedLUPerTick: 0.2,
    visionRangeLU: 30,
    visionFovDegrees: 200,
    attack: 0,
    armor: 0,
    metabolicPace: 0.5,
    thermalOptimumC: 20,
    thermalToleranceC: 8,
    maturityAgeTicks: 100,
    maxAgeTicks: 1000,
    hueDegrees: 100,
    reproductionCooldownTicks: 0,
    costBasalPerTick: 1,
    costMovementPerTick: 0.5,
    thermalStress: 0,
    brainInputs: [1],
    brainIntents: [0.5],
    plantEnergyEaten: 10,
    meatEnergyEaten: 0,
    kills: 0,
    biome: 1,
    biomeName: "Grassland",
    cellTemperatureC: 20,
    cellPlantBiomass: 100,
  };
}

interface Recorded {
  selections: (number | null)[];
  details: EntityDetailsPayload[];
  follows: { entityId: number | null; reason: FollowEndReason | "started" }[];
  telemetry: TelemetryDto[];
  worlds: WorldSummaryDto[];
  errors: string[];
}

interface Harness {
  session: WorldSession;
  worker: FakeWorker;
  renderer: FakeRenderer;
  rendererOptions: () => RendererFactoryOptions;
  recorded: Recorded;
  /** Deliver WORLD_READY and wait for the renderer to be wired up. */
  ready: () => Promise<void>;
  /** Answer the newest QUERY_ENTITY with these details. */
  answerQuery: (details: EntityDetailsDto | null, forEntity?: number) => void;
  flush: () => Promise<void>;
}

function createHarness(): Harness {
  const worker = new FakeWorker();
  const renderer = new FakeRenderer();
  let capturedOptions: RendererFactoryOptions | null = null;
  const recorded: Recorded = {
    selections: [],
    details: [],
    follows: [],
    telemetry: [],
    worlds: [],
    errors: [],
  };
  const callbacks: WorldSessionCallbacks = {
    onWorldReady: (world) => {
      recorded.worlds.push(world);
    },
    onTelemetry: (telemetry) => {
      recorded.telemetry.push(telemetry);
    },
    onSelectionChange: (entityId) => {
      recorded.selections.push(entityId);
    },
    onEntityDetails: (payload) => {
      recorded.details.push(payload);
    },
    onFollowChange: (entityId, reason) => {
      recorded.follows.push({ entityId, reason });
    },
    onError: (error) => {
      recorded.errors.push(error.message);
    },
  };

  const session = WorldSession.start({
    canvas: {} as HTMLCanvasElement,
    viewport: {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
    } as HTMLElement,
    seed: 7,
    initialSpeed: "x1",
    callbacks,
    createWorker: () => worker,
    createRenderer: (options) => {
      capturedOptions = options;
      return Promise.resolve(renderer);
    },
  });

  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    session,
    worker,
    renderer,
    rendererOptions: () => {
      if (capturedOptions === null) {
        throw new Error("renderer factory has not been called yet");
      }
      return capturedOptions;
    },
    recorded,
    ready: async (): Promise<void> => {
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
    answerQuery: (details, forEntity): void => {
      const query = worker.last("QUERY_ENTITY");
      if (query?.requestId === undefined) {
        throw new Error("no QUERY_ENTITY was posted");
      }
      const entityId = forEntity ?? (query.payload["entityId"] as number);
      worker.emit({
        protocolVersion: PROTOCOL_VERSION,
        requestId: query.requestId,
        type: "ENTITY_DETAILS",
        payload: { entityId, details, tick: 1 },
      });
    },
    flush,
  };
}

describe("WorldSession", () => {
  it("boots: INIT_NEW_WORLD, renderer creation, terrain, initial resize", async () => {
    const harness = createHarness();
    expect(harness.worker.all("INIT_NEW_WORLD")).toHaveLength(1);
    await harness.ready();
    expect(harness.recorded.worlds).toHaveLength(1);
    expect(harness.renderer.calls).toContain("applyTerrain");
    expect(harness.renderer.calls).toContain("resize");
  });

  it("selection queries the worker and populates the inspector", async () => {
    const harness = createHarness();
    await harness.ready();

    harness.rendererOptions().onSelectionChange(42);
    expect(harness.recorded.selections).toEqual([42]);
    const query = harness.worker.last("QUERY_ENTITY");
    expect(query?.payload["entityId"]).toBe(42);

    harness.answerQuery(detailsFixture(42));
    await harness.flush();
    expect(harness.recorded.details).toHaveLength(1);
    expect(harness.recorded.details[0]?.details?.entityId).toBe(42);
  });

  it("drops a stale answer after a rapid re-selection", async () => {
    const harness = createHarness();
    await harness.ready();

    harness.rendererOptions().onSelectionChange(42);
    const firstQuery = harness.worker.last("QUERY_ENTITY");
    harness.rendererOptions().onSelectionChange(99);

    // The answer for 42 arrives *after* 99 was selected. It must not reach the
    // inspector — 99's answer must.
    harness.worker.emit({
      protocolVersion: PROTOCOL_VERSION,
      requestId: firstQuery?.requestId,
      type: "ENTITY_DETAILS",
      payload: { entityId: 42, details: detailsFixture(42), tick: 1 },
    });
    await harness.flush();
    expect(harness.recorded.details).toHaveLength(0);

    harness.answerQuery(detailsFixture(99));
    await harness.flush();
    expect(harness.recorded.details).toHaveLength(1);
    expect(harness.recorded.details[0]?.details?.entityId).toBe(99);
  });

  it("deselection clears the renderer ring and the inspector", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.rendererOptions().onSelectionChange(42);
    harness.session.clearSelection();
    expect(harness.renderer.selected).toBeNull();
    expect(harness.recorded.selections.at(-1)).toBeNull();
  });

  it("reports a dead organism as gone, not as an error", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.rendererOptions().onSelectionChange(42);
    harness.answerQuery(null);
    await harness.flush();
    expect(harness.recorded.details[0]?.details).toBeNull();
    expect(harness.recorded.errors).toHaveLength(0);
  });

  it("follow starts on the selection and reaches the renderer", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.rendererOptions().onSelectionChange(42);
    harness.session.followSelected();
    expect(harness.renderer.followed).toBe(42);
    expect(harness.recorded.follows).toEqual([{ entityId: 42, reason: "started" }]);
  });

  it("selecting another organism ends the follow", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.rendererOptions().onSelectionChange(42);
    harness.session.followSelected();
    harness.rendererOptions().onSelectionChange(99);
    expect(harness.renderer.followed).toBeNull();
    expect(harness.recorded.follows.at(-1)).toEqual({ entityId: null, reason: "selection" });
  });

  it("the renderer reporting a died follow target is mirrored to the UI", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.rendererOptions().onSelectionChange(42);
    harness.session.followSelected();
    harness.rendererOptions().onFollowEnd("died");
    expect(harness.session.followedEntityId).toBeNull();
    expect(harness.recorded.follows.at(-1)).toEqual({ entityId: null, reason: "died" });
  });

  it("a death discovered by query ends the follow too (paused world path)", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.rendererOptions().onSelectionChange(42);
    harness.session.followSelected();
    harness.answerQuery(null);
    await harness.flush();
    expect(harness.session.followedEntityId).toBeNull();
    expect(harness.recorded.follows.at(-1)).toEqual({ entityId: null, reason: "died" });
  });

  it("speed changes go to the worker verbatim", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.setSpeed("x100");
    expect(harness.worker.last("SET_RUN_STATE")?.payload["speed"]).toBe("x100");
    harness.session.setSpeed("paused");
    expect(harness.worker.last("SET_RUN_STATE")?.payload["speed"]).toBe("paused");
  });

  it("switching world layers never sends the worker anything", async () => {
    const harness = createHarness();
    await harness.ready();
    const postedBefore = harness.worker.posted.length;
    for (const layer of ["temperature", "moisture", "density", "terrain"] as const) {
      harness.session.setWorldLayer(layer);
    }
    harness.session.setLayerOpacity(0.5);
    expect(harness.renderer.layer).toBe("terrain");
    expect(harness.renderer.calls).toContain("setWorldLayer:density");
    expect(harness.worker.posted.length).toBe(postedBefore);
  });

  it("layer choices made before the renderer exists are applied to it", async () => {
    const harness = createHarness();
    harness.session.setWorldLayer("fertility");
    await harness.ready();
    expect(harness.renderer.layer).toBe("fertility");
  });

  it("freezes every DTO it hands to React", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.worker.emit({
      protocolVersion: PROTOCOL_VERSION,
      type: "TELEMETRY",
      payload: telemetryFixture(10),
    });
    harness.rendererOptions().onSelectionChange(42);
    harness.answerQuery(detailsFixture(42));
    await harness.flush();

    const world = harness.recorded.worlds[0] as WorldSummaryDto;
    const telemetry = harness.recorded.telemetry.at(-1) as TelemetryDto;
    const details = harness.recorded.details[0]?.details as EntityDetailsDto;
    expect(Object.isFrozen(world)).toBe(true);
    expect(Object.isFrozen(world.display)).toBe(true);
    expect(Object.isFrozen(telemetry)).toBe(true);
    expect(Object.isFrozen(telemetry.traitMeans)).toBe(true);
    expect(Object.isFrozen(telemetry.deathsByCause)).toBe(true);
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details.brainInputs)).toBe(true);
    // Strict-mode code (all of ours) throws on any write attempt.
    expect(() => {
      "use strict";
      (telemetry as { population: number }).population = 0;
    }).toThrow(TypeError);
  });

  it("tears down renderer and worker exactly once", async () => {
    const harness = createHarness();
    await harness.ready();
    harness.session.destroy();
    harness.session.destroy();
    expect(harness.renderer.destroyed).toBe(true);
    expect(harness.worker.terminated).toBe(true);
    const disposes = harness.worker.all("DISPOSE");
    expect(disposes).toHaveLength(1);
  });

  it("destroys a renderer that finished initializing after teardown", async () => {
    const harness = createHarness();
    // WORLD_READY arrives, then the session dies while the renderer promise is
    // still pending.
    harness.worker.emit({
      protocolVersion: PROTOCOL_VERSION,
      type: "WORLD_READY",
      payload: {
        world: worldFixture(),
        hostRuntime: { ...DEFAULT_HOST_RUNTIME_CONFIG },
        terrain: createTerrainBuffer(8),
        telemetry: telemetryFixture(0),
      },
    });
    harness.session.destroy();
    await harness.flush();
    expect(harness.renderer.destroyed).toBe(true);
    expect(harness.recorded.worlds).toHaveLength(0);
  });
});
