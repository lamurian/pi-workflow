import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isAlreadySatisfied } from "../extensions/unit-progress.ts";
import { runOrchestratedImplement } from "../extensions/implement-loop.ts";
import type { TaskContract, WorkflowState } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ─── pure predicate ───────────────────────────────────────────────────────────

describe("isAlreadySatisfied", () => {
  const clean = {
    alreadySatisfied: true,
    headBefore: "abc123",
    headNow: "abc123",
    treeStatus: "",
  };

  it("is true only for flag=true, empty tree and equal non-null heads", () => {
    assert.equal(isAlreadySatisfied(clean), true);
  });

  it("is false without the flag or with a non-boolean flag", () => {
    assert.equal(isAlreadySatisfied({ ...clean, alreadySatisfied: undefined }), false);
    assert.equal(isAlreadySatisfied({ ...clean, alreadySatisfied: false }), false);
  });

  it("is false with a dirty tree even when everything else matches", () => {
    assert.equal(isAlreadySatisfied({ ...clean, treeStatus: " M src/a.ts" }), false);
    assert.equal(isAlreadySatisfied({ ...clean, treeStatus: "(unavailable)" }), false);
  });

  it("is false when HEAD moved during the attempt", () => {
    assert.equal(isAlreadySatisfied({ ...clean, headNow: "def456" }), false);
  });

  it("is false when either head is null", () => {
    assert.equal(isAlreadySatisfied({ ...clean, headBefore: null }), false);
    assert.equal(isAlreadySatisfied({ ...clean, headNow: null }), false);
    assert.equal(isAlreadySatisfied({ ...clean, headBefore: null, headNow: null }), false);
  });
});

// ─── loop wiring ──────────────────────────────────────────────────────────────

function singleBehaviorTask(): TaskContract {
  return {
    title: "Code Task",
    instruction: "do things",
    files: ["src/a.ts"],
    done: "all green",
    behaviors: [
      { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
    ],
  };
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

/**
 * Pi stub that records every exec call. HEAD is stable until a successful
 * `git commit` moves it; the tree status is configurable so tests can
 * simulate a dirty working tree.
 *
 * @param dirtyStatus - `git status --short` output; "" means clean.
 * @returns ExtensionAPI stub with a `calls.exec` log and a `head` counter.
 */
function execRecordingPi(dirtyStatus = ""): ExtensionAPI & {
  calls: { exec: Array<[string, string[]]> };
  head: { value: number };
} {
  const execCalls: Array<[string, string[]]> = [];
  const head = { value: 0 };
  const pi = {
    on: () => () => {},
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: () => {},
    sendUserMessage: () => {},
    getActiveTools: () => ["read", "bash", "write", "edit"],
    getAllTools: () => ["read", "bash", "write", "edit"].map((name) => ({ name })),
    setActiveTools: () => {},
    calls: { exec: execCalls },
    exec: (async (cmd: string, args: string[]) => {
      execCalls.push([cmd, args]);
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${head.value}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: dirtyStatus, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        head.value++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"],
  };
  return pi as unknown as ExtensionAPI & {
    calls: { exec: Array<[string, string[]]> };
    head: { value: number };
  };
}

describe("runOrchestratedImplement: alreadySatisfied marks done without a commit", () => {
  it("clean tree + unchanged HEAD: behavior done, no commit, no retry", async () => {
    const pi = execRecordingPi();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: singleBehaviorTask(),
    };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: "already implemented at HEAD", alreadySatisfied: true };
    });

    assert.equal(result.complete, true, "the run completes");
    assert.deepEqual(result.satisfiedWithoutCommit, ["T1"], "the id is recorded");
    assert.equal(state.task!.behaviors[0]!.status, "done", "the behavior is marked done");
    assert.equal(spawns.length, 1, "no retry spawns for a satisfied behavior");
    const commits = pi.calls.exec.filter(([, args]) => args[0] === "commit");
    assert.equal(commits.length, 0, "no git commit exec happens");
  });

  it("dirty tree: the flag is ignored and the normal commit gate runs", async () => {
    const pi = execRecordingPi(" M src/a.ts");
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: singleBehaviorTask(),
    };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
      spawns.push(unit.behaviorId);
      return {
        summary: "implemented the thing",
        suggestedCommit: "feat(core): add first behavior",
        alreadySatisfied: true,
      };
    });

    assert.deepEqual(result.satisfiedWithoutCommit, [], "nothing recorded as satisfied");
    const commits = pi.calls.exec.filter(([, args]) => args[0] === "commit");
    assert.equal(commits.length, 1, "the commit gate runs despite the flag");
    assert.deepEqual(result.landedCommits, ["feat(core): add first behavior"]);
    assert.equal(result.complete, true, "the commit lands and the run completes");
    assert.equal(state.task!.behaviors[0]!.status, "done", "the behavior is done via the commit");
    assert.equal(spawns.length, 1, "no retry once the commit lands");
  });
});
