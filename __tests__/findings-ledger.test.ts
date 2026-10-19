import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  appendFindings,
  renderFindingsSection,
  createToolCallCollector,
  renderToolCallDigest,
  TOOL_DIGEST_MAX_CHARS,
  MAX_FINDINGS,
  type Finding,
} from "../extensions/findings-ledger.ts";
import {
  runOrchestratedImplement,
  type UnitRunner,
} from "../extensions/implement-loop.ts";
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

// ─── Harness (mirrors __tests__/implement.test.ts mocks) ──────────────────────

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
    // Real persistence serializes the state; the mock must snapshot it too,
    // otherwise later mutations (e.g. clearing the ledger) rewrite history.
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

function twoBehaviorTask(): TaskContract {
  return {
    title: "Ledger Task",
    instruction: "do things",
    files: ["src/a.ts"],
    done: "all green",
    behaviors: [
      { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
      { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
    ],
  };
}

/** Exec mock where git commit advances HEAD so the loop can land commits. */
function piWithAdvancingHead() {
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
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

const HOOK_STDERR =
  ">>> Pre-commit hook failed\n" +
  "golangci-lint run failed\n" +
  "exit status 1";

/** Exec mock where the pre-commit hook always rejects: HEAD never moves, tree dirty. */
function piWithRejectingHook() {
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
      return { stdout: "", stderr: HOOK_STDERR, code: 1, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

/** The most recent persisted workflow-state entry (or undefined). */
function lastPersistedState(
  pi: ExtensionAPI & { calls: Record<string, unknown[]> },
): WorkflowState | undefined {
  const entries = (pi.calls["appendEntry"] ?? []) as Array<[string, WorkflowState]>;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]![0] === "workflow-state") return entries[i]![1];
  }
  return undefined;
}

/** Any persisted workflow-state entry carrying a non-empty findings ledger. */
function persistedWithFindings(
  pi: ExtensionAPI & { calls: Record<string, unknown[]> },
): WorkflowState | undefined {
  const entries = (pi.calls["appendEntry"] ?? []) as Array<[string, WorkflowState]>;
  return entries
    .filter(([type, data]) => type === "workflow-state" && data.findings?.length)
    .map(([, data]) => data)
    .pop();
}

// ═══ Pure ledger logic ═══
describe("findings ledger: append/cap/render", () => {
  it("appends new findings tagged with the reporting behavior", () => {
    const { ledger, changed } = appendFindings([], "T1", ["path: src/a.ts", "sig: parse()"]);
    assert.equal(changed, true);
    assert.deepEqual(ledger, [
      { behaviorId: "T1", text: "path: src/a.ts" },
      { behaviorId: "T1", text: "sig: parse()" },
    ]);
  });

  it("skips exact duplicate texts across behaviors and drops empty strings", () => {
    const first = appendFindings([], "T1", ["path: src/a.ts", "hooks run vitest"]).ledger;
    const { ledger, changed } = appendFindings(first, "T2", [
      "path: src/a.ts",
      "   ",
      "bash: go test ./...",
    ]);
    assert.equal(changed, true, "the new distinct fact still lands");
    assert.deepEqual(
      ledger.map((f) => `${f.behaviorId}:${f.text}`),
      ["T1:path: src/a.ts", "T1:hooks run vitest", "T2:bash: go test ./..."],
      "the duplicate is stored once (under its first reporter)",
    );
    const noop = appendFindings(ledger, "T2", ["path: src/a.ts"]);
    assert.equal(noop.changed, false, "a duplicate-only append reports no change");
    assert.deepEqual(noop.ledger, ledger);
  });

  it("caps the ledger at the 40 most recent entries, evicting the oldest", () => {
    const texts = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => `finding ${i}`);
    const { ledger } = appendFindings([], "T1", texts);
    assert.equal(ledger.length, MAX_FINDINGS);
    assert.equal(ledger[0]!.text, "finding 5", "oldest entries are evicted");
    assert.equal(ledger[ledger.length - 1]!.text, `finding ${MAX_FINDINGS + 4}`);
  });

  it("renderFindingsSection returns an empty string for a missing or empty ledger", () => {
    assert.equal(renderFindingsSection(undefined), "");
    assert.equal(renderFindingsSection([]), "");
  });

  it("renders the shared section listing every entry with its behavior id", () => {
    const ledger: Finding[] = [
      { behaviorId: "T1", text: "gate lives in commit-gate.ts" },
      { behaviorId: "T2", text: "tests run via vitest" },
    ];
    const section = renderFindingsSection(ledger);
    assert.match(section, /## Known findings from earlier units/);
    assert.match(section, /- \[T1\] gate lives in commit-gate\.ts/);
    assert.match(section, /- \[T2\] tests run via vitest/);
  });
});

// ═══ Tool-call digest (T5) ═══
describe("tool-call digest", () => {
  it("records read/edit paths and bash command heads from assistant events, deduped and truncated", () => {
    const collector = createToolCallCollector();
    const long = "go test ./... ".repeat(10).trim(); // 139 chars > 120
    assert.ok(long.length > TOOL_DIGEST_MAX_CHARS);
    collector.record({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "a.go" } },
          { type: "toolCall", name: "read", arguments: { path: "a.go" } }, // duplicate
          { type: "toolCall", name: "read", arguments: { path: "b.go" } },
          { type: "toolCall", name: "edit", arguments: { path: "a.go" } },
          { type: "toolCall", name: "bash", arguments: { command: long } },
          { type: "text", text: "plain prose, not a tool call" },
        ],
      },
    });
    // User-role messages and non-message events never contribute.
    collector.record({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "toolCall", name: "read", arguments: { path: "c.go" } }],
      },
    });
    collector.record({ type: "turn_end" });

    const entries = collector.entries();
    const bash = entries.find((e) => e.tool === "bash");
    assert.ok(bash, "the bash call was recorded");
    assert.equal(bash!.detail.length, TOOL_DIGEST_MAX_CHARS, "bash command head is truncated to 120 chars");
    assert.equal(bash!.detail, long.slice(0, TOOL_DIGEST_MAX_CHARS), "the head keeps the command start");

    const digest = renderToolCallDigest(entries);
    assert.match(digest, /^previous attempt touched: /);
    assert.match(digest, /read a\.go, b\.go/, "deduped read paths group under their tool");
    assert.match(digest, /edit a\.go/);
    assert.ok(digest.includes(bash!.detail), "the truncated command head is rendered");
    assert.ok(!digest.includes(long), "the full long command never appears");
    assert.ok(!digest.includes("c.go"), "user-role events are ignored");
  });

  it("caps the digest at the most recent entries and returns empty when nothing was recorded", () => {
    const collector = createToolCallCollector();
    assert.equal(renderToolCallDigest(collector.entries()), "", "no events -> no digest text");
    for (let i = 0; i < 30; i++) {
      collector.record({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "read", arguments: { path: `f${i}.go` } }],
        },
      });
    }
    const entries = collector.entries();
    assert.ok(entries.length <= 20, `digest capped, got ${entries.length}`);
    assert.equal(entries[entries.length - 1]!.detail, "f29.go", "the most recent call survives");
    assert.ok(!entries.some((e) => e.detail === "f0.go"), "the oldest call is evicted");
  });
});

// ═══ Orchestrator wiring ═══
describe("findings ledger: orchestrator wiring", () => {
  interface Spawn { behaviorId: string; taskText: string }

  it("appends report findings to state, persists them, and feeds the next unit's task text", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: twoBehaviorTask() };
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (unit.behaviorId === "T1") {
        return {
          summary: "implemented T1",
          suggestedCommit: "feat(core): add first behavior",
          findings: ["the commit gate classifies via HEAD before/after"],
        };
      }
      return {
        summary: "implemented T2",
        suggestedCommit: "feat(core): add second behavior",
      };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true, "the orchestrated run completes");

    // T1's finding was persisted mid-run...
    const persisted = persistedWithFindings(pi);
    assert.ok(persisted, "a workflow-state entry carrying findings was persisted");
    assert.deepEqual(persisted!.findings, [
      { behaviorId: "T1", text: "the commit gate classifies via HEAD before/after" },
    ]);

    // ...and fed the next unit's task text (shared across behaviors).
    const t2Task = spawns.find((s) => s.behaviorId === "T2")!.taskText;
    assert.match(t2Task, /## Known findings from earlier units/);
    assert.match(t2Task, /- \[T1\] the commit gate classifies via HEAD before\/after/);

    // Completion clears the ledger (phase -> idle).
    assert.equal(state.phase, "idle");
    assert.equal(state.findings, undefined, "ledger cleared on completion");
    const last = lastPersistedState(pi)!;
    assert.equal(last.phase, "idle");
    assert.equal(last.findings, undefined, "the cleared ledger is persisted too");
  });

  it("a failing attempt's findings reach its retry task text", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: { ...twoBehaviorTask(), behaviors: [twoBehaviorTask().behaviors[0]!] },
    };
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        return {
          summary: "",
          error: "boom: subprocess died",
          findings: ["read path: src/helpers.ts exports parseReport"],
        };
      }
      return {
        summary: "implemented T1",
        suggestedCommit: "feat(core): add first behavior",
      };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true, "the retry succeeds");
    assert.equal(spawns.length, 2, "one failure, one retry");
    const retry = spawns[1]!.taskText;
    assert.match(retry, /## Known findings from earlier units/);
    assert.match(retry, /- \[T1\] read path: src\/helpers\.ts exports parseReport/);
  });

  it("hook-rejected fix attempts carry the ledger section, and the ledger survives the halt", async () => {
    const pi = piWithRejectingHook();
    // implement.ts transitions to "implementing" before the loop runs; the
    // halt must keep that phase (not roll it back) so /implement can resume.
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: { ...twoBehaviorTask(), behaviors: [twoBehaviorTask().behaviors[0]!] },
    };
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      return {
        summary: `attempt ${spawns.length}`,
        suggestedCommit: "feat(core): add first behavior",
        findings: ["lint lives in .golangci.yml"],
      };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, false, "persistent rejection halts the run");
    assert.ok(spawns.length > 1, "fix subagents ran");
    for (const spawn of spawns.slice(1)) {
      assert.match(spawn.taskText, /## Known findings from earlier units/, "fix task carries the section");
      assert.match(spawn.taskText, /- \[T1\] lint lives in \.golangci\.yml/, "fix task carries the finding");
    }

    // The ledger survives the halt and is persisted with lastHalt.
    assert.equal(state.phase, "implementing", "halt keeps the implementing phase");
    assert.equal(state.findings?.length, 1, "the ledger is kept across the halt");
    const last = lastPersistedState(pi)!;
    assert.equal(last.lastHalt?.behaviorId, "T1");
    assert.deepEqual(last.findings, [{ behaviorId: "T1", text: "lint lives in .golangci.yml" }]);

    // A resumed run feeds the persisted ledger into the first unit's task.
    const resumeSpawns: Spawn[] = [];
    const resumeRunner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      resumeSpawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      return {
        summary: "implemented T1",
        suggestedCommit: "feat(core): add first behavior",
      };
    };
    const resumePi = piWithAdvancingHead();
    const resumed = await runOrchestratedImplement(resumePi, ctx, state, state.task!, resumeRunner);
    assert.equal(resumed.complete, true, "the resumed run completes");
    assert.match(resumeSpawns[0]!.taskText, /## Known findings from earlier units/);
    assert.match(resumeSpawns[0]!.taskText, /- \[T1\] lint lives in \.golangci\.yml/);
    assert.equal(state.findings, undefined, "completion of the resumed run clears the ledger");
  });

  it("a timed-out attempt appends a behavior-tagged digest finding that reaches the retry task text", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: { ...twoBehaviorTask(), behaviors: [twoBehaviorTask().behaviors[0]!] },
    };
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit, _cwd, _signal, onEvent) => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        onEvent?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", name: "read", arguments: { path: "src/helpers.ts" } },
              { type: "toolCall", name: "bash", arguments: { command: "go test ./..." } },
            ],
          },
        });
        return { summary: "", error: "timed out after 900000ms", timedOut: true };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add first behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true, "the retry succeeds");

    const persisted = persistedWithFindings(pi);
    assert.ok(persisted, "the digest finding was persisted with the ledger");
    const digestEntry = persisted!.findings!.find((f) => f.text.startsWith("previous attempt touched:"));
    assert.ok(digestEntry, "a digest finding landed in the ledger");
    assert.equal(digestEntry!.behaviorId, "T1", "the digest is tagged with the behavior id");
    assert.match(digestEntry!.text, /read src\/helpers\.ts/);
    assert.match(digestEntry!.text, /bash: go test \.\/\.\.\./);

    const retry = spawns[1]!.taskText;
    assert.match(retry, /## Known findings from earlier units/, "the retry task carries the ledger section");
    assert.match(retry, /previous attempt touched: read src\/helpers\.ts/, "the digest appears in the retry task text");
  });

  it("a report-less attempt appends the digest too, and identical digests are stored once", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: { ...twoBehaviorTask(), behaviors: [twoBehaviorTask().behaviors[0]!] },
    };
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit, _cwd, _signal, onEvent) => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length <= 2) {
        onEvent?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }],
          },
        });
        return {
          summary: "",
          error: "implementer ended without the required JSON report block",
          missingReport: true,
        };
      }
      return { summary: "implemented T1", suggestedCommit: "feat(core): add first behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true, "the third attempt succeeds");
    assert.equal(spawns.length, 3, "two failures, one success");

    // Both report-less attempts touch the same file: the digest is stored once.
    const persisted = persistedWithFindings(pi)!;
    const digests = persisted.findings!.filter((f) => f.text.startsWith("previous attempt touched:"));
    assert.equal(digests.length, 1, "identical digests dedupe to one ledger entry");
    assert.equal(digests[0]!.behaviorId, "T1");
    assert.match(digests[0]!.text, /read src\/a\.ts/);
    // Both retry task texts render the digest from the shared ledger.
    assert.match(spawns[1]!.taskText, /previous attempt touched: read src\/a\.ts/);
    assert.match(spawns[2]!.taskText, /previous attempt touched: read src\/a\.ts/);
  });

  it("a successful attempt leaves no digest finding in the ledger", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: { ...twoBehaviorTask(), behaviors: [twoBehaviorTask().behaviors[0]!] },
    };
    const ctx = ctxWithState(state);

    const runner: UnitRunner = async (unit, _cwd, _signal, onEvent) => {
      onEvent?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }],
        },
      });
      return { summary: "implemented T1", suggestedCommit: "feat(core): add first behavior" };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true, "the run completes");
    const entries = (pi.calls["appendEntry"] ?? []) as Array<[string, WorkflowState]>;
    for (const [, data] of entries) {
      if (data.findings?.length) {
        assert.ok(
          !data.findings.some((f) => f.text.startsWith("previous attempt touched:")),
          "no digest finding for a clean attempt",
        );
      }
    }
  });

  it("duplicate findings across attempts are stored once and do not re-persist", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: { ...twoBehaviorTask(), behaviors: [twoBehaviorTask().behaviors[0]!] },
    };
    const ctx = ctxWithState(state);
    const spawns: Spawn[] = [];

    const runner: UnitRunner = async (unit): Promise<UnitAttemptResult> => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      if (spawns.length === 1) {
        return {
          summary: "",
          error: "boom: died",
          findings: ["fact: shared by both attempts"],
        };
      }
      return {
        summary: "implemented T1",
        suggestedCommit: "feat(core): add first behavior",
        findings: ["fact: shared by both attempts"],
      };
    };

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, runner);
    assert.equal(result.complete, true, "the retry succeeds");
    // The retry task carries the section exactly once with the single entry,
    // and no persisted state ever shows the ledger doubled by the duplicate.
    assert.equal(
      spawns[1]!.taskText.split("## Known findings from earlier units").length - 1,
      1,
      "the retry task renders the section once",
    );
    const entries = (pi.calls["appendEntry"] ?? []) as Array<[string, WorkflowState]>;
    const findingsSaves = entries.filter(
      ([type, data]) => type === "workflow-state" && data.findings?.length,
    );
    assert.ok(findingsSaves.length > 0, "findings were persisted mid-run");
    for (const [, data] of findingsSaves) {
      assert.equal(data.findings?.length, 1, "the duplicate never doubled the ledger");
    }
  });
});
