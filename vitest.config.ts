import { defineConfig } from "vitest/config";

// T5: the vitest environment pins PI_SLOP_GATE=off so the orchestrator's
// slop-gate runner resolves to undefined during tests — no scanner tool is
// ever resolved or invoked unless a test overrides the variable itself.
export default defineConfig({
  test: {
    env: {
      PI_SLOP_GATE: "off",
    },
  },
});
