import {
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  SimulationEngine,
} from "@eon/engine";
import { describe, expect, it } from "vitest";
import { crc32 } from "./crc32";
import {
  HEADER_BYTES,
  SNAPSHOT_CONTAINER_VERSION,
  SNAPSHOT_MAGIC,
  SnapshotFormatError,
  decodeDurableSnapshot,
  encodeDurableSnapshot,
  readSnapshotHeader,
  verifyRestoredStateHash,
} from "./durableSnapshot";
import { encodeValue } from "./valueCodec";

/** A small but fully populated world: organisms, genomes, species, events. */
function runWorld(ticks: number, seed = 0xe0a12026): SimulationEngine {
  const engine = new SimulationEngine({ seed, config: DEFAULT_CONFIG });
  engine.stepMany(ticks);
  return engine;
}

function encode(engine: SimulationEngine): Uint8Array {
  return encodeDurableSnapshot({
    snapshot: engine.serialize(),
    stateHash: engine.computeStateHash(),
    configHash: engine.configHash,
  });
}

/** Flip one bit, returning a copy — corruption that a length check cannot see. */
function corruptByte(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = bytes.slice();
  copy[offset] = (copy[offset] as number) ^ 0xff;
  return copy;
}

describe("durable snapshot container", () => {
  it("starts with the magic and a self-consistent header", () => {
    const engine = runWorld(50);
    const bytes = encode(engine);

    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    expect(magic).toBe(SNAPSHOT_MAGIC);

    const header = readSnapshotHeader(bytes);
    expect(header.containerVersion).toBe(SNAPSHOT_CONTAINER_VERSION);
    expect(header.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(header.engineVersion).toBe(ENGINE_VERSION);
    expect(header.seed).toBe(engine.seed);
    expect(header.tick).toBe(50);
    expect(header.stateHash).toBe(engine.computeStateHash());
    expect(header.configHash).toBe(engine.configHash);
    expect(header.payloadBytes).toBe(bytes.length - HEADER_BYTES);
    expect(header.payloadChecksum).toBe(crc32(bytes.subarray(HEADER_BYTES)));
  });

  it("round-trips every authoritative store", () => {
    const engine = runWorld(400);
    const original = engine.serialize();
    const { snapshot } = decodeDurableSnapshot(encode(engine));

    // Spot-check the shapes the engine is most sensitive to, then compare the
    // whole graph: exact typed-array classes included.
    expect(snapshot.organisms.freeSlots).toBeInstanceOf(Int32Array);
    expect(snapshot.organisms.brainWeights).toBeInstanceOf(Int16Array);
    expect(snapshot.environment.resourceBiomass).toBeInstanceOf(Uint16Array);
    expect(snapshot.history.detectors.populationRing).toBeInstanceOf(Float64Array);
    expect(snapshot).toEqual(original);
  });

  it("encodes the same state to the same bytes", () => {
    const engine = runWorld(120);
    expect(encode(engine)).toEqual(encode(engine));
  });

  it("does not disturb the engine it serializes", () => {
    const engine = runWorld(200);
    const before = engine.computeStateHash();
    const rngBefore = engine.getRngState();

    encode(engine);
    encode(engine);

    expect(engine.computeStateHash()).toBe(before);
    expect(engine.getRngState()).toEqual(rngBefore);

    // And the future is unchanged: saving consumed no authoritative randomness.
    const saved = SimulationEngine.fromSnapshot(engine.serialize());
    engine.stepMany(100);
    saved.stepMany(100);
    expect(saved.computeStateHash()).toBe(engine.computeStateHash());
  });
});

describe("rejecting snapshots that cannot be trusted", () => {
  const bytes = encode(runWorld(30));

  it("rejects data that is not a snapshot", () => {
    const notASnapshot = new Uint8Array(HEADER_BYTES + 10);
    expect(() => readSnapshotHeader(notASnapshot)).toThrow(
      expect.objectContaining({ code: "not-a-snapshot" }) as Error,
    );
  });

  it("rejects a truncated file", () => {
    expect(() => readSnapshotHeader(bytes.subarray(0, 20))).toThrow(
      expect.objectContaining({ code: "truncated" }) as Error,
    );
    expect(() => decodeDurableSnapshot(bytes.subarray(0, bytes.length - 64))).toThrow(
      expect.objectContaining({ code: "truncated" }) as Error,
    );
  });

  it("rejects a damaged header", () => {
    // Offset 64 is the seed: inside the header's checksummed range.
    expect(() => readSnapshotHeader(corruptByte(bytes, 64))).toThrow(
      expect.objectContaining({ code: "header-corrupt" }) as Error,
    );
  });

  it("rejects a damaged payload", () => {
    const damaged = corruptByte(bytes, HEADER_BYTES + 500);
    // The header still validates — which is the point of checksumming both.
    expect(readSnapshotHeader(damaged).tick).toBe(30);
    expect(() => decodeDurableSnapshot(damaged)).toThrow(
      expect.objectContaining({ code: "payload-corrupt" }) as Error,
    );
  });

  it("rejects an unknown container version", () => {
    const future = bytes.slice();
    new DataView(future.buffer).setUint16(8, SNAPSHOT_CONTAINER_VERSION + 1, true);
    resealHeader(future);
    expect(() => readSnapshotHeader(future)).toThrow(
      expect.objectContaining({ code: "unsupported-container" }) as Error,
    );
  });

  it("rejects reserved header bits it does not understand", () => {
    const future = bytes.slice();
    new DataView(future.buffer).setUint32(84, 1, true);
    resealHeader(future);
    expect(() => readSnapshotHeader(future)).toThrow(
      expect.objectContaining({ code: "unsupported-container" }) as Error,
    );
  });

  it("rejects a snapshot from another engine version", () => {
    const older = bytes.slice();
    older.fill(0, 16, 32);
    older.set(
      Uint8Array.from("0.0.1", (c) => c.charCodeAt(0)),
      16,
    );
    resealHeader(older);
    expect(() => decodeDurableSnapshot(older)).toThrow(
      expect.objectContaining({ code: "engine-mismatch" }) as Error,
    );
  });

  it("rejects an unsupported state schema", () => {
    const other = bytes.slice();
    new DataView(other.buffer).setUint32(12, SNAPSHOT_SCHEMA_VERSION + 1, true);
    resealHeader(other);
    expect(() => decodeDurableSnapshot(other)).toThrow(
      expect.objectContaining({ code: "unsupported-schema" }) as Error,
    );
  });

  it("rejects a payload whose shape is wrong", () => {
    const engine = runWorld(10);
    const snapshot = engine.serialize() as unknown as Record<string, unknown>;
    delete snapshot["carcasses"];
    const forged = forge(snapshot, engine.computeStateHash(), engine.configHash);
    expect(() => decodeDurableSnapshot(forged)).toThrow(
      expect.objectContaining({ code: "malformed-payload" }) as Error,
    );
  });

  it("rejects a payload whose identity disagrees with its header", () => {
    const engine = runWorld(10);
    const snapshot = engine.serialize() as unknown as Record<string, unknown>;
    snapshot["tick"] = 11;
    const forged = forge(snapshot, engine.computeStateHash(), engine.configHash, {
      tick: 10,
      seed: engine.seed,
    });
    // The header says tick 10, the payload claims 11: one of them was edited.
    expect(() => decodeDurableSnapshot(forged)).toThrow(
      expect.objectContaining({ code: "malformed-payload" }) as Error,
    );
  });

  it("rejects a config that no longer matches its digest", () => {
    const engine = runWorld(10);
    const snapshot = engine.serialize();
    const tampered = {
      ...snapshot,
      config: { ...snapshot.config, limits: { ...snapshot.config.limits, maxOrganisms: 9 } },
    } as unknown as Record<string, unknown>;
    const forged = forge(tampered, engine.computeStateHash(), engine.configHash, {
      tick: snapshot.tick,
      seed: snapshot.seed,
    });
    expect(() => decodeDurableSnapshot(forged)).toThrow(
      expect.objectContaining({ code: "config-mismatch" }) as Error,
    );
  });

  it("rejects a restored world that does not hash to what was saved", () => {
    const engine = runWorld(25);
    const header = readSnapshotHeader(encode(engine));
    expect(() => verifyRestoredStateHash(header, "0000000000000000")).toThrow(
      expect.objectContaining({ code: "state-hash-mismatch" }) as Error,
    );
    expect(() => verifyRestoredStateHash(header, engine.computeStateHash())).not.toThrow();
  });

  it("keeps SnapshotFormatError distinguishable from other failures", () => {
    const error = new SnapshotFormatError("payload-corrupt", "boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SnapshotFormatError");
    expect(error.code).toBe("payload-corrupt");
  });
});

/** Recompute the header checksum after deliberately editing a header field. */
function resealHeader(bytes: Uint8Array): void {
  new DataView(bytes.buffer).setUint32(92, crc32(bytes.subarray(0, 92)), true);
}

/**
 * Build a container around a hand-edited payload, with every checksum correct.
 * This is what a malicious or hand-patched save looks like: internally
 * consistent bytes that still must not be trusted.
 */
function forge(
  payloadValue: unknown,
  stateHash: string,
  configHash: string,
  identity?: { tick: number; seed: number },
): Uint8Array {
  const source = payloadValue as { tick: number; seed: number; schemaVersion: number };
  const payload = encodeValue(payloadValue);
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out.set(
    Uint8Array.from(SNAPSHOT_MAGIC, (c) => c.charCodeAt(0)),
    0,
  );
  const view = new DataView(out.buffer);
  view.setUint16(8, SNAPSHOT_CONTAINER_VERSION, true);
  view.setUint16(10, HEADER_BYTES, true);
  view.setUint32(12, SNAPSHOT_SCHEMA_VERSION, true);
  out.set(
    Uint8Array.from(ENGINE_VERSION, (c) => c.charCodeAt(0)),
    16,
  );
  out.set(
    Uint8Array.from(configHash, (c) => c.charCodeAt(0)),
    32,
  );
  out.set(
    Uint8Array.from(stateHash, (c) => c.charCodeAt(0)),
    48,
  );
  view.setUint32(64, (identity?.seed ?? source.seed) >>> 0, true);
  view.setUint32(68, (identity?.tick ?? source.tick) >>> 0, true);
  view.setUint32(72, 0, true);
  view.setUint32(76, payload.length, true);
  view.setUint32(80, crc32(payload), true);
  out.set(payload, HEADER_BYTES);
  resealHeader(out.subarray(0, HEADER_BYTES));
  // resealHeader wrote into the subarray's own view of the same buffer.
  view.setUint32(92, crc32(out.subarray(0, 92)), true);
  return out;
}
