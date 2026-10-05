import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSaveTaskTool, runFinalize } from "../extensions/finalize.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_ACTIVE_TOOLS = ["read", "bash", "write", "edit", "commit_changes"];

function mockPi(
  activeTools: string[] = DEFAULT_ACTIVE_TOOLS,
  execImpl?: ExtensionAPI["exec"],
): ExtensionAPI & { calls: Record<string, unknown[]> } {
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
    getActiveTools: () => [...activeTools],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: execImpl ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

function ctxWithState(state: WorkflowState | null, cwd = "/tmp/test"): ExtensionContext {
  return {
    cwd,
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

function discussingState(): WorkflowState {
  return { phase: "discussing", specText: "topic" };
}

function getSaveTask(pi: ExtensionAPI & { calls: Record<string, unknown[]> }) {
  const entries = (pi.calls["registerTool"] ?? []) as Array<[{ name: string; execute: Function }]>;
  return entries.find(([d]) => d.name === "save_task")![0];
}

const VALID = {
  title: "My Task",
  instruction: "do the thing",
  files: ["src/a.ts"],
  done: "tests pass",
  behaviors: [
    { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
  ],
};

describe("save_task", () => {
  it("transitions discussing → finalizing on a valid payload (T2)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "finalizing");
    assert.ok(s.task);
    assert.equal(s.task!.title, "My Task");
  });

  it("result message says read-only and wait for the user to run /implement (T3)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.match(res.content[0].text, /Phase: finalizing/);
    assert.match(res.content[0].text, /Wait for the user to run \/implement/);
  });

  it("rejects a malformed payload and stays in discussing", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute(
      "c1",
      { ...VALID, behaviors: [{ id: "T1", description: "x", expectedOutput: "y", kind: "bad" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /rejected/);
    assert.equal(s.phase, "discussing");
    assert.equal(s.task, undefined);
  });

  it("is idempotent: updates the contract when already finalizing", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const tool = getSaveTask(pi);

    await tool.execute("c1", VALID, undefined, undefined, ctx);
    assert.equal(s.phase, "finalizing");

    const updated = { ...VALID, title: "Renamed" };
    const res = await tool.execute("c2", updated, undefined, undefined, ctx);
    assert.notEqual(res.isError, true);
    assert.equal(s.phase, "finalizing");
    assert.equal(s.task!.title, "Renamed");
  });

  it("surfaces warning lines when the contract has advisory warnings (T1)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute(
      "c1",
      {
        ...VALID,
        behaviors: [
          {
            id: "T1",
            description: "Add test scenarios for validation",
            expectedOutput: "test file contains 3 cases covering edge cases",
            kind: "test",
            status: "active",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true, "warnings are advisory; save still succeeds");
    assert.match(res.content[0].text, /warning/i);
    assert.match(res.content[0].text, /warning: T1/);
  });

  it("clean contract produces no warning lines (T1)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.notEqual(res.isError, true);
    assert.doesNotMatch(res.content[0].text, /warning/i);
  });

  it("appends a warning count to the phase-transition notify (T1)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    await getSaveTask(pi).execute(
      "c1",
      {
        ...VALID,
        behaviors: [
          {
            id: "T1",
            description: "Add test scenarios for validation",
            expectedOutput: "test file contains 3 cases covering edge cases",
            kind: "test",
            status: "active",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(notifyCalls.length, 1);
    assert.match(notifyCalls[0]!, /warnings: 1/);
  });

  it("clean contract notify reports zero warnings (T1)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.equal(notifyCalls.length, 1);
    assert.match(notifyCalls[0]!, /warnings: 0/);
  });

  it("notifies once on the discussing -> finalizing entry", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.equal(notifyCalls.length, 1, "entry save should notify exactly once");
    assert.match(notifyCalls[0], /finalizing/);
    assert.ok(notifyCalls[0].includes("/implement"));
  });

  it("stays silent on contract updates while already finalizing", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };
    await getSaveTask(pi).execute("c2", { ...VALID, title: "Renamed" }, undefined, undefined, ctx);

    assert.equal(notifyCalls.length, 0, "update saves while finalizing must stay silent");
    assert.equal(s.task!.title, "Renamed");
  });

  it("rejects when not in a workflow phase", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const ctx = ctxWithState(null);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /discussing or finalizing/);
  });

  it("does not touch the active toolset (T1)", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    const setCalls = pi.calls["setActiveTools"] ?? [];
    assert.equal(setCalls.length, 0);
  });
});

describe("runFinalize (T5)", () => {
  it("refuses outside the discussing phase", async () => {
    const pi = mockPi();
    const ctx = ctxWithState({ phase: "finalizing", specText: "t" });

    await runFinalize("note", pi, ctx);

    assert.equal((pi.calls["sendUserMessage"] ?? []).length, 0);
  });

  it("appends an Engineer's note when args are provided", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(discussingState());

    await runFinalize("also add T7", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1);
    const [text] = send[0] as [string];
    assert.match(text, /## Engineer's note/);
    assert.match(text, /also add T7/);
    assert.match(text, /Fold this note into the contract where relevant/);
  });

  it("sends no note section when args are empty", async () => {
    const pi = mockPi();
    const ctx = ctxWithState(discussingState());

    await runFinalize("", pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1);
    const [text] = send[0] as [string];
    assert.doesNotMatch(text, /## Engineer's note/);
  });
});

// ═══ save_task scan wiring (T3) ═══
describe("save_task scan wiring (T3)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function tmpProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scan-"));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  function execReturning(stdout: string, exitCode = 0): ExtensionAPI["exec"] {
    return async () => ({ stdout, stderr: "", exitCode });
  }

  it("appends per-entry evidence with method+confidence and cross-check warnings", async () => {
    const dir = tmpProject({
      "src/a.ts": "export function handler() { return 200; }\n",
      "tests/flows.test.ts": 'import { handler } from "../a"\n',
    });
    const listing = ["./src/a.ts", "./tests/flows.test.ts"].join("\n") + "\n";
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execReturning(listing));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, dir);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    const res = await getSaveTask(pi).execute(
      "c1",
      { ...VALID, files: ["src/a.ts"] },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true, "scan warnings are advisory; save still succeeds");
    assert.match(
      res.content[0].text,
      /src\/a\.ts -> tests\/flows\.test\.ts \[import-path, high\]/,
      "evidence line must name method and confidence",
    );
    assert.match(res.content[0].text, /undeclared-referencing/);
    assert.match(notifyCalls[0]!, /warnings: 1/, "notify carries the scan warning count");
  });

  it("degrades to scan unavailable when the scan exec throws", async () => {
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, async () => {
      throw new Error("exec blocked");
    });
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.notEqual(res.isError, true, "scan failure must never block the save");
    assert.match(res.content[0].text, /Task saved/);
    assert.match(res.content[0].text, /scan unavailable — apply judgment from the discussion/);
  });

  it("degrades to scan unavailable when the find listing is empty", async () => {
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execReturning(""));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /Task saved/);
    assert.match(res.content[0].text, /scan unavailable/);
  });

  it("clean contract: success text intact, no warning lines, no scan-unavailable marker", async () => {
    const dir = tmpProject({
      "src/a.ts": "export const x = 1;\n",
      "tests/a.test.ts": "import { x } from '../src/a'\nexpect(x).toBe(1);\n",
    });
    const listing = ["./src/a.ts", "./tests/a.test.ts"].join("\n") + "\n";
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execReturning(listing));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, dir);

    const res = await getSaveTask(pi).execute(
      "c1",
      { ...VALID, files: ["src/a.ts", "tests/a.test.ts"] },
      undefined,
      undefined,
      ctx,
    );

    assert.match(res.content[0].text, /Task saved/);
    assert.match(res.content[0].text, /Phase: finalizing/);
    assert.doesNotMatch(res.content[0].text, /warning/i);
    assert.doesNotMatch(res.content[0].text, /scan unavailable/);
  });

  it("all-new files contract yields the no-evidence note", async () => {
    const dir = tmpProject({ "tests/existing.test.ts": "nothing relevant\n" });
    const listing = "./tests/existing.test.ts\n";
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execReturning(listing));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, dir);
    const notifyCalls: string[] = [];
    ctx.ui.notify = (msg: string) => {
      notifyCalls.push(msg);
    };

    const res = await getSaveTask(pi).execute(
      "c1",
      { ...VALID, files: ["src/newfeature.ts"] },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /no-evidence/);
    assert.match(res.content[0].text, /declared-not-found/);
    assert.match(notifyCalls[0]!, /warnings: 2/);
  });
});
