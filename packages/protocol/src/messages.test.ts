import { describe, expect, it } from "vitest";
import {
  decodeMainToWorkerMessage,
  decodeWorkerToMainMessage,
  envelope,
  requestEnvelope,
} from "./messages";
import { PROTOCOL_VERSION } from "./version";

function main(type: string, payload: unknown, requestId?: number): unknown {
  return requestId === undefined
    ? { protocolVersion: PROTOCOL_VERSION, type, payload }
    : { protocolVersion: PROTOCOL_VERSION, requestId, type, payload };
}

describe("envelope construction", () => {
  it("stamps the current protocol version", () => {
    expect(envelope("SET_RUN_STATE", { speed: "x1" }).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("attaches a requestId only when one is given", () => {
    expect(envelope("TELEMETRY", {}).requestId).toBeUndefined();
    expect(requestEnvelope("STATE_HASH", {}, 42).requestId).toBe(42);
  });
});

describe("decodeMainToWorkerMessage", () => {
  it("accepts every message type in the union", () => {
    const buffer = new ArrayBuffer(8);
    const cases: unknown[] = [
      main("INIT_NEW_WORLD", { seed: 1, config: null, hostRuntime: null, speed: "paused" }),
      main("SET_RUN_STATE", { speed: "max" }),
      main("QUERY_ENTITY", { entityId: 3 }, 1),
      main("QUERY_STATE_HASH", { targetTick: 100 }, 2),
      main("RECYCLE_RENDER_BUFFER", { buffer }),
      main("RECYCLE_VEGETATION_BUFFER", { buffer }),
      main("SET_RENDER_STREAM", { enabled: false }),
      main("DISPOSE", {}),
    ];
    for (const message of cases) {
      const result = decodeMainToWorkerMessage(message);
      expect(result.ok, JSON.stringify(message)).toBe(true);
    }
  });

  // Malformed input must produce a reason, never an exception: the worker's
  // onmessage handler is where a throw becomes an unattributable ErrorEvent.
  it.each([
    ["a non-object", 42],
    ["null", null],
    ["a string", "SET_RUN_STATE"],
    ["a missing protocol version", { type: "DISPOSE", payload: {} }],
    ["a future protocol version", { protocolVersion: 999, type: "DISPOSE", payload: {} }],
    ["an unknown type", main("DEFENESTRATE_WORLD", {})],
    ["a non-object payload", { protocolVersion: PROTOCOL_VERSION, type: "DISPOSE", payload: 7 }],
    ["a missing payload", { protocolVersion: PROTOCOL_VERSION, type: "DISPOSE" }],
    ["a bad speed", main("SET_RUN_STATE", { speed: "x3" })],
    [
      "a non-integer seed",
      main("INIT_NEW_WORLD", { seed: 1.5, config: null, hostRuntime: null, speed: "x1" }),
    ],
    ["a negative entity id", main("QUERY_ENTITY", { entityId: -1 }, 1)],
    ["a non-ArrayBuffer recycle", main("RECYCLE_RENDER_BUFFER", { buffer: [1, 2, 3] })],
    ["a non-boolean render stream flag", main("SET_RENDER_STREAM", { enabled: "yes" })],
    ["a fractional requestId", main("QUERY_ENTITY", { entityId: 1 }, 1.5)],
  ])("rejects %s with a reason", (_label, message) => {
    const result = decodeMainToWorkerMessage(message);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("requires a requestId on messages that expect an answer", () => {
    // Without correlation the caller could never tell which query an answer
    // belongs to, so accepting one would be worse than rejecting it.
    const entity = decodeMainToWorkerMessage(main("QUERY_ENTITY", { entityId: 1 }));
    expect(entity.ok).toBe(false);
    const hash = decodeMainToWorkerMessage(main("QUERY_STATE_HASH", { targetTick: null }));
    expect(hash.ok).toBe(false);
  });

  it("preserves the requestId it was given", () => {
    const result = decodeMainToWorkerMessage(main("QUERY_ENTITY", { entityId: 9 }, 77));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.requestId).toBe(77);
    }
  });

  it("passes an unvalidated config straight through for the engine to judge", () => {
    // @eon/protocol must not depend on @eon/engine, so config validation is the
    // engine's job — the protocol only guarantees the envelope.
    const result = decodeMainToWorkerMessage(
      main("INIT_NEW_WORLD", {
        seed: 5,
        config: { nonsense: true },
        hostRuntime: null,
        speed: "x1",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "INIT_NEW_WORLD") {
      expect(result.message.payload.config).toEqual({ nonsense: true });
    }
  });

  it("normalizes a missing config to null", () => {
    const result = decodeMainToWorkerMessage(
      main("INIT_NEW_WORLD", { seed: 5, hostRuntime: null, speed: "x1" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "INIT_NEW_WORLD") {
      expect(result.message.payload.config).toBeNull();
    }
  });
});

describe("decodeWorkerToMainMessage", () => {
  it("accepts the worker's message types", () => {
    for (const type of [
      "WORLD_READY",
      "RENDER_SNAPSHOT",
      "VEGETATION_SNAPSHOT",
      "TELEMETRY",
      "ENTITY_DETAILS",
      "STATE_HASH",
      "ERROR",
    ]) {
      expect(decodeWorkerToMainMessage(main(type, {})).ok).toBe(true);
    }
  });

  it("rejects a message from a page and worker built at different versions", () => {
    const result = decodeWorkerToMainMessage({
      protocolVersion: PROTOCOL_VERSION + 1,
      type: "TELEMETRY",
      payload: {},
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown worker message type", () => {
    expect(decodeWorkerToMainMessage(main("SURPRISE", {})).ok).toBe(false);
  });
});
