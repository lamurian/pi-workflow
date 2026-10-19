import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MAX_CONTINUATIONS,
  computeTreeFingerprint,
  isPartialAttempt,
  classifyProgress,
  decideContinuation,
  buildContinuationTaskText,
  shouldHaltEarly,
  buildEarlyHaltError,
} from "../extensions/unit-progress.ts";
import { runOrchestratedImplement, type UnitRunner } from "../extensions/implement-loop.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";
import type { ImplementerReport } from "../extensions/subagent-runner.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type UnitAttemptResult = ImplementerReport & {
  error?: string;
  timedOut?: boolean;
  missingReport?: boolean;
};

// ─── Harness (mirrors __tests__/findings-ledger.test.ts mocks) ────────────────

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
    appendEntry: ((type: string, data: unknown) => {
      (calls["appendEntry"] ??= []).push([type, structuredClone(data)]);
    }) as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read" }],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function ctxWithState(state: WorkflowState | null): ExtensionContext {
  return {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () =>
        state
          ? [{ type: "custom", customType: "workflow-state", data: state }]
          : [],
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

function singleBehaviorTask(): TaskContract {
  return {
    title: "Progress Task",
    instruction: "do things",
    files: ["src/a.ts"],
    done: "all green",
    behaviors: [
      { id: "T1", description: "the behavior", expectedOutput: "e1", kind: "test", status: "active" },
    ],
  };
}

function singleBehaviorState(): WorkflowState {
  return { phase: "finalizing", specText: "topic", task: singleBehaviorTask() };
}

/** Exec mock with a call log and a HEAD that advances on git commit. */
function piHarness() {
  const pi = mockPi();
  const execLog: Array<{ cmd: string; args: string[] }> = [];
  let headCounter = 0;
  pi.exec = (async (cmd: string, args: string[]) => {
    execLog.push({ cmd, args });
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      headCounter++;
      return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  const commits = () =>
    execLog.filter((entry) => entry.cmd === "git" && entry.args[0] === "commit");
  return { pi, execLog, commits };
}

// ═══ Pure progress classification ═══
describe("unit-progress: pure classification", () => {
  it("computeTreeFingerprint joins trimmed status and diff-stat output", () => {
    const fingerprint = computeTreeFingerprint(" M src/a.ts\n", " src/a.ts | 2 +-\n");
    assert.equal(fingerprint, " M src/a.ts\n--\n src/a.ts | 2 +-");
    assert.equal(computeTreeFingerprint("", ""), "\n--\n");
  });

  it("isPartialAttempt is true only for status partial or timedOut", () => {
    assert.equal(isPartialAttempt({ status: "partial" }), true);
    assert.equal(isPartialAttempt({ timedOut: true }), true);
    assert.equal(isPartialAttempt({ timedOut: true, status: "partial" }), true);
    assert.equal(isPartialAttempt({ status: "complete" }), false);
    assert.equal(isPartialAttempt({}), false);
    assert.equal(isPartialAttempt({ error: "boom" }), false);
    assert.equal(isPartialAttempt({ missingReport: true }), false);
  });

  it("classifyProgress is true when the fingerprint changed or new findings landed", () => {
    assert.equal(
      classifyProgress({ fingerprintBefore: "a", fingerprintAfter: "b", newFindings: false }),
      true,
    );
    assert.equal(
      classifyProgress({ fingerprintBefore: "a", fingerprintAfter: "a", newFindings: true }),
      true,
    );
    assert.equal(
      classifyProgress({ fingerprintBefore: "a", fingerprintAfter: "a", newFindings: false }),
      false,
    );
  });

  it("decideContinuation allows up to MAX_CONTINUATIONS continuations, then retries", () => {
    assert.equal(MAX_CONTINUATIONS, 4);
    assert.equal(decideContinuation({ progressed: true, continuations: 0 }), "continue");
    assert.equal(decideContinuation({ progressed: true, continuations: 3 }), "continue");
    assert.equal(decideContinuation({ progressed: true, continuations: 4 }), "retry");
    assert.equal(decideContinuation({ progressed: false, continuations: 0 }), "retry");
    assert.equal(
      decideContinuation({ progressed: true, continuations: 2, maxContinuations: 2 }),
      "retry",
    );
  });

  it("shouldHaltEarly fires on the second consecutive no-progress attempt", () => {
    assert.equal(shouldHaltEarly(0), false);
    assert.equal(shouldHaltEarly(1), false, "one no-progress attempt still retries");
    assert.equal(shouldHaltEarly(2), true, "two consecutive no-progress attempts halt");
    assert.equal(shouldHaltEarly(3), true);
  });

  it("buildEarlyHaltError names the diagnosis and both recommendations", () => {
    const text = buildEarlyHaltError("T2", 2);
    assert.match(text, /T2/, "the halted behavior is named");
    assert.match(text, /exploration not converging/, "diagnosis is present");
    assert.match(text, /\/discuss -> \/finalize/, "split recommendation is present");
    assert.match(text, /PI_IMPLEMENT_TIMEOUT_MS/, "timeout recommendation is present");
  });

  it("buildContinuationTaskText carries the heading, nextSteps, summary, tree and original task", () => {
    const text = buildContinuationTaskText(
      "T1",
      { summary: "explored the parser", nextSteps: "wire the parser into the loop", timedOut: true },
      "Implement ONE behavior: T1.\nOriginal task body",
      " M src/a.ts",
    );
    assert.match(text, /## Continue previous partial attempt/);
    assert.match(text, /wire the parser into the loop/, "nextSteps reach the continuation");
    assert.match(text, /explored the parser/, "last summary reaches the continuation");
    assert.match(text, /M src\/a\.ts/, "git status snapshot reaches the continuation");
    assert.match(text, /Implement ONE behavior: T1\./, "original task text is included");
    assert.match(text, /UNCOMMITTED/, "the continuation is told the work stays uncommitted");
  });
});

// ═══ Orchestrator wiring ═══
describe("unit-progress: partial continuation wiring", () => {
  interface Spawn {
    behaviorId: string;
    taskText: string;
  }

  it("a partial report never commits; with progress a continuation runs without consuming retries", async () => {
    const { pi, commits } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        return {
          summary: "explored the codebase",
          status: "partial",
          nextSteps: "run the linter, then finish the wiring",
          findings: ["fact: ledger lives in findings-ledger.ts"],
        };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, true, "the continuation completes the workflow");
    assert.equal(spawns.length, 2, "one partial attempt, one continuation");
    const continuation = spawns[1]!.taskText;
    assert.match(continuation, /## Continue previous partial attempt/, "continuation heading");
    assert.match(continuation, /run the linter, then finish the wiring/, "nextSteps present");
    assert.match(continuation, /## Known findings from earlier units/, "ledger section present");
    assert.match(continuation, /fact: ledger lives in findings-ledger\.ts/);
    assert.ok(
      !/retry 1\/5/.test(continuation),
      "a continuation must not consume the retry budget",
    );
    assert.equal(commits().length, 1, "only the completed continuation commits; the partial never does");
    assert.equal(state.phase, "idle");
  });

  it("after 4 continuations further partials consume retries", async () => {
    const { pi, commits } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length <= 5) {
        return {
          summary: `partial work ${spawns.length}`,
          status: "partial",
          nextSteps: "keep going",
          findings: [`fact: step ${spawns.length}`],
        };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, true);
    assert.equal(spawns.length, 6, "initial + 4 continuations + 1 retry");
    for (const spawn of spawns.slice(1, 5)) {
      assert.match(spawn.taskText, /## Continue previous partial attempt/);
      assert.ok(!/retry \d\/5/.test(spawn.taskText), "continuations never name a retry number");
    }
    assert.match(spawns[5]!.taskText, /Previous attempt failed \(retry 1\/5\)/, "the fifth partial consumes a retry");
    assert.ok(
      !spawns[5]!.taskText.includes("## Continue previous partial attempt"),
      "beyond the continuation budget the attempt is a plain retry",
    );
    assert.equal(commits().length, 1, "the retry's completion is the only commit");
  });

  it("a partial without progress consumes one retry immediately", async () => {
    const { pi, commits } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        return {
          summary: "could not make progress",
          status: "partial",
          nextSteps: "nothing new to try",
        };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, true);
    assert.equal(spawns.length, 2, "the no-progress partial consumed one retry");
    assert.match(spawns[1]!.taskText, /Previous attempt failed \(retry 1\/5\)/);
    assert.ok(
      !spawns[1]!.taskText.includes("## Continue previous partial attempt"),
      "no progress means no continuation",
    );
    assert.equal(commits().length, 1);
  });

  it("a timed-out attempt with progress continues without committing", async () => {
    const { pi, commits } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        return {
          summary: "",
          error: "timed out after 900000ms",
          timedOut: true,
          findings: ["fact: the parser lives in report.ts"],
        };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, true);
    assert.equal(spawns.length, 2, "timeout with progress continues once");
    assert.match(spawns[1]!.taskText, /## Continue previous partial attempt/);
    assert.ok(!/retry 1\/5/.test(spawns[1]!.taskText), "the continuation does not consume a retry");
    assert.equal(commits().length, 1, "no commit for the timed-out attempt");
  });

  it("a timed-out attempt without progress keeps the plain retry path", async () => {
    const { pi } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        return { summary: "", error: "timed out after 900000ms", timedOut: true };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, true);
    assert.match(spawns[1]!.taskText, /infrastructure timeout, not a check failure/i);
    assert.match(spawns[1]!.taskText, /retry 1\/5/);
    assert.ok(!spawns[1]!.taskText.includes("## Continue previous partial attempt"));
  });

  it("plain unit errors still retry exactly as before", async () => {
    const { pi } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        return { summary: "", error: "EACCES: permission denied" };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, true);
    assert.equal(spawns.length, 2, "one retry after the plain error");
    assert.match(spawns[1]!.taskText, /Previous attempt failed \(retry 1\/5\)/);
    assert.ok(!spawns[1]!.taskText.includes("## Continue previous partial attempt"));
  });
});

// ═══ Early halt on no-progress attempts (T7) ═══
describe("unit-progress: early halt on no-progress timeouts", () => {
  interface Spawn {
    behaviorId: string;
    taskText: string;
  }

  it("two consecutive no-progress partial attempts halt after 2 attempts with a diagnosis", async () => {
    const { pi, commits } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      return { summary: `partial ${spawns.length}`, status: "partial", nextSteps: "still stuck" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, false, "the behavior halts instead of exhausting retries");
    assert.equal(spawns.length, 2, "halts after 2 attempts, not the full retry budget of 6");
    assert.equal(result.haltedOn, "T1");
    assert.match(result.error ?? "", /exploration not converging/, "diagnosis in the halt error");
    assert.match(result.error ?? "", /\/discuss -> \/finalize/, "split recommendation");
    assert.match(result.error ?? "", /PI_IMPLEMENT_TIMEOUT_MS/, "timeout recommendation");
    assert.equal(commits().length, 0, "no commit for a no-progress halt");
    assert.match(state.lastHalt?.error ?? "", /exploration not converging/, "halt persists in state");
  });

  it("two consecutive no-progress timed-out attempts halt early too", async () => {
    const { pi } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      return { summary: "", error: "timed out after 900000ms", timedOut: true };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, false);
    assert.equal(spawns.length, 2, "timeouts without progress halt after 2 attempts");
    assert.equal(result.haltedOn, "T1");
    assert.match(result.error ?? "", /exploration not converging/);
    assert.match(result.error ?? "", /\/discuss -> \/finalize/);
    assert.match(result.error ?? "", /PI_IMPLEMENT_TIMEOUT_MS/);
  });

  it("progress between no-progress attempts resets the streak", async () => {
    const { pi, commits } = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1 || spawns.length === 3) {
        return { summary: `stuck ${spawns.length}`, status: "partial", nextSteps: "stuck" };
      }
      if (spawns.length === 2) {
        return {
          summary: "explored further",
          status: "partial",
          nextSteps: "keep going",
          findings: ["fact: the entry point lives in index.ts"],
        };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, true, "the streak reset lets the behavior finish");
    assert.equal(spawns.length, 4, "no-progress partial (retry), progressing continuation, no-progress partial (retry), success");
    assert.match(spawns[1]!.taskText, /Previous attempt failed \(retry 1\/5\)/, "the first no-progress partial consumed a retry");
    assert.match(spawns[2]!.taskText, /## Continue previous partial attempt/, "progress spawned a continuation");
    assert.match(spawns[3]!.taskText, /Previous attempt failed \(retry 2\/5\)/, "the later no-progress partial retried instead of halting");
    assert.equal(commits().length, 1);
  });
});
