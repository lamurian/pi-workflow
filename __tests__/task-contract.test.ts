import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  validateTask,
  parseTestOutput,
  evaluateCompletionGate,
  renderTaskContract,
} from "../extensions/task-contract.ts";
import { handlePreCompact } from "../extensions/compaction.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

function implementingState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    phase: "implementing",
    specText: "topic",
    task: {
      title: "T",
      instruction: "do it",
      files: ["src/a.ts"],
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
      files: ["a"],
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

// ═══ renderTaskContract ═══
describe("renderTaskContract", () => {
  it("lists behaviors and flags removed ones", () => {
    const s = implementingState({
      task: {
        title: "My Task", instruction: "i", files: ["a.ts"], done: "d",
        behaviors: [
          { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
          { id: "T2", description: "z", expectedOutput: "w", kind: "manual", status: "removed" },
        ],
      },
    });
    const out = renderTaskContract(s.task!);
    assert.match(out, /My Task/);
    assert.match(out, /T1/);
    assert.match(out, /\[removed\]/);
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
        title: "Contracted", instruction: "i", files: ["a.ts"], done: "d",
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
