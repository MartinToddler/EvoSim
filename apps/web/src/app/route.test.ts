import { describe, expect, it } from "vitest";
import { readViewFromLocation, toggleViewHref } from "./route";

describe("app route", () => {
  it("shows the simulation by default, and for anything unrecognized", () => {
    expect(readViewFromLocation("")).toBe("simulation");
    expect(readViewFromLocation("?seed=0x1")).toBe("simulation");
    expect(readViewFromLocation("?view=nonsense")).toBe("simulation");
  });

  it("shows the generator when asked", () => {
    expect(readViewFromLocation("?view=generator")).toBe("generator");
    expect(readViewFromLocation("?seed=0xE0A12026&view=generator")).toBe("generator");
  });

  it("keeps the seed when switching screens, so a link stays about one world", () => {
    expect(toggleViewHref("?seed=0xE0A12026", "generator")).toBe("?seed=0xE0A12026&view=generator");
    expect(toggleViewHref("?seed=0xE0A12026&view=generator", "simulation")).toBe(
      "?seed=0xE0A12026",
    );
  });

  it("produces a usable href when nothing else is in the query", () => {
    expect(toggleViewHref("", "generator")).toBe("?view=generator");
    expect(toggleViewHref("?view=generator", "simulation")).toBe("?");
  });
});
