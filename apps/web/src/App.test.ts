import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("web shell", () => {
  it("exports the App component (workspace wiring smoke test)", () => {
    expect(typeof App).toBe("function");
  });
});
