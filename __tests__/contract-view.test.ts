// T11 — readable contract view at save_task: rendered with zero model
// tokens (details payload, TUI renderCall/renderResult, RPC notify).

import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSaveTaskTool } from "../extensions/finalize.ts";
import { renderContractView } from "../extensions/contract-view.ts";
import type { ContractV2 } from "../extensions/contract-types.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_ACTIVE_TOOLS = ["read", "bash", "write", "edit", "commit_changes"];

function mockPi(execImpl?: ExtensionAPI["exec"]): ExtensionAPI & { calls: Record<string, unknown[]> } {
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
    getActiveTools: () => [...DEFAULT_ACTIVE_TOOLS],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: execImpl ?? (async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function ctxWithState(state: WorkflowState | null, mode: "tui" | "rpc" = "tui"): ExtensionContext {
  const notifications: string[] = [];
  const ctx = {
    cwd: "/tmp/contract-view",
    mode,
    sessionManager: {
      getBranch: () =>
        state ? [{ type: "custom", customType: "workflow-state", data: state }] : [],
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
    notifications,
  };
  return ctx as unknown as ExtensionContext & { notifications: string[] };
}

function discussingState(): WorkflowState {
  return { phase: "discussing", specText: "topic" };
}

/** Loose shape of the registered save_task tool for renderer calls. */
interface SaveTaskTool {
  execute(
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown>; isError?: boolean }>;
  renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
  renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => {
    render(width: number): string[];
  };
}

function getSaveTask(pi: ExtensionAPI & { calls: Record<string, unknown[]> }): SaveTaskTool {
  const entries = (pi.calls["registerTool"] ?? []) as Array<[{ name: string }]>;
  return entries.find(([d]) => d.name === "save_task")![0] as unknown as SaveTaskTool;
}

const PAYLOAD = {
  title: "My Task",
  instruction: "do the thing",
  done: "tests pass",
  sources: [
    { path: "src/a.ts", tasks: ["T1"] },
    { path: "del.ts", status: "D", tasks: ["T1", "T2"] },
  ],
  tests: [
    { path: "tests/a.test.ts", tasks: ["T1"] },
    { path: "tests/b.test.ts", tasks: ["T2"] },
  ],
  tasks: [
    {
      id: "T1",
      description: "x",
      expectedOutput: ["returns x", "returns y"],
      status: "active",
      commit: "feat: implement x",
    },
    { id: "T2", description: "m", expectedOutput: ["inspect: manual step"], status: "active" },
    { id: "T3", description: "gone", expectedOutput: ["inspect: old"], status: "removed", commit: "chore: remove gone" },
  ],
};

function contract(): ContractV2 {
  return {
    title: PAYLOAD.title,
    instruction: PAYLOAD.instruction,
    done: PAYLOAD.done,
    sources: PAYLOAD.sources as ContractV2["sources"],
    tests: PAYLOAD.tests as ContractV2["tests"],
    tasks: PAYLOAD.tasks as ContractV2["tasks"],
  };
}

const THEME = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  dim: (t: string) => t,
};

const RENDER_CONTEXT = {
  args: PAYLOAD,
  toolCallId: "c1",
  invalidate: () => {},
  lastComponent: undefined,
  state: {},
  cwd: "/tmp",
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: false,
  isError: false,
  durationMs: 1,
  outputPad: 0,
  keyText: () => "",
  keyHint: (_k: string, d: string) => d,
};

function text(component: { render(width: number): string[] }): string {
  return component.render(400).join("\n");
}

describe("renderContractView", () => {
  it("renders each non-removed task as '# Task <id>' with its commit in backticks", () => {
    const view = renderContractView(contract());

    assert.match(view, /^# Task T1$/m);
    assert.match(view, /Commit: `feat: implement x`/);
    assert.match(view, /^# Task T2$/m);
    assert.doesNotMatch(view, /^# Task T3$/m, "removed tasks must not render");
    assert.doesNotMatch(view, /chore: remove gone/, "a removed task's commit must not render");
  });

  it("emits a fallback note when a task declares no commit", () => {
    const view = renderContractView(contract());

    const t2Block = view.split("# Task T2")[1]!.split("\n\n")[0]!;
    assert.match(t2Block, /falls back to/);
    assert.match(t2Block, /"feat: implement m"/);
    assert.doesNotMatch(t2Block, /Commit: `/);
  });

  it("renders an Assertions bullet list per task", () => {
    const view = renderContractView(contract());

    const t1Block = view.split("# Task T1")[1]!.split("\n\n")[0]!;
    assert.match(t1Block, /Assertions:\n- returns x\n- returns y/);
  });

  it("lists each task's owned Sources/Tests paths and marks D entries", () => {
    const view = renderContractView(contract());

    const t1Block = view.split("# Task T1")[1]!.split("\n\n")[0]!;
    assert.match(t1Block, /Sources:\n- src\/a\.ts\n- del\.ts \(D\)/);
    assert.match(t1Block, /Tests:\n- tests\/a\.test\.ts/);
    assert.doesNotMatch(t1Block, /tests\/b\.test\.ts/, "T2's test path belongs to T2 only");

    const t2Block = view.split("# Task T2")[1]!.split("\n\n")[0]!;
    assert.match(t2Block, /Sources:\n- del\.ts \(D\)/, "shared path renders under its second owner");
    assert.match(t2Block, /Tests:\n- tests\/b\.test\.ts/);
    assert.doesNotMatch(t2Block, /src\/a\.ts/);
  });
});

describe("save_task result details and renderers (T11)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function tmpProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-view-"));
    tmpDirs.push(dir);
    return dir;
  }

  async function save(mode: "tui" | "rpc" = "tui") {
    const dir = tmpProject();
    const pi = mockPi(async () => ({ stdout: "", stderr: "", code: 1, killed: false }));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, mode);
    ctx.cwd = dir;
    const res = await getSaveTask(pi).execute("c1", PAYLOAD, undefined, undefined, ctx);
    return { pi, s, ctx, res, dir };
  }

  it("returns the rendered view in result details while content text stays unchanged", async () => {
    const { res, s } = await save();

    assert.notEqual(res.isError, true, res.content[0]?.text ?? "");
    const view = res.details?.contractView;
    assert.equal(typeof view, "string", "details must carry the rendered contract view");
    assert.match(view!, /^# Task T1$/m);
    assert.equal(view, renderContractView(s.contractV2!), "details view mirrors the saved contract");

    assert.match(res.content[0].text, /Task saved/);
    assert.match(res.content[0].text, /Phase: finalizing/);
    assert.doesNotMatch(
      res.content[0].text,
      /# Task T1/,
      "the model-facing content text must not carry the view",
    );
  });

  it("renderCall displays the view instead of the raw JSON payload", async () => {
    const { pi } = await save();
    const tool = getSaveTask(pi);
    assert.ok(tool.renderCall, "save_task must register a renderCall renderer");

    const out = text(tool.renderCall!(PAYLOAD, THEME, RENDER_CONTEXT));

    assert.match(out, /^# Task T1$/m);
    assert.match(out, /Commit: `feat: implement x`/);
    assert.match(out, /Assertions:/);
    assert.match(out, /Sources:/);
    assert.doesNotMatch(out, /"expectedOutput"/, "raw JSON payload must not render");
    assert.doesNotMatch(out, /"sources"/, "raw JSON payload must not render");
  });

  it("renderResult displays the view from details instead of the raw JSON payload", async () => {
    const { pi, res } = await save();
    const tool = getSaveTask(pi);
    assert.ok(tool.renderResult, "save_task must register a renderResult renderer");

    const out = text(
      tool.renderResult!(res, { expanded: false, isPartial: false }, THEME, RENDER_CONTEXT),
    );

    assert.match(out, /^# Task T1$/m);
    assert.match(out, /Tests:/);
    assert.doesNotMatch(out, /"contractView"/, "details must not render as raw JSON");
    assert.doesNotMatch(out, /Task saved\./, "the model-facing text is not what renders");
  });
});

describe("save_task RPC notify (T11)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  async function save(mode: "tui" | "rpc") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-view-notify-"));
    tmpDirs.push(dir);
    const pi = mockPi(async () => ({ stdout: "", stderr: "", code: 1, killed: false }));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, mode);
    ctx.cwd = dir;
    const res = await getSaveTask(pi).execute("c1", PAYLOAD, undefined, undefined, ctx);
    const notifications = (ctx as unknown as { notifications: string[] }).notifications;
    return { res, notifications };
  }

  it("sends the rendered view through ctx.ui.notify in RPC mode", async () => {
    const { res, notifications } = await save("rpc");

    assert.notEqual(res.isError, true, res.content[0]?.text ?? "");
    const view = notifications.find((n) => n.includes("# Task T1"));
    assert.ok(view, `RPC mode must notify the view; got: ${JSON.stringify(notifications)}`);
    assert.match(view!, /Commit: `feat: implement x`/);
    assert.match(view!, /Assertions:/);
    assert.match(view!, /Sources:/);
    assert.match(view!, /Tests:/);
  });

  it("does not notify the view in TUI mode", async () => {
    const { notifications } = await save("tui");

    assert.ok(
      notifications.every((n) => !n.includes("# Task T1")),
      `TUI mode must not notify the view; got: ${JSON.stringify(notifications)}`,
    );
  });
});
