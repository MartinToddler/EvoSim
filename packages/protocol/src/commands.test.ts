import { describe, expect, it } from "vitest";
import { resampleStroke, type StrokePointLU } from "./commands";
import { PROTOCOL_VERSION } from "./version";
import { decodeMainToWorkerMessage } from "./messages";

/**
 * Canonical stroke resampling (task J02, docs/02 §16): raw pointer paths are
 * NOT authoritative history — the resampler is what turns them into the
 * canonical, quantized, device-independent command samples.
 */

const OPTIONS = { spacingLU: 8, maxSamples: 64, worldSizeLU: 4096 };

/** Sample a parametric path at `n` evenly spaced parameter values (a fake pointer stream). */
function sampled(n: number, path: (t: number) => StrokePointLU): StrokePointLU[] {
  const points: StrokePointLU[] = [];
  for (let i = 0; i <= n; i += 1) {
    points.push(path(i / n));
  }
  return points;
}

describe("resampleStroke", () => {
  it("resamples at fixed world spacing along the path and keeps the endpoint", () => {
    const line = (t: number): StrokePointLU => ({ xLU: 100 + 40 * t, yLU: 200 });
    const stroke = resampleStroke(sampled(10, line), OPTIONS);
    expect(stroke.samplesXLU).toEqual([100, 108, 116, 124, 132, 140]);
    expect(stroke.samplesYLU).toEqual([200, 200, 200, 200, 200, 200]);
    expect(stroke.truncated).toBe(false);
  });

  it("the same straight stroke sampled at wildly different pointer rates is identical", () => {
    const line = (t: number): StrokePointLU => ({ xLU: 100.3 + 97.4 * t, yLU: 350.8 - 41.2 * t });
    const slow = resampleStroke(sampled(2, line), OPTIONS);
    const medium = resampleStroke(sampled(17, line), OPTIONS);
    const fast = resampleStroke(sampled(500, line), OPTIONS);
    expect(medium).toEqual(slow);
    expect(fast).toEqual(slow);
  });

  it("a smooth curve sampled at realistic pointer rates canonicalizes identically", () => {
    // A quarter-circle of radius 120 LU. At 60+ samples the chordal error is
    // far below the 0.5 LU quantization margin, so event frequency vanishes.
    const arc = (t: number): StrokePointLU => ({
      xLU: 500 + 120 * Math.cos((Math.PI / 2) * t),
      yLU: 500 + 120 * Math.sin((Math.PI / 2) * t),
    });
    const at60 = resampleStroke(sampled(60, arc), OPTIONS);
    const at240 = resampleStroke(sampled(240, arc), OPTIONS);
    const at960 = resampleStroke(sampled(960, arc), OPTIONS);
    expect(at240).toEqual(at60);
    expect(at960).toEqual(at60);
    expect(at60.samplesXLU.length).toBeGreaterThan(10);
  });

  it("a click (single point or sub-spacing wiggle) canonicalizes to one sample", () => {
    expect(resampleStroke([{ xLU: 77.4, yLU: 12.6 }], OPTIONS)).toEqual({
      samplesXLU: [77],
      samplesYLU: [13],
      truncated: false,
    });
    const wiggle = resampleStroke(
      [
        { xLU: 77.4, yLU: 12.6 },
        { xLU: 77.45, yLU: 12.55 },
        { xLU: 77.42, yLU: 12.61 },
      ],
      OPTIONS,
    );
    expect(wiggle.samplesXLU).toEqual([77]);
    expect(wiggle.samplesYLU).toEqual([13]);
  });

  it("clamps points into the world and drops non-finite ones", () => {
    const stroke = resampleStroke(
      [
        { xLU: -50, yLU: 10 },
        { xLU: Number.NaN, yLU: 10 },
        { xLU: 5000, yLU: 10 },
      ],
      { ...OPTIONS, maxSamples: 1024 },
    );
    expect(stroke.samplesXLU[0]).toBe(0);
    expect(stroke.samplesXLU[stroke.samplesXLU.length - 1]).toBe(4096);
    for (const x of stroke.samplesXLU) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(4096);
    }
  });

  it("truncates at the sample cap and says so", () => {
    const line = (t: number): StrokePointLU => ({ xLU: 4000 * t, yLU: 100 });
    const stroke = resampleStroke(sampled(100, line), { ...OPTIONS, maxSamples: 10 });
    expect(stroke.samplesXLU).toHaveLength(10);
    expect(stroke.truncated).toBe(true);
    // The kept prefix is the earliest part of the stroke.
    expect(stroke.samplesXLU[0]).toBe(0);
    expect(stroke.samplesXLU[9]).toBe(72);
  });

  it("returns an empty stroke for no usable points", () => {
    expect(resampleStroke([], OPTIONS)).toEqual({
      samplesXLU: [],
      samplesYLU: [],
      truncated: false,
    });
    expect(resampleStroke([{ xLU: Number.NaN, yLU: Number.NaN }], OPTIONS).samplesXLU).toEqual([]);
  });
});

describe("QUEUE_COMMAND decoding", () => {
  function message(command: unknown): unknown {
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 7,
      type: "QUEUE_COMMAND",
      payload: { command },
    };
  }

  function messageWithoutRequestId(command: unknown): unknown {
    return { protocolVersion: PROTOCOL_VERSION, type: "QUEUE_COMMAND", payload: { command } };
  }

  it("decodes a brush request", () => {
    const decoded = decodeMainToWorkerMessage(
      message({
        kind: "paintMoisture",
        radiusLU: 32,
        strength: -256,
        falloff: "linear",
        samplesXLU: [10, 20],
        samplesYLU: [10, 20],
        targetTick: null,
      }),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.message.type === "QUEUE_COMMAND") {
      expect(decoded.message.payload.command.kind).toBe("paintMoisture");
    }
  });

  it("decodes global temperature and meteor requests", () => {
    expect(
      decodeMainToWorkerMessage(message({ kind: "setGlobalTemperature", offsetCentiC: -300 })).ok,
    ).toBe(true);
    expect(
      decodeMainToWorkerMessage(
        message({ kind: "meteor", centerXLU: 100, centerYLU: 100, radiusLU: 48 }),
      ).ok,
    ).toBe(true);
  });

  it("rejects unknown kinds, bad falloffs, mismatched samples and a missing requestId", () => {
    expect(decodeMainToWorkerMessage(message({ kind: "smite" })).ok).toBe(false);
    expect(
      decodeMainToWorkerMessage(
        message({
          kind: "raiseTerrain",
          radiusLU: 8,
          strength: 100,
          falloff: "gaussian",
          samplesXLU: [1],
          samplesYLU: [1],
        }),
      ).ok,
    ).toBe(false);
    expect(
      decodeMainToWorkerMessage(
        message({
          kind: "raiseTerrain",
          radiusLU: 8,
          strength: 100,
          falloff: "hard",
          samplesXLU: [1, 2],
          samplesYLU: [1],
        }),
      ).ok,
    ).toBe(false);
    expect(
      decodeMainToWorkerMessage(
        messageWithoutRequestId({ kind: "setGlobalTemperature", offsetCentiC: 100 }),
      ).ok,
    ).toBe(false);
  });

  it("passes value judgements through to the engine (floats decode fine)", () => {
    // Structural decode only: a non-integer strength is the ENGINE's to reject,
    // as a deterministic COMMAND_RESULT the UI can show.
    const decoded = decodeMainToWorkerMessage(
      message({
        kind: "addBiomass",
        radiusLU: 16,
        strength: 10.5,
        falloff: "hard",
        samplesXLU: [1],
        samplesYLU: [1],
      }),
    );
    expect(decoded.ok).toBe(true);
  });
});
