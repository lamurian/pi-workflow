import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  mockPi,
  ctxWithState,
  finalizingState,
  runOrchestratedViaSeam,
} from "./helpers/implement-harness.ts";

/**
 * Control for the partial baseline-failures mock: when armed, the mocked
 * capture cancels the orchestration through the real API mid-capture.
 * `ctx` is the context cancelOrchestration is invoked with (its param is
 * unused, kept for API symmetry).
 */
const control = vi.hoisted(() => ({
  cancelDuringCapture: false,
  cancelDuringEnsure: false,
  ctx: undefined as unknown,
}));

vi.mock("../extensions/baseline-failures.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../extensions/baseline-failures.ts")>();
  const cancel = await import("../extensions/orchestration-cancel.ts");
  return {
    ...orig,
    captureBaselineFailures: async (...a: Parameters<typeof orig.captureBaselineFailures>) => {
      if (control.cancelDuringCapture) {
        // Yield so runImplement's synchronous launch block (claim +
        // beginOrchestration) finishes first; then observe the cancellation
        // the way a /discuss cancel would: set the flag via the real API.
        await Promise.resolve();
        cancel.beginOrchestration(Promise.resolve());
        await cancel.cancelOrchestration(control.ctx as ExtensionContext);
      }
      return orig.captureBaselineFailures(...a);
    },
  };
});

// Partial ensure mock: when armed, the mocked start ensure sets the cancelled
// flag through the real API and reports the chore failure the T9(b) checkpoint
// must beat (cancellation wins: no halt, no lastHalt, no preflight).
vi.mock("../extensions/test-tool-ensure.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../extensions/test-tool-ensure.ts")>();
  const cancel = await import("../extensions/orchestration-cancel.ts");
  return {
    ...orig,
    ensureTestExtensionAtStart: async (...a: Parameters<typeof orig.ensureTestExtensionAtStart>) => {
      if (control.cancelDuringEnsure) {
        // Observe the cancellation the way a /discuss cancel would: set the
        // flag via the real API, then still report the chore failure.
        await Promise.resolve();
        cancel.beginOrchestration(Promise.resolve());
        await cancel.cancelOrchestration(control.ctx as ExtensionContext);
        return {
          kind: "failed" as const,
          message: "test extension chore commit failed",
          investigation: "commit rejected",
        };
      }
      return orig.ensureTestExtensionAtStart(...a);
    },
  };
});

// ═══ T9(a): cancellation checkpoint after baseline capture ═══
describe("T9(a): cancellation checkpoint after baseline capture", () => {
  it("a cancellation observed during baseline capture returns a cancelled result with no unit spawned and no lastHalt", async () => {
    control.cancelDuringCapture = true;
    try {
      const pi = mockPi();
      const state = finalizingState();
      const ctx = ctxWithState(state);
      control.ctx = ctx;
      const notifies: string[] = [];
      ctx.ui.notify = ((msg: string) => {
        notifies.push(msg);
      }) as unknown as ExtensionContext["ui"]["notify"];

      const spawns: string[] = [];
      const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
        spawns.push(unit.behaviorId);
        return { summary: "x", suggestedCommit: "feat: x" };
      });

      // Cancelled result shape.
      assert.equal(result.complete, false, "cancelled run is not complete");
      assert.equal(result.cancelled, true, "result carries cancelled: true");
      assert.equal(result.unitsRun, 0, "no unit counted");
      assert.deepEqual(result.landedCommits, [], "no landed commits");
      assert.deepEqual(result.satisfiedWithoutCommit, [], "nothing satisfied without commit");
      assert.equal(result.haltedOn, undefined, "no halt recorded");
      assert.equal(result.error, undefined, "no halt error recorded");

      // No unit spawn.
      assert.deepEqual(spawns, [], "the injected unit runner is never invoked");

      // No lastHalt persisted.
      assert.equal(state.lastHalt, undefined, "state.lastHalt stays unset");
      const haltSaves = ((pi.calls["appendEntry"] ?? []) as Array<[string, { lastHalt?: unknown }]>)
        .filter(([key, data]) => key === "workflow-state" && data?.lastHalt !== undefined);
      assert.deepEqual(haltSaves, [], "no persisted workflow-state entry carries lastHalt");

      // No halt notification (and no report/steer from the .then handler).
      const haltNotifies = notifies.filter((m) => /Orchestration halted/.test(m));
      assert.deepEqual(haltNotifies, [], "no halt notification fires");
      assert.equal(
        (pi.calls["sendUserMessage"] ?? []).length,
        0,
        "no completion or halt report is delivered",
      );
    } finally {
      control.cancelDuringCapture = false;
      control.ctx = undefined;
    }
  });
});

// ═══ T9(b): cancellation checkpoint after the start ensure step ═══
describe("T9(b): cancellation checkpoint after the start ensure step", () => {
  it("a cancellation observed after ensureTestExtensionAtStart returns a cancelled result before any unit spawns, with no halt notification and no lastHalt write", async () => {
    control.cancelDuringEnsure = true;
    try {
      const pi = mockPi();
      const state = finalizingState();
      const ctx = ctxWithState(state);
      control.ctx = ctx;
      const notifies: string[] = [];
      ctx.ui.notify = ((msg: string) => {
        notifies.push(msg);
      }) as unknown as ExtensionContext["ui"]["notify"];

      const spawns: string[] = [];
      const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
        spawns.push(unit.behaviorId);
        return { summary: "x", suggestedCommit: "feat: x" };
      });

      // Cancelled result shape (cancellation wins over the chore-fail halt).
      assert.equal(result.complete, false, "cancelled run is not complete");
      assert.equal(result.cancelled, true, "result carries cancelled: true");
      assert.equal(result.unitsRun, 0, "no unit counted");
      assert.deepEqual(result.landedCommits, [], "no landed commits");
      assert.deepEqual(result.satisfiedWithoutCommit, [], "nothing satisfied without commit");
      assert.equal(result.haltedOn, undefined, "no halt recorded");
      assert.equal(result.error, undefined, "no halt error recorded");

      // No unit spawn.
      assert.deepEqual(spawns, [], "the injected unit runner is never invoked");

      // No lastHalt persisted.
      assert.equal(state.lastHalt, undefined, "state.lastHalt stays unset");
      const haltSaves = ((pi.calls["appendEntry"] ?? []) as Array<[string, { lastHalt?: unknown }]>)
        .filter(([key, data]) => key === "workflow-state" && data?.lastHalt !== undefined);
      assert.deepEqual(haltSaves, [], "no persisted workflow-state entry carries lastHalt");

      // No halt notification, no report/steer from the .then handler.
      const haltNotifies = notifies.filter((m) => /Orchestration halted/.test(m));
      assert.deepEqual(haltNotifies, [], "no halt notification fires");
      assert.equal(
        (pi.calls["sendUserMessage"] ?? []).length,
        0,
        "no completion or halt report is delivered",
      );
    } finally {
      control.cancelDuringEnsure = false;
      control.ctx = undefined;
    }
  });
});
