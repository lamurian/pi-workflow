import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  transitionTo,
  loadState,
  updateUi,
  type WorkflowState,
} from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function mockPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  return {
    appendEntry: (t: string, d: unknown) => {
      calls["appendEntry"] = [...(calls["appendEntry"] ?? []), [t, d]];
    },
    calls,
  } as unknown as ExtensionAPI & { calls: Record<string, unknown[]> };
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
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
}

describe("state machine finalized phase", () => {
  it("transitions to finalized and persists via appendEntry", () => {
    const pi = mockPi();
    const state: WorkflowState = {
      phase: "discussing",
      specText: "topic",
      task: {
        title: "T", instruction: "i", files: [], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }],
      },
    };

    transitionTo(pi, state, "finalized");

    assert.equal(state.phase, "finalized");
    const append = pi.calls["appendEntry"] as Array<[string, WorkflowState]>;
    const [, saved] = append[append.length - 1];
    assert.equal(saved.phase, "finalized");
    assert.equal(saved.task!.title, "T");
  });

  it("round-trips a task through loadState", () => {
    const state: WorkflowState = {
      phase: "finalized",
      specText: "topic",
      task: {
        title: "Round", instruction: "i", files: ["a"], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "manual", status: "active" }],
      },
      returnCount: 1,
    };
    const loaded = loadState(ctxWithState(state));
    assert.ok(loaded);
    assert.equal(loaded!.phase, "finalized");
    assert.equal(loaded!.task!.title, "Round");
    assert.equal(loaded!.returnCount, 1);
  });

  it("updateUi renders the finalized status and behaviors", () => {
    const widgetCalls: string[][] = [];
    const ctx = ctxWithState({
      phase: "finalized",
      specText: "topic",
      task: {
        title: "Widget Task", instruction: "i", files: [], done: "d",
        behaviors: [
          { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
          { id: "T2", description: "z", expectedOutput: "w", kind: "manual", status: "done" },
        ],
      },
    });
    ctx.ui.setWidget = (_k: string, lines: string[]) => {
      if (lines) widgetCalls.push(lines);
    };

    updateUi(loadState(ctx), ctx);

    const flat = widgetCalls.flat().join("\n");
    assert.match(flat, /Widget Task/);
    assert.match(flat, /T1/);
    assert.match(flat, /T2/);
    assert.match(flat, /✓/);
  });

  it("existing discussing phase remains unaffected", () => {
    const state: WorkflowState = { phase: "discussing", specText: "keep" };
    const loaded = loadState(ctxWithState(state));
    assert.equal(loaded!.phase, "discussing");
    assert.equal(loaded!.specText, "keep");
  });
});
