import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { renderPreviousHaltSection } from "../extensions/resume-context.ts";
import { runOrchestratedImplement } from "../extensions/implement-loop.ts";
import type { LastHalt, TaskContract, WorkflowState } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function haltFixture(overrides: Partial<LastHalt> = {}): LastHalt {
  return {
    behaviorId: "T2",
    error: "pre-commit hook rejected the commit for T2 after 5 retries",
    attempts: [
      { attempt: 1, outcome: "timeout", durationSec: 900, progress: false, lastText: "still reading files" },
      { attempt: 2, outcome: "hook-rejected", durationSec: 42, progress: true, lastText: "lint errors in src/a.ts" },
    ],
    diagnosis: "pre-commit hooks rejected the unit's commits",
    recommendation: "Run the failing hook locally, fix it, then run /implement again.",
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("renderPreviousHaltSection", () => {
  it("returns '' when the halt has neither attempts nor diagnosis", () => {
    const section = renderPreviousHaltSection(
      haltFixture({ attempts: undefined, diagnosis: undefined }),
    );
    assert.equal(section, "");
  });

  it("renders the halted section with diagnosis, recommendation and the attempt table", () => {
    const section = renderPreviousHaltSection(haltFixture());
    assert.match(section, /## Previous run halted/, "section heading");
    assert.match(section, /T2/, "names the halted behavior");
    assert.match(section, /Diagnosis: pre-commit hooks rejected the unit's commits/, "diagnosis line");
    assert.match(
      section,
      /Recommended next action: Run the failing hook locally/,
      "recommendation line",
    );
    assert.match(section, /\| # \| Outcome \|/, "attempt table header");
    assert.match(section, /\| 1 \| timeout \| 900s \| no \|/, "attempt row");
  });

  it("derives diagnosis and recommendation when only attempts are persisted", () => {
    const section = renderPreviousHaltSection(
      haltFixture({ diagnosis: undefined, recommendation: undefined }),
    );
    assert.match(section, /Diagnosis: /, "derived diagnosis line present");
    assert.match(section, /Recommended next action: /, "derived recommendation present");
  });
});

// ─── loop wiring ───────────────────────────────────────────────────────────────

function twoBehaviorTask(): TaskContract {
  return {
    title: "Code Task",
    instruction: "do things",
    files: ["src/a.ts"],
    done: "all green",
    behaviors: [
      { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
      { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
    ],
  };
}

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
    getActiveTools: () => ["read", "bash", "write", "edit"],
    getAllTools: () => ["read", "bash", "write", "edit"].map((name) => ({ name })),
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

/** Pi stub whose git commits land (HEAD moves on commit). */
function landingPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
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

/** Pi stub whose commits are hook-rejected (HEAD never moves, tree dirty). */
function rejectingPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const pi = mockPi();
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: "head0\n", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "status") {
      return { stdout: " M src/a.ts", stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      return { stdout: "", stderr: "husky: lint failed", code: 1, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return pi;
}

describe("runOrchestratedImplement: resume injects the previous halt context", () => {
  it("prepends the section to the halted behavior's first unit only", async () => {
    const pi = landingPi();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: twoBehaviorTask(),
      lastHalt: haltFixture(),
    };
    const ctx = ctxWithState(state);
    const taskTexts: string[] = [];
    const byBehavior: Record<string, string[]> = {};

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
      taskTexts.push(unit.taskText);
      (byBehavior[unit.behaviorId] ??= []).push(unit.taskText);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId}`,
      };
    });

    assert.equal(result.complete, true, "resume run completes");
    const t1Texts = byBehavior["T1"]!;
    const t2Texts = byBehavior["T2"]!;
    assert.ok(
      t2Texts[0]!.includes("## Previous run halted"),
      "the halted behavior's first unit carries the section",
    );
    assert.ok(
      t2Texts[0]!.includes("Diagnosis: pre-commit hooks rejected the unit's commits"),
      "the section carries the diagnosis",
    );
    assert.ok(
      !t1Texts.some((t) => t.includes("## Previous run halted")),
      "other behaviors never inherit the section",
    );
    assert.ok(
      t2Texts.length === 1 || !t2Texts.slice(1).some((t) => t.includes("## Previous run halted")),
      "later units of the halted behavior never inherit the section",
    );
  });

  it("retries of the halted behavior do not inherit the section", async () => {
    const pi = rejectingPi();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: twoBehaviorTask(),
      lastHalt: haltFixture({ behaviorId: "T1" }),
    };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];
    const texts: string[] = [];

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
      spawns.push(unit.behaviorId);
      texts.push(unit.taskText);
      return {
        summary: `attempt ${spawns.length}`,
        suggestedCommit: "feat(core): add first behavior",
      };
    });

    assert.ok(spawns.length > 1, "the rejected commit spawns at least one retry");
    assert.ok(
      texts[0]!.includes("## Previous run halted"),
      "the base unit carries the previous halt section",
    );
    assert.ok(
      !texts.slice(1).some((t) => t.includes("## Previous run halted")),
      "no retry task inherits the section",
    );
    assert.equal(result.complete, false, "persistent rejection halts the run");
  });

  it("a run without a previous halt injects nothing", async () => {
    const pi = landingPi();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: twoBehaviorTask(),
    };
    const ctx = ctxWithState(state);
    const texts: string[] = [];

    await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
      texts.push(unit.taskText);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId}`,
      };
    });

    assert.ok(
      !texts.some((t) => t.includes("## Previous run halted")),
      "no halt section without a persisted lastHalt",
    );
  });
});
