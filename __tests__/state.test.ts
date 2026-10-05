import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  transitionTo,
  loadState,
  updateUi,
  type WorkflowState,
} from "../extensions/state.ts";
import { getPackageRoot } from "../extensions/utils.ts";
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

/** One recorded ctx.ui.setWidget call (lines may be undefined when hidden). */
interface WidgetCall {
  key: string;
  lines: string[] | undefined;
}

interface UiRecorder {
  ctx: ExtensionContext;
  titles: string[];
  statuses: Array<{ key: string; value: unknown }>;
  widgets: string[][];
  widgetCalls: WidgetCall[];
}

function ctxWithState(state: WorkflowState | null): UiRecorder {
  const titles: string[] = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const widgets: string[][] = [];
  const widgetCalls: WidgetCall[] = [];
  const ctx = {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () =>
        state ? [{ type: "custom", customType: "workflow-state", data: state }] : [],
    },
    ui: {
      notify: () => {},
      setStatus: (key: string, value: unknown) => {
        statuses.push({ key, value });
      },
      setWidget: (key: string, lines: string[] | undefined) => {
        widgetCalls.push({ key, lines });
        if (lines) widgets.push(lines);
      },
      setTitle: (t: string) => {
        titles.push(t);
      },
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
  return { ctx, titles, statuses, widgets, widgetCalls };
}

describe("state machine finalizing phase (T2)", () => {
  it("transitions to finalizing and persists via appendEntry", () => {
    const pi = mockPi();
    const state: WorkflowState = {
      phase: "discussing",
      specText: "topic",
      task: {
        title: "T", instruction: "i", files: [], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }],
      },
    };

    transitionTo(pi, state, "finalizing");

    assert.equal(state.phase, "finalizing");
    const append = pi.calls["appendEntry"] as Array<[string, WorkflowState]>;
    const [, saved] = append[append.length - 1];
    assert.equal(saved.phase, "finalizing");
    assert.equal(saved.task!.title, "T");
  });

  it("round-trips a task through loadState", () => {
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: {
        title: "Round", instruction: "i", files: ["a"], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "manual", status: "active" }],
      },
    };
    const { ctx } = ctxWithState(state);
    const loaded = loadState(ctx);
    assert.ok(loaded);
    assert.equal(loaded!.phase, "finalizing");
    assert.equal(loaded!.task!.title, "Round");
  });

  it("migrates a legacy persisted phase 'finalized' to 'finalizing' on load", () => {
    const legacy = { phase: "finalized", specText: "old topic" } as unknown as WorkflowState;
    const { ctx } = ctxWithState(legacy);
    const loaded = loadState(ctx);
    assert.ok(loaded);
    assert.equal(loaded!.phase, "finalizing");
    assert.equal(loaded!.specText, "old topic");
  });

  it("existing discussing phase remains unaffected", () => {
    const { ctx } = ctxWithState({ phase: "discussing", specText: "keep" });
    const loaded = loadState(ctx);
    assert.equal(loaded!.phase, "discussing");
    assert.equal(loaded!.specText, "keep");
  });

  it("WorkflowState source no longer contains returnCount (T8)", async () => {
    const src = await readFile(
      resolve(getPackageRoot(), "extensions", "state.ts"),
      "utf-8",
    );
    assert.doesNotMatch(src, /returnCount/);
  });

  it("loads sessions persisted before the HEAD fields existed (T2)", () => {
    const legacy = {
      phase: "implementing",
      specText: "old topic",
      task: {
        title: "Legacy", instruction: "i", files: [], done: "d",
        behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }],
      },
    } as unknown as WorkflowState;
    const { ctx } = ctxWithState(legacy);
    const loaded = loadState(ctx);
    assert.ok(loaded);
    assert.equal(loaded!.phase, "implementing");
    assert.equal(loaded!.baselineHead, undefined);
    assert.equal(loaded!.lastMarkedHead, undefined);
  });

  it("round-trips the optional HEAD fields when present (T2)", () => {
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      baselineHead: "abc123",
      lastMarkedHead: "def456",
    };
    const { ctx } = ctxWithState(state);
    const loaded = loadState(ctx);
    assert.equal(loaded!.baselineHead, "abc123");
    assert.equal(loaded!.lastMarkedHead, "def456");
  });
});

describe("updateUi paseo visibility (T6)", () => {
  const task = {
    title: "Widget Task", instruction: "i", files: [], done: "d",
    behaviors: [
      { id: "T1", description: "x", expectedOutput: "y", kind: "test" as const, status: "active" as const },
      { id: "T2", description: "z", expectedOutput: "w", kind: "manual" as const, status: "done" as const },
    ],
  };

  it("sets title '<phase> · <topic>', status '◉ <phase>'; widget hidden by default", () => {
    const rec = ctxWithState({
      phase: "finalizing",
      specText: "verify the error when mise run payment",
      task,
    });

    updateUi(loadState(rec.ctx), rec.ctx);

    assert.match(rec.titles[0], /^finalizing · /);
    assert.equal(rec.statuses[0].key, "workflow");
    assert.equal(rec.statuses[0].value, "◉ finalizing");
    // Superseded: the widget is hidden by default. Full content when shown
    // is covered by the toggle describe (T2).
    assert.equal(rec.widgetCalls.length, 1);
    assert.equal(rec.widgetCalls[0].lines, undefined, "widget hidden by default");
  });

  it("long specText does not throw and falls back to a phase-only title", () => {
    const rec = ctxWithState({
      phase: "finalizing",
      specText: "x".repeat(500),
    });

    updateUi(loadState(rec.ctx), rec.ctx);

    assert.equal(rec.titles[0], "finalizing");
  });

  it("idle clears status and widget and resets the title to pi", () => {
    const rec = ctxWithState(null);

    updateUi(null, rec.ctx);

    assert.ok(
      rec.statuses.some((s) => s.key === "workflow" && s.value === undefined),
      "status should be cleared",
    );
    assert.equal(rec.widgets.length, 0, "widget should be cleared");
    assert.equal(rec.titles[0], "pi");
  });
});

describe("updateUi widget visibility gate (T1)", () => {
  const task = {
    title: "Gate Task", instruction: "i", files: [], done: "d",
    behaviors: [
      { id: "T1", description: "x", expectedOutput: "y", kind: "test" as const, status: "active" as const },
    ],
  };

  it("calls setWidget('workflow-todos', undefined) by default for active phases, keeping status and title", () => {
    const rec = ctxWithState({
      phase: "finalizing",
      specText: "gate topic",
      task,
    });

    updateUi(loadState(rec.ctx), rec.ctx);

    assert.equal(rec.widgetCalls.length, 1);
    assert.equal(rec.widgetCalls[0].key, "workflow-todos");
    assert.equal(rec.widgetCalls[0].lines, undefined, "widget hidden by default");
    assert.equal(rec.statuses[0].key, "workflow");
    assert.equal(rec.statuses[0].value, "◉ finalizing");
    assert.match(rec.titles[0], /^finalizing · /);
  });

  it("builds no widget lines while hidden, even with test results in implementing", () => {
    const rec = ctxWithState({
      phase: "implementing",
      specText: "gate topic",
      task,
      lastTestResults: { passed: 2, failed: 1 },
    });

    updateUi(loadState(rec.ctx), rec.ctx);

    const withLines = rec.widgetCalls.filter((c) => Array.isArray(c.lines));
    assert.equal(withLines.length, 0, "no line arrays passed to setWidget while hidden");
  });

  it("idle/null path unchanged: widget cleared, status cleared, title reset to pi", () => {
    const rec = ctxWithState(null);

    updateUi(null, rec.ctx);

    assert.equal(rec.widgetCalls.length, 1);
    assert.equal(rec.widgetCalls[0].key, "workflow-todos");
    assert.equal(rec.widgetCalls[0].lines, undefined);
    assert.ok(
      rec.statuses.some((s) => s.key === "workflow" && s.value === undefined),
      "status should be cleared",
    );
    assert.equal(rec.titles[0], "pi");
  });
});
