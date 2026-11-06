// T4: halt immediately on an identical repeated hook rejection — pure
// normalization/decision plus the behavior-loop wiring that stops before
// another fix round when the second rejection repeats the first.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildIdenticalRejectionHalt,
  isIdenticalRejection,
  normalizeHookOutput,
  type RejectionSnapshot,
} from "../extensions/identical-rejection.ts";
import {
  runOrchestratedImplement,
  type OrchestratorResult,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Pure module ──────────────────────────────────────────────────────────────

describe("T4: normalizeHookOutput", () => {
  it("normalization strips ANSI escape sequences from hook output", () => {
    const raw =
      "\u001b[31mgolangci-lint run failed\u001b[0m\n" +
      "\u001b[1minternal/app/sts.go:42:1: undefined: Probe\u001b[0m\n" +
      "\u001b[32mexit status 1\u001b[0m";
    assert.equal(
      normalizeHookOutput(raw),
      "golangci-lint run failed\ninternal/app/sts.go:42:1: undefined: Probe\nexit status 1",
      "every ANSI color/bold sequence is removed, the text itself survives",
    );
  });

  it("normalization strips timing fragments so two runs differing only in durations compare equal", () => {
    const first = normalizeHookOutput(
      "golangci-lint run failed (done in 5.12 seconds)\nunit tests (0.14 seconds)",
    );
    const second = normalizeHookOutput(
      "golangci-lint run failed (done in 9.81 seconds)\nunit tests (3.02 seconds)",
    );
    assert.equal(
      first,
      "golangci-lint run failed\nunit tests",
      "both '(done in N seconds)' and '(N seconds)' fragments are stripped",
    );
    assert.equal(first, second, "runs differing only in durations normalize equal");
  });
});

describe("T4: isIdenticalRejection", () => {
  const fingerprint = " M src/a.ts\n--\n src/a.ts | 2 +-";

  it("two rejections with equal normalized output and an unchanged tree fingerprint are identical", () => {
    const previous: RejectionSnapshot = {
      hookOutput: "\u001b[31mgolangci-lint run failed\u001b[0m (done in 5.12 seconds)",
      treeFingerprint: fingerprint,
    };
    const current: RejectionSnapshot = {
      hookOutput: "golangci-lint run failed (done in 8.44 seconds)",
      treeFingerprint: fingerprint,
    };
    assert.equal(
      isIdenticalRejection(previous, current),
      true,
      "ANSI and duration differences alone never make the rounds differ",
    );
  });

  it("a rejection with changed output or a changed tree fingerprint is not identical", () => {
    const base: RejectionSnapshot = {
      hookOutput: "golangci-lint run failed",
      treeFingerprint: fingerprint,
    };
    assert.equal(isIdenticalRejection(undefined, base), false, "no previous rejection to compare");
    assert.equal(
      isIdenticalRejection(base, {
        hookOutput: "golangci-lint run failed\nsrc/util.ts:9:1: new lint error",
        treeFingerprint: fingerprint,
      }),
      false,
      "changed hook output is not identical",
    );
    assert.equal(
      isIdenticalRejection(base, {
        hookOutput: "golangci-lint run failed",
        treeFingerprint: `${fingerprint}\nM src/b.ts`,
      }),
      false,
      "a changed tree fingerprint is not identical",
    );
  });

  it("buildIdenticalRejectionHalt names the repeated identical rejection, the behavior, and the fix paths", () => {
    const text = buildIdenticalRejectionHalt("T1");
    assert.match(text, /identical/i, "names the repeated identical rejection");
    assert.match(text, /hook/i, "names the hook rejection");
    assert.match(text, /T1/, "names the behavior id");
    assert.match(text, /hook locally/i, "recommends running the hook locally");
    assert.match(text, /ownership/i, "recommends the ownership fix");
  });
});

// ─── Loop wiring ──────────────────────────────────────────────────────────────

function mockPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  };
  return {
    on: record("on") as ExtensionAPI["on"],
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    registerTool: record("registerTool") as ExtensionAPI["registerTool"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => ["read", "write", "edit"],
    getAllTools: () => ["read", "write", "edit"].map((name) => ({ name })),
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function ctxWithState(state: WorkflowState): ExtensionContext {
  return {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "workflow-state", data: state }],
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

function oneBehaviorState(): WorkflowState {
  return {
    phase: "finalizing",
    specText: "topic",
    task: {
      title: "Identical Rejection Task",
      instruction: "do the thing",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    },
  };
}

/**
 * Exec mock whose pre-commit hook rejects EVERY commit with the same output
 * and an unchanged tree — the identical-rejection input.
 *
 * @returns Mock ExtensionAPI with a persistently identical rejecting hook.
 */
function piWithStaticRejectingHook() {
  const pi = mockPi();
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: "headA\n", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "status") {
      return { stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "diff") {
      return { stdout: " src/a.ts | 2 +-\n", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      return { stdout: "", stderr: "golangci-lint run failed\nexit status 1", code: 1, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

/**
 * Exec mock whose hook output changes on every commit attempt — rejections
 * never repeat, so only budget exhaustion can end the run.
 *
 * @returns Mock ExtensionAPI with a per-round varying rejecting hook.
 */
function piWithChangingRejectingHook() {
  const pi = mockPi();
  let attempts = 0;
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: "headA\n", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "status") {
      return { stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "diff") {
      return { stdout: " src/a.ts | 2 +-\n", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      attempts++;
      return {
        stdout: "",
        stderr: `golangci-lint run failed\nlint error ${attempts}\nexit status 1`,
        code: 1,
        killed: false,
      };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

/** Runner that records one behavior-id entry per spawned unit. */
function countingRunner(spawns: string[]): UnitRunner {
  return async (unit): Promise<{ summary: string; suggestedCommit: string }> => {
    spawns.push(unit.behaviorId);
    return { summary: `attempt ${spawns.length}`, suggestedCommit: "feat(core): add first behavior" };
  };
}

/** Run the orchestrator loop once against the given state/mocks. */
async function runLoop(
  pi: ExtensionAPI,
  state: WorkflowState,
  runner: UnitRunner,
): Promise<OrchestratorResult> {
  const ctx = ctxWithState(state);
  return runOrchestratedImplement(pi, ctx, state, state.task!, runner);
}

describe("T4: identical-rejection halt in the behavior loop", () => {
  it("the loop halts after the first fix round when the second hook rejection is identical, spawning 2 units instead of 6", async () => {
    const spawns: string[] = [];
    const result = await runLoop(piWithStaticRejectingHook(), oneBehaviorState(), countingRunner(spawns));

    assert.equal(result.complete, false, "the identical repeat halts the run");
    assert.equal(result.haltedOn, "T1");
    assert.equal(
      spawns.length,
      2,
      "initial unit + exactly one fix round, then the identical rejection halts (2 units, not 6)",
    );
    assert.equal(result.unitsRun, 2, "no further units are spawned after the identical rejection");
  });

  it("the identical-rejection halt error names the repeated identical hook rejection and the behavior id", async () => {
    const spawns: string[] = [];
    const result = await runLoop(piWithStaticRejectingHook(), oneBehaviorState(), countingRunner(spawns));

    const error = result.error ?? "";
    assert.match(error, /identical/i, "the halt error names the repeated identical rejection");
    assert.match(error, /hook/i, "the halt error names the hook rejection");
    assert.match(error, /T1/, "the halt error names the behavior id");
    assert.match(error, /hook locally/i, "the halt error recommends a local hook run");
    assert.match(error, /ownership/i, "the halt error recommends the ownership fix");
    assert.doesNotMatch(error, /after \d+ retries/, "not a retry-budget exhaustion message");
    const attempts = result.attempts ?? [];
    assert.equal(
      attempts[attempts.length - 1]?.outcome,
      "hook-rejected",
      "the last attempt keeps its sealed hook-rejected outcome",
    );
    assert.match(
      result.diagnosis ?? "",
      /pre-commit hooks rejected/,
      "halt diagnosis derivation is unchanged",
    );
  });

  it("a hook rejection whose output changes every round still exhausts the 5-retry budget with the existing 'after 5 retries' halt", async () => {
    const spawns: string[] = [];
    const result = await runLoop(piWithChangingRejectingHook(), oneBehaviorState(), countingRunner(spawns));

    assert.equal(result.complete, false, "persistent rejection still halts the run");
    assert.equal(result.haltedOn, "T1");
    assert.equal(
      spawns.length,
      6,
      "initial unit + exactly 5 retries (RETRY_BUDGET) when no rejection repeats identically",
    );
    assert.match(
      result.error ?? "",
      /pre-commit hook rejected the commit for T1 after 5 retries/,
      "the existing budget-exhaustion halt is unchanged",
    );
  });
});
