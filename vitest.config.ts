import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.{ts,tsx}"],
    // The determinism acceptance tests are inherently long: they generate whole
    // worlds and run thousands of authoritative ticks (10 000 for the golden
    // fixture, more for soak tests). The default 5 s budget fails them for
    // being slow rather than for being wrong.
    testTimeout: 60_000,
  },
});
