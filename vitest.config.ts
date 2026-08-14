import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/src/**/*.test.{ts,tsx}", "apps/**/src/**/*.test.{ts,tsx}"],
    // The determinism acceptance tests are inherently long: they generate whole
    // worlds and run thousands of authoritative ticks (10 000 for the golden
    // fixture, 100 000 for the soaks). The default 5 s budget fails them for
    // being slow rather than for being wrong.
    //
    // This is a hang detector, NOT a performance assertion. docs/07 §8 forbids
    // enforcing an arbitrary CI wall clock on unknown hardware, and the
    // Milestone 4 budget broke that rule: 300 s was set from a ~150 s
    // measurement, but Vitest runs test files in parallel workers, so the
    // 10 000-tick reference-world tests compete with the 100 000-tick soak and
    // each other. Measured on the Milestone 4 review machine: the reference
    // world costs 188 s of simulation standalone (`pnpm headless --ticks
    // 10000`) and 429-520 s inside the suite — a 2.3-2.8x contention factor
    // that put two mandated acceptance tests over the cap and failed
    // `pnpm verify` without any hash being wrong.
    //
    // 600 s therefore carries 3x headroom over the heaviest test that fits
    // here; the inherently-long determinism tests and the soaks set their own
    // larger budgets inline, where the cost is visible next to the tick count.
    testTimeout: 600_000,
  },
});
