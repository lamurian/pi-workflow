import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  ATTEMPT_TEXT_LIMIT,
  HALT_REPORT_CLOSING_LINE,
  classifyAttemptOutcome,
  deriveDiagnosis,
  renderHaltReport,
  truncateAttemptText,
  type AttemptRecord,
} from "../extensions/halt-report.ts";
import {
  composeCompletionReport,
  composeHaltReport,
} from "../extensions/implement-report.ts";
import {
  runOrchestratedImplement,
  type OrchestratorResult,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";
import type { ImplementerReport } from "../extensions/implementer-report.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type UnitAttemptResult = ImplementerReport & {
  error?: string;
  timedOut?: boolean;
  missingReport?: boolean;
};

// ─── Harness (mirrors __tests__/unit-progress.test.ts mocks) ─────────────────

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
        state ? [{ type: "custom", customType: "workflow-state", data: state }] : [],
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
    title: "Halt Report Task",
    instruction: "do things",
    files: ["src/a.ts"],
    done: "all green",
    behaviors: [
      { id: "T1", description: "the behavior", expectedOutput: "e1", kind: "test", status: "active" },
    ],
  };
}

function singleBehaviorState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    phase: "finalizing",
    specText: "topic",
    task: singleBehaviorTask(),
    ...overrides,
  };
}

/** Exec mock with a HEAD counter and an optional `git log` subject list. */
function piHarness(logSubjects: string[] = []) {
  const pi = mockPi();
  let headCounter = 0;
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      headCounter++;
      return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "log") {
      return { stdout: logSubjects.join("\n") + "\n", stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

// ─── Pure rendering ───────────────────────────────────────────────────────────

describe("halt-report: pure rendering", () => {
  const attempts: AttemptRecord[] = [
    { attempt: 1, outcome: "timeout", durationSec: 900, progress: true, lastText: "explored the parser" },
    { attempt: 2, outcome: "hook-rejected", durationSec: 42, progress: false, lastText: "lint failed on src/a.ts" },
  ];

  it("renderHaltReport lists commits under 'Commits landed since /implement started'", () => {
    const report = renderHaltReport({
      haltedOn: "T2",
      error: "pre-commit hook rejected the commit for T2",
      treeState: " M src/b.ts",
      commits: ["feat(core): add T1", "fix(core): retry T2"],
      attempts,
    });
    assert.match(report, /## Implementation status: halted on T2/, "halted heading");
    assert.match(report, /Error: pre-commit hook rejected/, "error line");
    assert.match(report, /Tree state:\n M src\/b\.ts/, "tree state");
    assert.match(
      report,
      /Commits landed since \/implement started:\n- feat\(core\): add T1\n- fix\(core\): retry T2/,
      "one bullet per commit subject since the baseline",
    );
    assert.match(report, /\(none\)/, "renders (none) when nothing landed");
  });

  it("renders an attempt table with outcome, duration, progress and truncated last text", () => {
    const longText = "x".repeat(ATTEMPT_TEXT_LIMIT + 50);
    const report = renderHaltReport({
      haltedOn: "T1",
      error: "boom",
      commits: [],
      attempts: [
        ...attempts,
        { attempt: 3, outcome: "unit-error", durationSec: 5, progress: false, lastText: longText },
      ],
    });
    assert.match(report, /Attempt history:/, "attempt history section");
    assert.match(report, /\| # \| Outcome \| Duration \| Progress \| Last text \|/, "table header");
    assert.match(report, /\| 1 \| timeout \| 900s \| yes \| explored the parser \|/, "attempt 1 row");
    assert.match(report, /\| 2 \| hook-rejected \| 42s \| no \| lint failed on src\/a\.ts \|/, "attempt 2 row");
    assert.match(report, /x{200}…/, "last text is truncated to 200 chars");
    assert.ok(
      !report.includes(longText),
      "the full untruncated text never reaches the table",
    );
  });

  it("renders the findings tail, Diagnosis and Recommended next action, and ends with the pinned closing line", () => {
    const report = renderHaltReport({
      haltedOn: "T1",
      error: "boom",
      commits: [],
      attempts,
      findings: [
        { behaviorId: "T0", text: "fact: ledger lives in findings-ledger.ts" },
        { behaviorId: "T1", text: "fact: the loop retries 5 times" },
      ],
    });
    assert.match(report, /Findings \(latest\):\n- \[T0\] fact: ledger lives in findings-ledger\.ts/, "findings tail");
    assert.match(report, /- \[T1\] fact: the loop retries 5 times/, "findings tail carries behavior ids");
    assert.match(report, /Diagnosis: /, "diagnosis line");
    assert.match(report, /Recommended next action: /, "recommended next action line");
    assert.ok(
      report.endsWith(HALT_REPORT_CLOSING_LINE),
      "the report ends with the pinned relay instruction",
    );
    assert.equal(
      HALT_REPORT_CLOSING_LINE,
      "Relay this status and the recommended next action to the user. " +
        "Do not run tools or modify the working tree.",
      "the closing line is pinned by the contract",
    );
  });

  it("deriveDiagnosis names exploration not converging for repeated no-progress timeouts", () => {
    const stalled: AttemptRecord[] = [
      { attempt: 1, outcome: "timeout", durationSec: 900, progress: false, lastText: "a" },
      { attempt: 2, outcome: "timeout", durationSec: 900, progress: false, lastText: "b" },
    ];
    const diagnosis = deriveDiagnosis(stalled, "");
    assert.equal(diagnosis.diagnosis, "exploration not converging");
    assert.match(diagnosis.recommendation, /\/discuss -> \/finalize/);
    assert.match(diagnosis.recommendation, /PI_IMPLEMENT_TIMEOUT_MS/);
  });

  it("classifyAttemptOutcome and truncateAttemptText classify and cap attempt inputs", () => {
    assert.equal(classifyAttemptOutcome({ timedOut: true }), "timeout");
    assert.equal(classifyAttemptOutcome({ missingReport: true }), "missing-report");
    assert.equal(classifyAttemptOutcome({ error: "boom" }), "unit-error");
    assert.equal(classifyAttemptOutcome({ status: "partial" }), "partial");
    assert.equal(classifyAttemptOutcome({ status: "complete" }), "ok");
    assert.equal(truncateAttemptText("  short  "), "short");
    assert.equal(truncateAttemptText("y".repeat(250)).length, ATTEMPT_TEXT_LIMIT + 1, "200 chars plus ellipsis");
  });
});

// ─── composeHaltReport wrapper ────────────────────────────────────────────────

describe("halt-report: composeHaltReport wrapper", () => {
  it("renders the enriched shape from an OrchestratorResult, falling back to landedCommits", () => {
    const result: OrchestratorResult = {
      complete: false,
      unitsRun: 2,
      landedCommits: ["feat(core): add T1"],
      haltedOn: "T2",
      error: "no changes detected for T2 after 5 retries",
      treeState: " M src/b.ts",
      attempts: [
        { attempt: 1, outcome: "no-changes", durationSec: 30, progress: false, lastText: "no diff" },
      ],
      findings: [{ behaviorId: "T2", text: "fact: the gate stages with git add --all" }],
    };
    const report = composeHaltReport(result);
    assert.match(
      report,
      /Commits landed since \/implement started:\n- feat\(core\): add T1/,
      "per-run landedCommits fallback when no baseline is available",
    );
    assert.match(report, /\| 1 \| no-changes \| 30s \| no \| no diff \|/, "attempt table row");
    assert.match(report, /- \[T2\] fact: the gate stages with git add --all/, "findings tail");
    assert.match(report, /Diagnosis: /);
    assert.match(report, /Recommended next action: /);
    assert.ok(report.endsWith(HALT_REPORT_CLOSING_LINE), "pinned final line");
  });

  it("uses the loop-gathered baseline commits when present", () => {
    const result: OrchestratorResult = {
      complete: false,
      unitsRun: 1,
      landedCommits: ["feat(core): add T2"],
      commitsSinceBaseline: ["feat(core): add T1", "feat(core): add T2"],
      haltedOn: "T3",
      error: "boom",
    };
    const report = composeHaltReport(result);
    assert.match(
      report,
      /Commits landed since \/implement started:\n- feat\(core\): add T1\n- feat\(core\): add T2/,
      "cumulative baseline..HEAD subjects, not just this run's commits",
    );
  });

  it("the completion report final line is unchanged", () => {
    const report = composeCompletionReport(
      { complete: true, unitsRun: 1, landedCommits: ["feat(core): add T1"] },
      singleBehaviorTask(),
    );
    assert.ok(
      report.endsWith(
        "No action needed: relay this status to the user. Do not run tools or modify the working tree.",
      ),
      "the completion report keeps its pinned final line",
    );
  });
});

// ─── Loop wiring ──────────────────────────────────────────────────────────────

describe("halt-report: loop wiring", () => {
  it("a halted run records attempt history, diagnosis and recommendation in lastHalt", async () => {
    const pi = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push(unit.behaviorId);
      return { summary: "", error: "always-fails: unit subprocess died" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, false, "the failing run halts");
    assert.equal(result.haltedOn, "T1");
    assert.equal(spawns.length, 6, "initial run + 5 retries");
    assert.ok(result.attempts?.length === 6, "every attempt is on the result");
    assert.ok(
      result.attempts!.every((a) => a.outcome === "unit-error"),
      "plain unit errors are classified as unit-error",
    );
    assert.ok(
      result.attempts!.every((a) => typeof a.durationSec === "number" && a.durationSec >= 0),
      "each attempt carries a duration in seconds",
    );
    assert.ok(result.diagnosis, "a diagnosis is derived");
    assert.ok(result.recommendation, "a recommendation is derived");

    const append = pi.calls["appendEntry"] ?? [];
    const lastSaved = append[append.length - 1] as [string, WorkflowState];
    const halt = lastSaved[1].lastHalt;
    assert.equal(halt?.behaviorId, "T1");
    assert.ok(Array.isArray(halt?.attempts) && halt.attempts.length === 6, "lastHalt persists the attempt history");
    assert.equal(halt?.attempts?.[0]?.outcome, "unit-error");
    assert.equal(halt?.diagnosis, result.diagnosis, "lastHalt persists the diagnosis");
    assert.equal(halt?.recommendation, result.recommendation, "lastHalt persists the recommendation");
  });

  it("gathered baseline commits reach the halt report under the cumulative heading", async () => {
    const pi = piHarness(["feat(core): add T0", "feat(core): add T1"]);
    const state = singleBehaviorState({ baselineHead: "baseA" });
    const ctx = ctxWithState(state);

    const runner: UnitRunner = async (): Promise<UnitAttemptResult> => {
      return { summary: "", error: "always-fails" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, false);
    assert.deepEqual(
      result.commitsSinceBaseline,
      ["feat(core): add T0", "feat(core): add T1"],
      "the loop gathers git log baseline..HEAD subjects",
    );
    const report = composeHaltReport(result);
    assert.match(
      report,
      /Commits landed since \/implement started:\n- feat\(core\): add T0\n- feat\(core\): add T1/,
      "the halt report lists the cumulative subjects",
    );
  });

  it("without a baseline the halt report falls back to this run's landed commits", async () => {
    const pi = piHarness();
    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    let run = 0;

    // First behavior lands, second behavior fails all retries -> halt.
    const task = state.task!;
    task.behaviors.push({
      id: "T2",
      description: "second",
      expectedOutput: "e2",
      kind: "test",
      status: "active",
    });
    const runner: UnitRunner = async (): Promise<UnitAttemptResult> => {
      run++;
      if (run === 1) return { summary: "done", suggestedCommit: "feat(core): add T1" };
      return { summary: "", error: "always-fails" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, task, runner);

    assert.equal(result.complete, false);
    assert.equal(result.haltedOn, "T2");
    assert.deepEqual(result.landedCommits, ["feat(core): add T1"], "T1 landed before the halt");
    const report = composeHaltReport(result);
    assert.match(
      report,
      /Commits landed since \/implement started:\n- feat\(core\): add T1/,
      "per-run landedCommits fallback without a baselineHead",
    );
  });

  it("a commit-gate verdict seals the last attempt's outcome in the halt report", async () => {
    const pi = piHarness();
    // Stage a real diff so the commit runs, but commit fails: mock git commit
    // exits non-zero, which the gate classifies as hook-rejected.
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "head0\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--name-status")) {
        return { stdout: "M\tsrc/a.ts\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff") {
        return { stdout: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "", stderr: "eslint failed", code: 1, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const state = singleBehaviorState();
    const ctx = ctxWithState(state);
    const runner: UnitRunner = async (): Promise<UnitAttemptResult> => {
      return { summary: "implemented T1", suggestedCommit: "feat(core): add T1" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);

    assert.equal(result.complete, false, "hook rejection exhausts the budget and halts");
    const last = result.attempts![result.attempts!.length - 1]!;
    assert.equal(last.outcome, "hook-rejected", "the commit-gate verdict seals the last attempt");
    const report = composeHaltReport(result);
    assert.match(report, /hook-rejected/, "the attempt table shows the hook-rejected outcome");
    assert.match(report, /Diagnosis: pre-commit hooks rejected/, "diagnosis names the hook verdict");
  });
});
