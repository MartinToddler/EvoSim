import { describe, expect, it } from "vitest";
import { addAngle, degreesToSteps, signedAngleDiff, wrapAngle } from "./angle";
import { ANGLE_STEPS } from "./fixed";

describe("wrapAngle", () => {
  it("keeps in-range values", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(4095)).toBe(4095);
  });

  it("wraps overflow and negatives", () => {
    expect(wrapAngle(ANGLE_STEPS)).toBe(0);
    expect(wrapAngle(ANGLE_STEPS + 5)).toBe(5);
    expect(wrapAngle(-1)).toBe(4095);
    expect(wrapAngle(-4097)).toBe(4095);
  });
});

describe("addAngle", () => {
  it("adds with wrap in both directions", () => {
    expect(addAngle(4090, 10)).toBe(4);
    expect(addAngle(5, -10)).toBe(4091);
    expect(addAngle(2048, 2048)).toBe(0);
  });
});

describe("signedAngleDiff", () => {
  it("returns the shortest signed difference", () => {
    expect(signedAngleDiff(0, 10)).toBe(10);
    expect(signedAngleDiff(10, 0)).toBe(-10);
    expect(signedAngleDiff(4090, 10)).toBe(16); // across the wrap point
    expect(signedAngleDiff(10, 4090)).toBe(-16);
  });

  it("maps the exact half turn to -HALF (range [-2048, 2048))", () => {
    expect(signedAngleDiff(0, 2048)).toBe(-2048);
  });
});

describe("degreesToSteps", () => {
  it("converts round angles", () => {
    expect(degreesToSteps(0)).toBe(0);
    expect(degreesToSteps(90)).toBe(1024);
    expect(degreesToSteps(180)).toBe(2048);
    expect(degreesToSteps(270)).toBe(3072);
    expect(degreesToSteps(360)).toBe(0);
    expect(degreesToSteps(-90)).toBe(3072);
  });
});
