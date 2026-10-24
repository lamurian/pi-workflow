import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  validateTask,
  validateContract,
  parseTestOutput,
  evaluateCompletionGate,
  formatTask,
  formatFiles,
} from "../extensions/task-contract.ts";
import { handlePreCompact } from "../extensions/compaction.ts";
import type {
  WorkflowState,
  TaskContract,
  ContractV2,
  PathEntry,
  TaskUnit,
} from "../extensions/state.ts";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

function implementingState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    phase: "implementing",
    specText: "topic",
    task: {
      title: "T",
      instruction: "do it",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "tests pass",
      behaviors: [
        {
          id: "T1",
          description: "handler returns list",
          expectedOutput: "200 + array",
          kind: "test",
          status: "active",
          sourceFile: "src/a.ts",
        },
      ],
    },
    ...overrides,
  };
}

// ═══ validateTask ═══
describe("validateTask", () => {
  it("accepts a well-formed contract and defaults status", () => {
    const r = validateTask({
      title: "T",
      instruction: "i",
      files: [{ path: "a", status: "M" }],
      done: "d",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test" },
      ],
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.task.behaviors[0].status, "active");
      assert.equal(r.task.behaviors[0].kind, "test");
    }
  });

  it("rejects a missing title", () => {
    const r = validateTask({ title: "  ", instruction: "i", files: [], done: "d", behaviors: [] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /title/);
  });

  it("rejects a behavior with a bad kind", () => {
    const r = validateTask({
      title: "T", instruction: "i", files: [], done: "d",
      behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "maybe" }],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /kind/);
  });

  it("rejects a non-array behaviors field", () => {
    const r = validateTask({ title: "T", instruction: "i", files: [], done: "d", behaviors: "nope" });
    assert.equal(r.ok, false);
  });
});

// ═══ validateTask files allowlist (T1) ═══
describe("validateTask files D/M/A allowlist (T1)", () => {
  function payload(files: unknown) {
    return { title: "T", instruction: "i", files, done: "d", behaviors: [] };
  }

  it("accepts [{ path, status }] entries and normalizes them", () => {
    const r = validateTask(
      payload([
        { path: "src/a.ts", status: "M" },
        { path: "tests/a.test.ts", status: "A" },
        { path: "src/legacy.ts", status: "D" },
      ]),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.task.files, [
      { path: "src/a.ts", status: "M" },
      { path: "tests/a.test.ts", status: "A" },
      { path: "src/legacy.ts", status: "D" },
    ]);
  });

  it("rejects plain-string entries with a specific reason", () => {
    const r = validateTask(payload(["src/a.ts"]));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /files\[0\]/);
    assert.match(r.reason, /\{ path, status \}/);
    assert.match(r.reason, /A, M or D/);
  });

  it("rejects an unknown status with a specific reason", () => {
    const r = validateTask(payload([{ path: "src/a.ts", status: "X" }]));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /files\[0\]\.status must be A, M or D/);
  });

  it("rejects an empty path with a specific reason", () => {
    const r = validateTask(payload([{ path: "  ", status: "M" }]));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /files\[0\]\.path must be a non-empty string/);
  });

  it("rejects duplicate paths with a specific reason naming the path", () => {
    const r = validateTask(
      payload([
        { path: "src/a.ts", status: "M" },
        { path: "src/a.ts", status: "D" },
      ]),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /files\[1\]\.path duplicates an earlier entry: src\/a\.ts/);
  });

  it("rejects a non-array files field", () => {
    const r = validateTask(payload("src/a.ts"));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /files must be an array/);
  });
});

// ═══ validateTask contract-quality warnings (T1) ═══
describe("validateTask contract-quality warnings (T1)", () => {
  function qualityPayload(expectedOutput: string, kind = "test") {
    return {
      title: "T",
      instruction: "i",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "d",
      behaviors: [
        {
          id: "T1",
          description: "Add test scenarios for validation",
          expectedOutput,
          kind,
        },
      ],
    };
  }

  it("warns for test-artifact-only expectedOutput on a test-kind behavior", () => {
    const r = validateTask(
      qualityPayload("test file contains 3 cases covering edge cases"),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /T1/, "warning must name the behavior id");
    assert.match(r.warnings[0]!, /red by construction/);
    assert.match(r.warnings[0]!, /test without implementation/);
  });

  it("suppresses the artifact warning when an observable marker is present", () => {
    const r = validateTask(
      qualityPayload(
        "test file cases verify that the handler returns 200 with a list",
      ),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.warnings, []);
  });

  it("warns and advises kind: manual for test-deletion expectedOutput", () => {
    const r = validateTask(qualityPayload("delete the legacy test cases"));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /T1/);
    assert.match(r.warnings[0]!, /kind: manual/);
  });

  it("returns no warnings for a clean contract", () => {
    const r = validateTask(qualityPayload("handler returns 200 + array"));
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.warnings, []);
  });

  it("returns no warnings for manual-kind behaviors", () => {
    const r = validateTask(
      qualityPayload("test file contains 3 cases covering edge cases", "manual"),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.warnings, []);
  });

  it("invalid payload still returns { ok: false, reason } with no warnings array", () => {
    const r = validateTask({ title: "  ", instruction: "i", files: [], done: "d", behaviors: [] });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /title/);
      assert.equal("warnings" in r, false);
    }
  });
});

// ═══ parseTestOutput ═══
describe("parseTestOutput", () => {
  it("treats exit code 0 as passing and parses counts", () => {
    const r = parseTestOutput(0, "Tests: 3 passed, 1 failed");
    assert.equal(r.failed, 1);
    assert.equal(r.passed, 3);
  });

  it("counts a non-zero exit with no 'failed' text as a failure", () => {
    const r = parseTestOutput(1, "all good");
    assert.equal(r.failed, 1);
    assert.equal(r.passed, 0);
  });

  it("parses mocha 'passing'/'failing' wording", () => {
    const r = parseTestOutput(0, "5 passing\n1 failing");
    assert.equal(r.passed, 5);
    assert.equal(r.failed, 1);
  });

  it("parses the Node core test-runner 'ℹ pass N'/'ℹ fail N' summary", () => {
    // Node >= 20 emits this form; without it the orchestrator sees passed: 0
    // and the completion gate refuses a genuinely green run.
    const out = [
      "✔ ok (0.9ms)",
      "ℹ tests 2",
      "ℹ pass 2",
      "ℹ fail 0",
      "ℹ duration_ms 92.5",
    ].join("\n");
    const r = parseTestOutput(0, out);
    assert.equal(r.passed, 2);
    assert.equal(r.failed, 0);
  });

  it("treats a non-zero Node core run with 'ℹ fail 1' as one failure", () => {
    const out = "✖ bad (3ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1";
    const r = parseTestOutput(1, out);
    assert.equal(r.failed, 1);
    assert.equal(r.passed, 0);
  });

  it("parses coverage percent when present", () => {
    const r = parseTestOutput(0, "All files | 90.5 |");
    assert.equal(r.coveragePercent, 90.5);
  });
});

// ═══ evaluateCompletionGate ═══
describe("evaluateCompletionGate", () => {
  it("passes when all behaviors done and tests green", () => {
    const s = implementingState({
      task: {
        title: "T", instruction: "i", files: [], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "done" }],
      },
      lastTestResults: { passed: 3, failed: 0 },
    });
    assert.equal(evaluateCompletionGate(s), null);
  });

  it("refuses while a behavior is still active", () => {
    const s = implementingState();
    const r = evaluateCompletionGate(s);
    assert.ok(r !== null);
    assert.match(r!, /active/);
  });

  it("passes when every behavior is done and no test run is recorded (T9)", () => {
    const s = implementingState({
      task: {
        title: "T", instruction: "i", files: [], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "done" }],
      },
    });
    assert.equal(evaluateCompletionGate(s), null);
  });

  it("passes when stale lastTestResults show failures (T9)", () => {
    const s = implementingState({
      task: {
        title: "T", instruction: "i", files: [], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "done" }],
      },
      lastTestResults: { passed: 1, failed: 2 },
    });
    assert.equal(evaluateCompletionGate(s), null);
  });

  it("refuses when no task contract exists (T9)", () => {
    const s: WorkflowState = { phase: "implementing", specText: "topic" };
    const r = evaluateCompletionGate(s);
    assert.ok(r !== null);
    assert.match(r!, /no task contract/);
  });

  it("passes with manual behaviors and no test run", () => {
    const s = implementingState({
      task: {
        title: "T", instruction: "i", files: [], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "manual", status: "done" }],
      },
    });
    assert.equal(evaluateCompletionGate(s), null);
  });
});

// ═══ formatTask ═══
describe("formatTask", () => {
  it("lists behaviors and flags removed ones", () => {
    const s = implementingState({
      task: {
        title: "My Task", instruction: "i", files: [{ path: "a.ts", status: "M" }], done: "d",
        behaviors: [
          { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
          { id: "T2", description: "z", expectedOutput: "w", kind: "manual", status: "removed" },
        ],
      },
    });
    const out = formatTask(s.task!);
    assert.match(out, /My Task/);
    assert.match(out, /T1/);
    assert.match(out, /\[removed\]/);
  });

  it("renders declared files as 'path (STATUS)'", () => {
    const s = implementingState({
      task: {
        title: "My Task", instruction: "i",
        files: [
          { path: "src/a.ts", status: "M" },
          { path: "tests/a.test.ts", status: "A" },
          { path: "src/legacy.ts", status: "D" },
        ],
        done: "d",
        behaviors: [
          { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
        ],
      },
    });
    const out = formatTask(s.task!);
    assert.match(out, /Files: src\/a\.ts \(M\), tests\/a\.test\.ts \(A\), src\/legacy\.ts \(D\)/);
    assert.match(out, /src\/a\.ts \(M\)/);
  });

  it("formatFiles renders the comma list and an empty string for no files", () => {
    assert.equal(
      formatFiles([{ path: "src/a.ts", status: "M" }]),
      "src/a.ts (M)",
    );
    assert.equal(formatFiles([]), "");
  });
});

// ═══ compaction embeds the contract ═══
describe("compaction preserves the task contract", () => {
  function ctxFor(state: WorkflowState): ExtensionContext {
    return {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: "workflow-state", data: state }],
      },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, theme: { fg: (_: string, t: string) => t } },
    } as unknown as ExtensionContext;
  }

  it("embeds behaviors and statuses in the compaction summary", async () => {
    const s = implementingState({
      phase: "finalizing",
      task: {
        title: "Contracted", instruction: "i", files: [{ path: "a.ts", status: "M" }], done: "d",
        behaviors: [
          { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
        ],
      },
    });
    const event = { preparation: { firstKeptEntryId: "e0", tokensBefore: 100 } } as unknown as SessionBeforeCompactEvent;
    const result = await handlePreCompact(event, ctxFor(s));
    assert.ok(result && "compaction" in result);
    const summary = (result as { compaction: { summary: string } }).compaction.summary;
    assert.match(summary, /Task Contract/);
    assert.match(summary, /Contracted/);
    assert.match(summary, /T1/);
  });

  it("still returns undefined for an idle phase", async () => {
    const s: WorkflowState = { phase: "idle", specText: "" };
    const event = { preparation: { firstKeptEntryId: "e0", tokensBefore: 100 } } as unknown as SessionBeforeCompactEvent;
    const result = await handlePreCompact(event, ctxFor(s));
    assert.equal(result, undefined);
  });
});

// ═══ Contract v2: validateContract (T1) ═══

/** Minimal well-formed v2 payload with two tasks; overrides replace keys wholesale. */
function v2Payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "T",
    instruction: "i",
    done: "d",
    sources: [
      { path: "src/a.ts", tasks: ["T1"] },
      { path: "src/b.ts", tasks: ["T2"] },
    ],
    tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
    tasks: [
      { id: "T1", description: "x", expectedOutput: ["line 1"], status: "active" },
      { id: "T2", description: "y", expectedOutput: ["line 2"], status: "active" },
    ],
    ...overrides,
  };
}

describe("validateContractV2RejectsEachInvariant", () => {
  it("accepts a well-formed v2 contract and keeps PathEntry.status optional", () => {
    const r = validateContract(v2Payload());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.contract.sources[0]!.status, undefined, "absent status stays absent");
    assert.deepEqual(r.contract.sources[0]!.tasks, ["T1"]);
    assert.equal(r.contract.tasks.length, 2);
    assert.equal(r.contract.tasks[0]!.expectedOutput[0], "line 1");
  });

  it("rejects a dangling taskRef", () => {
    const r = validateContract(
      v2Payload({ sources: [{ path: "src/a.ts", tasks: ["T9"] }] }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /dangling taskRef/);
    assert.match(r.reason, /T9/);
  });

  it("rejects a duplicate path within sources", () => {
    const r = validateContract(
      v2Payload({
        sources: [
          { path: "src/a.ts", tasks: ["T1"] },
          { path: "src/a.ts", status: "M", tasks: ["T2"] },
        ],
      }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /duplicate path/);
    assert.match(r.reason, /src\/a\.ts/);
  });

  it("rejects a duplicate path within tests", () => {
    const r = validateContract(
      v2Payload({
        tests: [
          { path: "tests/a.test.ts", tasks: ["T1"] },
          { path: "tests/a.test.ts", tasks: ["T2"] },
        ],
      }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /duplicate path/);
  });

  it("rejects a path declared in both sources and tests", () => {
    const r = validateContract(
      v2Payload({ sources: [{ path: "tests/a.test.ts", tasks: ["T1"] }] }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /both sources and tests/);
    assert.match(r.reason, /tests\/a\.test\.ts/);
  });

  it("rejects a D entry with empty tasks", () => {
    const r = validateContract(
      v2Payload({ sources: [{ path: "src/legacy.ts", status: "D", tasks: [] }] }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /D entry with empty tasks/);
    assert.match(r.reason, /src\/legacy\.ts/);
  });

  it("rejects a task with empty expectedOutput", () => {
    const r = validateContract(
      v2Payload({
        tasks: [
          { id: "T1", description: "x", expectedOutput: [], status: "active" },
          { id: "T2", description: "y", expectedOutput: ["line 2"], status: "active" },
        ],
      }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /empty expectedOutput/);
    assert.match(r.reason, /T1/);
  });

  it("rejects a duplicate task id", () => {
    const r = validateContract(
      v2Payload({
        tasks: [
          { id: "T1", description: "x", expectedOutput: ["a"], status: "active" },
          { id: "T1", description: "y", expectedOutput: ["b"], status: "active" },
        ],
      }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /duplicate task id/);
    assert.match(r.reason, /T1/);
  });

  it("rejects a missing title", () => {
    const r = validateContract(v2Payload({ title: "  " }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /title/);
  });

  it("rejects a non-array expectedOutput with a shape reason", () => {
    const r = validateContract(
      v2Payload({
        tasks: [
          { id: "T1", description: "x", expectedOutput: "one line", status: "active" },
          { id: "T2", description: "y", expectedOutput: ["b"], status: "active" },
        ],
      }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /expectedOutput must be an array/);
  });
});

describe("validateContractV2AcceptsSharedAndManual", () => {
  it("accepts a shared file referenced by multiple tasks", () => {
    const r = validateContract(
      v2Payload({
        sources: [{ path: "src/shared.ts", tasks: ["T1", "T2"] }],
        tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
      }),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.contract.sources[0]!.tasks, ["T1", "T2"]);
  });

  it("accepts a manual task with zero path refs", () => {
    const r = validateContract(
      v2Payload({
        sources: [{ path: "src/a.ts", tasks: ["T1"] }],
        tests: [],
        tasks: [
          { id: "T1", description: "x", expectedOutput: ["line 1"], status: "active" },
          {
            id: "T2",
            description: "manual verify",
            expectedOutput: ["checked by hand"],
            status: "active",
          },
        ],
      }),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.contract.tasks[1]!.id, "T2");
  });

  it("accepts a D entry owned by one task and preserves its status", () => {
    const r = validateContract(
      v2Payload({
        sources: [
          { path: "src/legacy.ts", status: "D", tasks: ["T2"] },
          { path: "src/a.ts", tasks: ["T1"] },
        ],
      }),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.contract.sources[0]!.status, "D");
  });
});

describe("TaskContractV2CoexistsWithV1", () => {
  it("validateTask still validates v1 contracts from the same module", () => {
    const v1 = validateTask({
      title: "T",
      instruction: "i",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "d",
      behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test" }],
    });
    assert.equal(v1.ok, true);
    if (v1.ok) {
      assert.equal(v1.task.files[0]!.status, "M");
      assert.equal(v1.task.behaviors[0]!.status, "active");
    }
  });

  it("validateContract rejects a v1 payload (no v2 path lists)", () => {
    const r = validateContract({
      title: "T",
      instruction: "i",
      done: "d",
      files: [{ path: "src/a.ts", status: "M" }],
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /sources/);
  });

  it("both contract shapes stay exported from state.ts", () => {
    const v1Task: TaskContract = {
      title: "T",
      instruction: "i",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "d",
      behaviors: [],
    };
    const v2: ContractV2 = {
      title: "T",
      instruction: "i",
      done: "d",
      sources: [],
      tests: [],
      tasks: [],
    };
    assert.equal(v1Task.title, v2.title);
    const entry: PathEntry = { path: "a.ts", tasks: ["T1"] };
    assert.equal(entry.status, undefined, "PathEntry.status is optional");
    const unit: TaskUnit = {
      id: "T1",
      description: "x",
      expectedOutput: ["a"],
      status: "active",
    };
    assert.equal(unit.expectedOutput.length, 1);
  });
});
