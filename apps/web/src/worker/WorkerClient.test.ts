import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  createRenderSnapshotBuffer,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
} from "@eon/protocol";
import { WorkerClient, type ClientPort, type WorkerClientHandlers } from "./WorkerClient";

/**
 * Main-thread facade behaviour (docs/10 §21).
 *
 * The interesting cases are all about *correlation*: which answer belongs to
 * which question, and what happens to an answer nobody is waiting for any more.
 * A UI where clicking quickly puts the previous organism's numbers in the panel
 * is the bug this file exists to prevent.
 */

interface Harness {
  client: WorkerClient;
  sent: MainToWorkerMessage[];
  transfers: (readonly ArrayBuffer[] | undefined)[];
  deliver: (message: unknown) => void;
  closed: () => boolean;
}

function createHarness(handlers: WorkerClientHandlers = {}): Harness {
  const sent: MainToWorkerMessage[] = [];
  const transfers: (readonly ArrayBuffer[] | undefined)[] = [];
  let listener: ((data: unknown) => void) | null = null;
  let closed = false;
  const port: ClientPort = {
    post(message, transfer): void {
      sent.push(message);
      transfers.push(transfer);
    },
    setListener(next): void {
      listener = next;
    },
    close(): void {
      closed = true;
    },
  };
  const client = new WorkerClient(port, handlers);
  return {
    client,
    sent,
    transfers,
    deliver: (message: unknown): void => {
      listener?.(message);
    },
    closed: (): boolean => closed,
  };
}

function response(type: string, payload: unknown, requestId?: number): WorkerToMainMessage {
  return (
    requestId === undefined
      ? { protocolVersion: PROTOCOL_VERSION, type, payload }
      : { protocolVersion: PROTOCOL_VERSION, requestId, type, payload }
  ) as WorkerToMainMessage;
}

describe("outbound commands", () => {
  it("stamps every message with the protocol version", () => {
    const harness = createHarness();
    harness.client.initNewWorld({ seed: 7, speed: "x1" });
    harness.client.setSpeed("max");
    harness.client.setRenderStream(false);
    expect(harness.sent.every((message) => message.protocolVersion === PROTOCOL_VERSION)).toBe(
      true,
    );
    expect(harness.sent.map((message) => message.type)).toEqual([
      "INIT_NEW_WORLD",
      "SET_RUN_STATE",
      "SET_RENDER_STREAM",
    ]);
  });

  it("transfers recycled buffers rather than copying them", () => {
    const harness = createHarness();
    const buffer = createRenderSnapshotBuffer(8, 4);
    harness.client.recycleRenderBuffer(buffer);
    expect(harness.sent[0]?.type).toBe("RECYCLE_RENDER_BUFFER");
    expect(harness.transfers[0]).toEqual([buffer]);
  });

  it("silently ignores a recycle of an already-detached buffer", () => {
    // The renderer can be torn down between receiving a buffer and returning
    // it. Sending a detached buffer would throw inside postMessage.
    const harness = createHarness();
    const buffer = createRenderSnapshotBuffer(8, 4);
    structuredClone(buffer, { transfer: [buffer] });
    harness.client.recycleRenderBuffer(buffer);
    harness.client.recycleVegetationBuffer(buffer);
    expect(harness.sent).toHaveLength(0);
  });
});

describe("requestId correlation", () => {
  it("gives each request a distinct id and settles the matching answer", async () => {
    const harness = createHarness();
    const first = harness.client.queryEntity(11);
    const second = harness.client.queryEntity(22);

    const ids = harness.sent.map((message) => message.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(harness.client.pendingRequestCount).toBe(2);

    // Answer out of order, on purpose: correlation must not depend on arrival
    // order.
    harness.deliver(response("ENTITY_DETAILS", { entityId: 22, details: null, tick: 5 }, ids[1]));
    harness.deliver(response("ENTITY_DETAILS", { entityId: 11, details: null, tick: 5 }, ids[0]));

    await expect(first).resolves.toMatchObject({ entityId: 11 });
    await expect(second).resolves.toMatchObject({ entityId: 22 });
    expect(harness.client.pendingRequestCount).toBe(0);
  });

  it("keeps entity and hash requests in separate lanes", async () => {
    const harness = createHarness();
    const entity = harness.client.queryEntity(3);
    const hash = harness.client.queryStateHash(100);
    const [entityId, hashId] = harness.sent.map((message) => message.requestId);

    harness.deliver(response("STATE_HASH", { tick: 100, hash: "abc", engineVersion: "x" }, hashId));
    harness.deliver(
      response("ENTITY_DETAILS", { entityId: 3, details: null, tick: 100 }, entityId),
    );

    await expect(hash).resolves.toMatchObject({ hash: "abc" });
    await expect(entity).resolves.toMatchObject({ entityId: 3 });
  });

  it("rejects when the worker answers a request with the wrong type", async () => {
    const harness = createHarness();
    const pending = harness.client.queryEntity(1);
    const requestId = harness.sent[0]?.requestId;
    harness.deliver(response("STATE_HASH", { tick: 1, hash: "z", engineVersion: "x" }, requestId));
    await expect(pending).rejects.toThrow(/expected ENTITY_DETAILS/);
  });

  it("rejects the matching promise when the worker reports a request error", async () => {
    const harness = createHarness();
    const pending = harness.client.queryStateHash(5);
    const requestId = harness.sent[0]?.requestId;
    harness.deliver(
      response(
        "ERROR",
        {
          message: "cannot step backwards",
          fatal: false,
          tick: 9,
          seed: 1,
          engineVersion: "0.5.0",
          whileHandling: "QUERY_STATE_HASH",
        },
        requestId,
      ),
    );
    await expect(pending).rejects.toThrow(/cannot step backwards/);
  });
});

describe("stale responses", () => {
  it("drops an answer whose request is no longer pending", async () => {
    const onProtocolViolation = vi.fn();
    const harness = createHarness({ onProtocolViolation });
    const pending = harness.client.queryEntity(1);
    const requestId = harness.sent[0]?.requestId as number;

    harness.deliver(response("ENTITY_DETAILS", { entityId: 1, details: null, tick: 1 }, requestId));
    await expect(pending).resolves.toMatchObject({ entityId: 1 });

    // The duplicate is the stale one: the caller already moved on. It must be
    // discarded silently rather than reported as a fault, or fast clicking
    // would fill the UI with spurious errors.
    harness.deliver(response("ENTITY_DETAILS", { entityId: 1, details: null, tick: 2 }, requestId));
    harness.deliver(response("ENTITY_DETAILS", { entityId: 99, details: null, tick: 2 }, 4242));
    expect(onProtocolViolation).not.toHaveBeenCalled();
  });

  it("still surfaces an error that arrives after its request was settled", () => {
    const onError = vi.fn();
    const harness = createHarness({ onError });
    harness.deliver(
      response(
        "ERROR",
        {
          message: "late failure",
          fatal: false,
          tick: 1,
          seed: 1,
          engineVersion: "0.5.0",
          whileHandling: "QUERY_ENTITY",
        },
        9999,
      ),
    );
    // Correlation is gone, but a failure must never vanish.
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "late failure" }));
  });

  it("fails every outstanding request when a fatal error arrives stale", async () => {
    // A fatal error whose own request has already been settled (or was never
    // pending here) still means the world is gone: everything else waiting for
    // that world must reject rather than hang forever.
    const harness = createHarness();
    const orphan = harness.client.queryEntity(5);
    harness.deliver(
      response(
        "ERROR",
        {
          message: "engine exploded",
          fatal: true,
          tick: 3,
          seed: 1,
          engineVersion: "0.5.0",
          whileHandling: "tick",
        },
        424_242,
      ),
    );
    await expect(orphan).rejects.toThrow("engine exploded");
    expect(harness.client.pendingRequestCount).toBe(0);
  });
});

describe("subscriptions", () => {
  it("routes uncorrelated messages to their handlers", () => {
    const onWorldReady = vi.fn();
    const onRenderSnapshot = vi.fn();
    const onVegetationSnapshot = vi.fn();
    const onTelemetry = vi.fn();
    const harness = createHarness({
      onWorldReady,
      onRenderSnapshot,
      onVegetationSnapshot,
      onTelemetry,
    });

    harness.deliver(
      response("WORLD_READY", {
        world: {},
        hostRuntime: {},
        terrain: new ArrayBuffer(8),
        telemetry: {},
      }),
    );
    harness.deliver(response("RENDER_SNAPSHOT", { buffer: new ArrayBuffer(8), tick: 1 }));
    harness.deliver(response("VEGETATION_SNAPSHOT", { buffer: new ArrayBuffer(8), tick: 1 }));
    harness.deliver(response("TELEMETRY", { tick: 1 }));

    expect(onWorldReady).toHaveBeenCalledOnce();
    expect(onRenderSnapshot).toHaveBeenCalledOnce();
    expect(onVegetationSnapshot).toHaveBeenCalledOnce();
    expect(onTelemetry).toHaveBeenCalledOnce();
  });

  it("reports an undecodable message as a protocol violation", () => {
    const onProtocolViolation = vi.fn();
    const harness = createHarness({ onProtocolViolation });
    harness.deliver({ protocolVersion: 999, type: "TELEMETRY", payload: {} });
    harness.deliver("not even an object");
    expect(onProtocolViolation).toHaveBeenCalledTimes(2);
  });
});

describe("failure and teardown", () => {
  it("fails every outstanding request when the worker reports a fatal error", async () => {
    const harness = createHarness();
    const pending = harness.client.queryEntity(1);
    harness.deliver(
      response("ERROR", {
        message: "engine exploded",
        fatal: true,
        tick: 10,
        seed: 1,
        engineVersion: "0.5.0",
        whileHandling: "tick",
      }),
    );
    await expect(pending).rejects.toThrow(/engine exploded/);
  });

  it("fails outstanding requests and closes the port on dispose", async () => {
    const harness = createHarness();
    const pending = harness.client.queryEntity(1);
    harness.client.dispose();

    await expect(pending).rejects.toThrow(/disposed/);
    expect(harness.closed()).toBe(true);
    expect(harness.client.closed).toBe(true);
    // A DISPOSE is sent first, so the host stops cleanly rather than being
    // killed mid-tick.
    expect(harness.sent.at(-1)?.type).toBe("DISPOSE");
  });

  it("refuses new work after disposal instead of hanging", async () => {
    const harness = createHarness();
    harness.client.dispose();
    const before = harness.sent.length;
    harness.client.setSpeed("x1");
    expect(harness.sent).toHaveLength(before);
    await expect(harness.client.queryEntity(1)).rejects.toThrow(/closed/);
  });
});
