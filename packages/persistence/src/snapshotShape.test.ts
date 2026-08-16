import { DEFAULT_CONFIG, InterventionKind, SimulationEngine } from "@eon/engine";
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_SHAPE,
  SnapshotShapeError,
  normalizeSnapshotShape,
  type FieldSpec,
} from "./snapshotShape";

/**
 * The completeness audit.
 *
 * `SNAPSHOT_SHAPE` is the durable format's promise about what survives a save.
 * The first test here walks a *real* snapshot from a world that has actually
 * lived — organisms, carcasses, species, events, statistics, a command log —
 * and fails if the engine produced any field the shape does not describe.
 *
 * That is the mechanism that keeps this from rotting: the next milestone to add
 * authoritative state will fail this test until the durable format knows about
 * it. A snapshot silently missing a field is the one persistence bug that does
 * not announce itself — the save loads, and the world quietly diverges.
 */

function livedInWorld(): SimulationEngine {
  const engine = new SimulationEngine({ seed: 0xe0a12026, config: DEFAULT_CONFIG });
  engine.stepMany(1200);
  // A pending command and an applied one, so the command log is non-trivial.
  engine.queueCommand({ kind: InterventionKind.SetGlobalTemperature, offsetCentiC: 120 });
  engine.stepMany(50);
  engine.queueCommand({
    kind: InterventionKind.Meteor,
    centerXLU: 500,
    centerYLU: 500,
    radiusLU: 40,
    targetTick: engine.tick + 500,
  });
  return engine;
}

/** Every leaf path the shape declares, as dotted strings. */
function shapePaths(spec: FieldSpec, prefix: string): string[] {
  if (spec.kind === "object") {
    return Object.entries(spec.fields).flatMap(([key, field]) =>
      shapePaths(field, prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  if (spec.kind === "arrayOf") {
    return shapePaths(spec.element, `${prefix}[]`);
  }
  return [prefix];
}

/**
 * Every leaf path a real snapshot contains, stopping wherever the shape stops
 * (a `json` field is a leaf, and so is a typed array).
 */
function valuePaths(value: unknown, spec: FieldSpec | undefined, prefix: string): string[] {
  if (spec === undefined) {
    // Nothing describes this subtree: report the path itself as undeclared.
    return [prefix];
  }
  if (spec.kind === "object") {
    if (typeof value !== "object" || value === null) {
      return [prefix];
    }
    return Object.keys(value as Record<string, unknown>).flatMap((key) =>
      valuePaths(
        (value as Record<string, unknown>)[key],
        spec.fields[key],
        prefix === "" ? key : `${prefix}.${key}`,
      ),
    );
  }
  if (spec.kind === "arrayOf") {
    if (!Array.isArray(value) || value.length === 0) {
      return [`${prefix}[]`];
    }
    // Every element must satisfy the same element shape; the union of their
    // paths catches an optional field present on only some records.
    return [...new Set(value.flatMap((entry) => valuePaths(entry, spec.element, `${prefix}[]`)))];
  }
  return [prefix];
}

describe("durable shape covers everything the engine serializes", () => {
  const snapshot = livedInWorld().serialize();

  it("declares every field a real snapshot contains", () => {
    const declared = new Set(shapePaths(SNAPSHOT_SHAPE, ""));
    const actual = new Set(valuePaths(snapshot, SNAPSHOT_SHAPE, ""));

    const undeclared = [...actual].filter((path) => !declared.has(path)).sort();
    expect(
      undeclared,
      "the engine serializes state the durable snapshot shape does not describe; " +
        "add it to SNAPSHOT_SHAPE (and check the codec round-trips it) before shipping",
    ).toEqual([]);
  });

  it("declares nothing the engine does not produce", () => {
    const declared = new Set(shapePaths(SNAPSHOT_SHAPE, ""));
    const actual = new Set(valuePaths(snapshot, SNAPSHOT_SHAPE, ""));

    const stale = [...declared].filter((path) => !actual.has(path)).sort();
    expect(stale, "the shape declares fields the engine no longer produces").toEqual([]);
  });

  it("covers the stores this milestone is about", () => {
    // A readable statement of the audit list, so a reviewer can see at a
    // glance which subsystems the format is claimed to carry.
    const declared = shapePaths(SNAPSHOT_SHAPE, "");
    for (const path of [
      "tick",
      "seed",
      "config",
      "rngState",
      "generationAttempt",
      "environment.plantBiomass",
      "environment.globalTemperatureOffsetCentiC",
      "organisms.freeSlots",
      "organisms.nextEntityId",
      "organisms.genes",
      "organisms.morphGenes",
      "organisms.brainWeights",
      "organisms.energy",
      "organisms.attackCooldown",
      "organisms.reproductionCooldown",
      "carcasses.freeSlots",
      "carcasses.remainingMeat",
      "species.nextSpeciesId",
      "species.records[].candidatePasses",
      "history.stats.worldSampleCount",
      "history.detectors.populationRing",
      "history.events.nextEventId",
      "commands.cursor",
      "commands.commands",
    ]) {
      expect(declared, `${path} must be persisted`).toContain(path);
    }
  });
});

describe("shape validation of untrusted payloads", () => {
  const snapshot = new SimulationEngine({
    seed: 0xe0a12026,
    config: DEFAULT_CONFIG,
  }).serialize();

  it("accepts a genuine snapshot and returns plain objects", () => {
    const normalized = normalizeSnapshotShape(snapshot) as Record<string, unknown>;
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(normalized["tick"]).toBe(0);
  });

  it("strips fields it does not declare", () => {
    const withExtra = { ...snapshot, smuggled: 42 } as unknown;
    const normalized = normalizeSnapshotShape(withExtra) as Record<string, unknown>;
    expect(normalized["smuggled"]).toBeUndefined();
  });

  it("rejects a missing store", () => {
    const missing = { ...snapshot } as unknown as Record<string, unknown>;
    delete missing["species"];
    expect(() => normalizeSnapshotShape(missing)).toThrow(SnapshotShapeError);
  });

  it("rejects a typed array of the wrong width", () => {
    const wrong = {
      ...snapshot,
      environment: { ...snapshot.environment, plantBiomass: new Uint8Array(4) },
    } as unknown;
    expect(() => normalizeSnapshotShape(wrong)).toThrow(/Uint16Array/);
  });

  it("rejects a number field that is not a number", () => {
    const wrong = { ...snapshot, tick: "12" } as unknown;
    expect(() => normalizeSnapshotShape(wrong)).toThrow(/finite number/);
  });

  it("rejects a PRNG state of the wrong length", () => {
    const wrong = { ...snapshot, rngState: [1, 2, 3] } as unknown;
    expect(() => normalizeSnapshotShape(wrong)).toThrow(/4 numbers/);
  });

  it("rejects non-JSON data in a free-form field", () => {
    const wrong = { ...snapshot, config: { grid: new Uint8Array(2) } } as unknown;
    expect(() => normalizeSnapshotShape(wrong)).toThrow(/JSON-safe/);
  });
});
