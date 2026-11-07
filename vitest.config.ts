import { defineConfig } from "vitest/config";

// T5: the vitest environment pins PI_SLOP_GATE=off so the orchestrator's
// slop-gate runner resolves to undefined during tests — no scanner tool is
// ever resolved or invoked unless a test overrides the variable itself.
export default defineConfig({
  test: {
    // F7: tolerate orchestrated-run load and avoid CPU oversubscription.
    testTimeout: 15000,
    hookTimeout: 15000,
    maxWorkers: "50%",
    env: {
      PI_SLOP_GATE: "off",
    },
  },
});
