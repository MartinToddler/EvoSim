import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.{ts,tsx}"],
    // The determinism acceptance tests are inherently long: they generate whole
    // worlds and run thousands of authoritative ticks (10 000 for the golden
    // fixture, 100 000 for the soaks). The default 5 s budget fails them for
    // being slow rather than for being wrong.
    //
    // Raised from 60 s at Milestone 4. Reproduction made the reference world
    // stay populated instead of dying out by tick 6 100, so a 10 000-tick run
    // costs ~150 s of real simulation rather than ~9 s. The soaks set their own,
    // longer budgets inline.
    testTimeout: 300_000,
  },
});
