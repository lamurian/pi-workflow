import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSaveTaskTool, runFinalize } from "../extensions/finalize.ts";
import { preserveDoneStatuses } from "../extensions/contract-v1-view.ts";
import type { TaskContract, Behavior } from "../extensions/state.ts";
import { loadContent } from "../extensions/utils.ts";
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
    exec: execImpl ?? (async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
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
  done: "tests pass",
  sources: [{ path: "src/a.ts", tasks: ["T1"] }],
  tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
  tasks: [
    { id: "T1", description: "x", expectedOutput: ["returns x"], status: "active" },
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
      { ...VALID, tasks: [{ id: "T1", description: "x", expectedOutput: [], status: "active" }] },
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
        tasks: [
          {
            id: "T1",
            description: "Add test scenarios for validation",
            expectedOutput: ["test file contains 3 cases covering edge cases"],
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
        tasks: [
          {
            id: "T1",
            description: "Add test scenarios for validation",
            expectedOutput: ["test file contains 3 cases covering edge cases"],
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

  /** Mirrors pi's real ExecResult: { stdout, stderr, code, killed }. */
  function execReturning(stdout: string, code = 0): ExtensionAPI["exec"] {
    return async () => ({ stdout, stderr: "", code, killed: false });
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
      { ...VALID, tests: [] },
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

  it("degrades to scan unavailable when find exits non-zero", async () => {
    // Regression for the ExecResult.code fix: a non-zero code must yield
    // null (scan unavailable) even when stdout carries a listing.
    const listing = ["./src/a.ts"].join("\n") + "\n";
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execReturning(listing, 1));
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
      VALID,
      undefined,
      undefined,
      ctx,
    );

    assert.match(res.content[0].text, /Task saved/);
    assert.match(res.content[0].text, /Phase: finalizing/);
    assert.doesNotMatch(res.content[0].text, /warning/i);
    assert.doesNotMatch(res.content[0].text, /scan unavailable/);
  });

  it("all-new files contract (status A) yields the no-evidence note but no declared-not-found", async () => {
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
      { ...VALID, sources: [{ path: "src/newfeature.ts", tasks: ["T1"] }], tests: [] },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /no-evidence/);
    assert.doesNotMatch(
      res.content[0].text,
      /declared-not-found/,
      "A entries are expected not to exist yet — declared-not-found must be skipped",
    );
    assert.match(notifyCalls[0]!, /warnings: 1/, "only the no-evidence note remains");
  });

  it("an A entry that already exists on disk yields the declared-add-exists warning", async () => {
    const dir = tmpProject({
      "src/a.ts": "export function handler() { return 200; }\n",
      "tests/flows.test.ts": 'import { handler } from "../a"\n',
    });
    const listing = ["./src/a.ts", "./tests/flows.test.ts"].join("\n") + "\n";
    // git reports nothing tracked: every declared path derives A, and an A
    // entry that exists on disk is the declared-add-exists case.
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, async (cmd: string) => {
      if (cmd === "git") return { stdout: "", stderr: "", code: 0, killed: false };
      return { stdout: listing, stderr: "", code: 0, killed: false };
    });
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, dir);

    const res = await getSaveTask(pi).execute(
      "c1",
      { ...VALID, sources: [{ path: "src/a.ts", tasks: ["T1"] }], tests: [] },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /declared-add-exists/);
    assert.match(res.content[0].text, /src\/a\.ts/);
  });

  it("renders evidence through renderEvidence: collapsed summary, no per-match explosion (T4)", async () => {
    // One entry whose basename fans out across 12 test files: save_task must
    // surface renderEvidence's one-line summary, not 12 raw per-match lines.
    const files: Record<string, string> = {
      "src/messages/en/research.json": '{"topic": "research"}\n',
    };
    for (let j = 0; j < 12; j++) files[`tests/t${j}.test.ts`] = "// research notes\n";
    const dir = tmpProject(files);
    const listing =
      Object.keys(files)
        .map((f) => `./${f}`)
        .join("\n") + "\n";
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execReturning(listing));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, dir);

    const res = await getSaveTask(pi).execute(
      "c1",
      { ...VALID, sources: [{ path: "src/messages/en/research.json", tasks: ["T1"] }], tests: [] },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true);
    const text = res.content[0].text;
    const evidence = text.split("## Test scan evidence (advisory)\n")[1]?.split("\n\nWarnings")[0] ?? "";
    const bullets = evidence.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(bullets.length, 1, `expected one collapsed bullet, got:\n${evidence}`);
    assert.match(
      bullets[0]!,
      /^- src\/messages\/en\/research\.json: 12 test files match \[basename, low\] — e\.g\. tests\/t0\.test\.ts, tests\/t1\.test\.ts, tests\/t2\.test\.ts — too generic to enumerate; grep "\\bresearch\\b" in test files if relevant$/,
      "summary line must carry count, 3 samples, and the grep hint",
    );
    assert.doesNotMatch(
      text,
      /\S+ -> \S+ \[basename, low\]/,
      "raw per-match [basename, low] lines must not reach the tool text",
    );
  });

  it("keeps save_task result text under 32 KB for a large contract (render wiring)", async () => {
    // 100 declared entries x 30 test files all basename-matching every entry:
    // 3,000 raw evidence lines must render small via collapse + global cap.
    const entryCount = 100;
    const testCount = 30;
    const basenames = Array.from({ length: entryCount }, (_, i) => `feat${i}`);
    const testContent = basenames.join(" ") + "\n";
    const files: Record<string, string> = {};
    // The render-wiring fixture is deliberately over-broad (100 paths for one
    // task); raise the T1 per-task cap for this project so the breadth check
    // does not reject before the rendering is exercised.
    files[".pi/workflow.json"] = JSON.stringify({ finalize: { maxPathsPerTask: 200 } });
    for (let i = 0; i < entryCount; i++) files[`src/feat${i}.ts`] = "use strict;\n";
    for (let j = 0; j < testCount; j++) files[`tests/f${j}.test.ts`] = testContent;
    const dir = tmpProject(files);
    const listing =
      Object.keys(files)
        .map((f) => `./${f}`)
        .join("\n") + "\n";
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execReturning(listing));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, dir);

    const res = await getSaveTask(pi).execute(
      "c1",
      { ...VALID, sources: Object.keys(files).filter((f) => f.startsWith("src/")).map((f) => ({ path: f, tasks: ["T1"] as string[] })), tests: [] },
      undefined,
      undefined,
      ctx,
    );

    assert.notEqual(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /too generic to enumerate/, "fan-out must collapse to summaries");
    const bytes = Buffer.byteLength(text, "utf8");
    assert.ok(bytes < 32 * 1024, `save_task text was ${bytes} bytes, must stay under 32 KB`);
  });
});

// ═══ save_task test-tool ensure wiring (T3) ═══
describe("save_task test-tool ensure wiring (T3)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function tmpProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ensure-"));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  /** git ls-files exits 1 (untracked -> A); find returns the given listing. */
  function execForEnsure(listing: string): ExtensionAPI["exec"] {
    return async (cmd: string) => {
      if (cmd === "git") {
        return { stdout: "", stderr: "error: pathspec did not match", code: 1, killed: false };
      }
      return { stdout: listing, stderr: "", code: 0, killed: false };
    };
  }

  it("generates .pi/extensions/test.ts, persists testTool, echoes the line", async () => {
    const dir = tmpProject({
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      "src/a.ts": "export const x = 1;\n",
    });
    const listing = ["./package.json", "./src/a.ts"].join("\n") + "\n";
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execForEnsure(listing));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, dir);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.notEqual(res.isError, true);
    assert.match(
      res.content[0].text,
      /test tool generated: \.pi\/extensions\/test\.ts — runs 1 suite\(s\)/,
      "the save result echoes the no-status detection evidence line (T7: no injection)",
    );
    assert.deepEqual(
      s.testTool,
      {
        source: "detected",
        suites: [
          {
            label: "javascript (npx vitest run {tests})",
            argv: ["npx", "vitest", "run", "{tests}"],
            scope: "files",
          },
        ],
        fullSuites: [
          {
            label: "javascript (npx vitest run {tests})",
            argv: ["npx", "vitest", "run", "{tests}"],
            scope: "files",
          },
        ],
      },
      "state.testTool records the detection result",
    );
    assert.ok(
      !s.task!.files.some((f) => f.path === ".pi/extensions/test.ts"),
      `task.files must NOT carry the generated entry (T7: orchestrator-owned, no injection), got ${JSON.stringify(s.task!.files)}`,
    );
    assert.ok(
      s.task!.files.some((f) => f.path === "src/a.ts" && f.status === "A"),
      "the drafted entries survive the append (untracked here -> A)",
    );
    const generated = path.join(dir, ".pi", "extensions", "test.ts");
    assert.ok(fs.existsSync(generated), "the ensure step wrote the file to disk");
    assert.match(fs.readFileSync(generated, "utf8"), /GENERATED by pi-workflow/);
  });

  it("manifest-free dir: no-suite message, no files entry, no file on disk", async () => {
    const dir = tmpProject({ "src/a.ts": "export const x = 1;\n" });
    const listing = "./src/a.ts\n";
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, execForEnsure(listing));
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s, dir);

    const res = await getSaveTask(pi).execute("c1", VALID, undefined, undefined, ctx);

    assert.notEqual(res.isError, true, "no suites must never block the save");
    assert.match(
      res.content[0].text,
      /no test tool: no test suites detected \(no manifest matched\)/,
      "the save result carries the no-suite message",
    );
    assert.deepEqual(s.testTool, { source: "none", suites: [], fullSuites: [] });
    assert.ok(
      !s.task!.files.some((f) => f.path === ".pi/extensions/test.ts"),
      "no files entry is appended when nothing was generated",
    );
    assert.ok(
      !fs.existsSync(path.join(dir, ".pi", "extensions", "test.ts")),
      "no file is written when no manifest matched",
    );
  });
});

// ═══ finalize-prompt.md content assertions (T6) ═══
describe("finalize-prompt.md content assertions (T6)", () => {
  it("codifies the co-location rule: behavior = test + impl, never split", async () => {
    const content = await loadContent("finalize-prompt.md");
    assert.match(content, /one behavior = test \+ implementation/i);
    assert.match(content, /never split/i);
    assert.match(content, /independently green-committable/i);
  });

  it("kind: 'test' means verified-by-test; test-artifact-only expectedOutput is invalid", async () => {
    const content = await loadContent("finalize-prompt.md");
    assert.match(content, /verified-by-test/);
    assert.match(content, /test artifacts? only/i);
    assert.match(content, /red by construction/i);
  });

  it("instructs classifying save_task scan-evidence items honoring confidence tags", async () => {
    const content = await loadContent("finalize-prompt.md");
    assert.match(content, /scan evidence/i);
    assert.match(content, /confidence tag/i);
    assert.match(content, /unverified/i);
  });

  it("contains the preserved/superseded/obsolete/out-of-scope classification", async () => {
    const content = await loadContent("finalize-prompt.md");
    for (const word of ["preserved", "superseded", "obsolete", "out-of-scope"]) {
      assert.match(content, new RegExp(word), `classification must mention ${word}`);
    }
  });

  it("fold rule: test updates never form their own behavior", async () => {
    const content = await loadContent("finalize-prompt.md");
    assert.match(content, /never (?:form )?their own behavior/i);
  });

  it("files-declaration rule: declare superseded/obsolete test paths in files", async () => {
    const content = await loadContent("finalize-prompt.md");
    assert.match(content, /declare/i);
    assert.match(content, /files/);
  });

  it("the blanket do-not-re-explore wording is gone, replaced by evidence flow", async () => {
    const content = await loadContent("finalize-prompt.md");
    assert.doesNotMatch(
      content,
      /Do NOT re-explore the codebase/,
      "blanket do-not-re-explore instruction must be replaced",
    );
  });
});

// ═══ unit-prompt.md content assertions (T7) ═══
describe("unit-prompt.md content assertions (T7)", () => {
  it("red step is mandatory for test-kind behaviors — no optional qualifier on the red step", async () => {
    const content = await loadContent("unit-prompt.md");
    assert.match(content, /Red:/);
    assert.match(content, /failing test/i);
    const redLine = content.split("\n").find((l) => l.includes("Red:")) ?? "";
    assert.doesNotMatch(redLine, /optional/i, "the red step itself must not be optional");
  });

  it("states the enforced-guard wording: orchestrator inspects the staged diff", async () => {
    const content = await loadContent("unit-prompt.md");
    assert.match(content, /staged diff/i);
    assert.match(content, /enforced/i);
    assert.match(content, /delete/i);
    assert.match(content, /skip/i);
  });

  it("declared-path semantics: contract files may change, undeclared test paths are protected", async () => {
    const content = await loadContent("unit-prompt.md");
    assert.match(content, /declared/i);
    assert.match(content, /undeclared/i);
  });

  it("keeps existing invariants: only the named behavior, JSON report, no commits", async () => {
    const content = await loadContent("unit-prompt.md");
    assert.match(content, /Implement ONLY the behavior named in the task text/);
    assert.match(content, /suggestedCommit/);
    assert.match(content, /Do NOT run `git commit`/);
  });
});

// ═══ done-preservation on re-finalize (T10) ═══
function contract(behaviors: Behavior[]): TaskContract {
  return {
    title: "My Task",
    instruction: "do the thing",
    files: [{ path: "src/a.ts", status: "M" }],
    done: "tests pass",
    behaviors,
  };
}

describe("preserveDoneStatuses (T10)", () => {
  it("keeps a prior done behavior done when description and expectedOutput are identical", () => {
    const prior = contract([{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "done" }]);
    const draft = contract([{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }]);

    const { task, preserved } = preserveDoneStatuses(prior, draft);

    assert.deepEqual(preserved, ["T1"]);
    assert.equal(task.behaviors[0].status, "done");
    assert.equal(draft.behaviors[0].status, "active", "draft must not be mutated");
  });

  it("leaves the draft status when the description changed", () => {
    const prior = contract([{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "done" }]);
    const draft = contract([{ id: "T1", description: "x changed", expectedOutput: "y", kind: "test", status: "active" }]);

    const { task, preserved } = preserveDoneStatuses(prior, draft);

    assert.deepEqual(preserved, []);
    assert.equal(task.behaviors[0].status, "active");
  });

  it("leaves the draft status when the expectedOutput changed", () => {
    const prior = contract([{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "done" }]);
    const draft = contract([{ id: "T1", description: "x", expectedOutput: "y changed", kind: "test", status: "active" }]);

    const { task, preserved } = preserveDoneStatuses(prior, draft);

    assert.deepEqual(preserved, []);
    assert.equal(task.behaviors[0].status, "active");
  });

  it("does not preserve when the prior behavior was not done", () => {
    const prior = contract([{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }]);
    const draft = contract([{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }]);

    const { task, preserved } = preserveDoneStatuses(prior, draft);

    assert.deepEqual(preserved, []);
    assert.equal(task.behaviors[0].status, "active");
  });

  it("returns the draft untouched when there is no prior contract", () => {
    const draft = contract([{ id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" }]);

    const { task, preserved } = preserveDoneStatuses(undefined, draft);

    assert.deepEqual(preserved, []);
    assert.equal(task, draft);
  });
});

describe("save_task done-preservation (T10)", () => {
  const PRIOR_DONE = {
    ...VALID,
    tasks: [{ id: "T1", description: "x", expectedOutput: ["y"], status: "done" as const }],
  };

  it("keeps T1 done across re-finalize and reports it in the tool result", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s: WorkflowState = { phase: "discussing", specText: "topic", contractV2: PRIOR_DONE };
    const ctx = ctxWithState(s);
    const draft = { ...VALID, tasks: [
      { id: "T1", description: "x", expectedOutput: ["y"], status: "active" },
    ] };

    const res = await getSaveTask(pi).execute("c1", draft, undefined, undefined, ctx);

    assert.equal(s.task!.behaviors[0].status, "done");
    assert.match(res.content[0].text, /Preserved done behaviors: T1/);
  });

  it("leaves the draft status when the description changed and reports no preservation", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s: WorkflowState = { phase: "discussing", specText: "topic", contractV2: PRIOR_DONE };
    const ctx = ctxWithState(s);
    const draft = { ...VALID, tasks: [
      { id: "T1", description: "x changed", expectedOutput: ["y"], status: "active" },
    ] };

    const res = await getSaveTask(pi).execute("c1", draft, undefined, undefined, ctx);

    assert.equal(s.task!.behaviors[0].status, "active");
    assert.doesNotMatch(res.content[0].text, /Preserved done behaviors/);
  });

  it("leaves the draft status when the expectedOutput changed", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s: WorkflowState = { phase: "discussing", specText: "topic", contractV2: PRIOR_DONE };
    const ctx = ctxWithState(s);
    const draft = { ...VALID, tasks: [
      { id: "T1", description: "x", expectedOutput: ["y changed"], status: "active" },
    ] };

    const res = await getSaveTask(pi).execute("c1", draft, undefined, undefined, ctx);

    assert.equal(s.task!.behaviors[0].status, "active");
    assert.doesNotMatch(res.content[0].text, /Preserved done behaviors/);
  });
});

// "T10": save_task accepts contract v2 payloads and persists them directly.
const VALID_V2 = {
  title: "My Task",
  instruction: "do the thing",
  done: "tests pass",
  sources: [{ path: "src/a.ts", tasks: ["T1"] }],
  tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
  tasks: [
    { id: "T1", description: "x", expectedOutput: ["returns x"], status: "active" },
  ],
};

describe("save_task contract v2 (T10)", () => {
  it("persists a valid v2 payload as state.contractV2 equal to the validated contract", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID_V2, undefined, undefined, ctx);

    assert.notEqual(res.isError, true, res.content?.[0]?.text ?? "");
    assert.equal(s.phase, "finalizing");
    assert.deepEqual(s.contractV2, VALID_V2, "state.contractV2 carries the validated contract");
  });

  it("rejects a v2 payload with a dangling taskRef, names the invariant and persists nothing", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const bad = {
      ...VALID_V2,
      sources: [{ path: "src/a.ts", tasks: ["T99"] }],
    };

    const res = await getSaveTask(pi).execute("c1", bad, undefined, undefined, ctx);

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /dangling taskRef/);
    assert.equal(s.phase, "discussing", "nothing persisted on rejection");
    assert.equal(s.contractV2, undefined);
    assert.equal(s.task, undefined);
  });

  it("rejects an old files/behaviors payload with a reason naming sources, tests and tasks", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const legacy = {
      title: "My Task",
      instruction: "do the thing",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    };

    const res = await getSaveTask(pi).execute("c1", legacy, undefined, undefined, ctx);

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /sources/);
    assert.match(res.content[0].text, /tests/);
    assert.match(res.content[0].text, /tasks/);
    assert.equal(s.contractV2, undefined);
  });

  it("derives state.task files with D kept, A untracked and M tracked at HEAD", async () => {
    const pi = mockPi(DEFAULT_ACTIVE_TOOLS, async (cmd, args) => {
      if (cmd === "git" && args[0] === "ls-tree") {
        return { stdout: "src/tracked.ts\ndel.ts\n", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const payload = {
      title: "My Task",
      instruction: "do the thing",
      done: "tests pass",
      sources: [
        { path: "src/tracked.ts", tasks: ["T1"] },
        { path: "src/new.ts", tasks: ["T1"] },
        { path: "del.ts", status: "D", tasks: ["T1"] },
      ],
      tests: [{ path: "tests/a.test.ts", tasks: ["T1"] }],
      tasks: [{ id: "T1", description: "x", expectedOutput: ["returns x"], status: "active" }],
    };

    const res = await getSaveTask(pi).execute("c1", payload, undefined, undefined, ctx);
    assert.notEqual(res.isError, true, res.content?.[0]?.text ?? "");

    const byPath = new Map(s.task!.files.map((f) => [f.path, f.status]));
    assert.equal(byPath.get("src/tracked.ts"), "M", "tracked at HEAD -> M");
    assert.equal(byPath.get("src/new.ts"), "A", "untracked -> A");
    assert.equal(byPath.get("del.ts"), "D", "declared D is kept");
    assert.equal(byPath.get("tests/a.test.ts"), "A", "untracked test file -> A");
  });

  it("derives one behavior per task: kind by tests ownership, '; ' join, first owned source as sourceFile", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const payload = {
      title: "My Task",
      instruction: "do the thing",
      done: "tests pass",
      sources: [
        { path: "src/first.ts", tasks: ["T1"] },
        { path: "src/second.ts", tasks: ["T1"] },
        { path: "src/manual.ts", tasks: ["T2"] },
      ],
      tests: [{ path: "tests/b.test.ts", tasks: ["T1"] }],
      tasks: [
        { id: "T1", description: "d1", expectedOutput: ["e1", "e2"], status: "active" },
        { id: "T2", description: "d2", expectedOutput: ["manual step"], status: "active" },
      ],
    };

    const res = await getSaveTask(pi).execute("c1", payload, undefined, undefined, ctx);
    assert.notEqual(res.isError, true, res.content?.[0]?.text ?? "");

    assert.equal(s.task!.behaviors.length, 2, "one behavior per task");
    const t1 = s.task!.behaviors[0]!;
    assert.equal(t1.kind, "test", "T1 owns a tests path");
    assert.equal(t1.expectedOutput, "e1; e2", "assertions joined with '; '");
    assert.equal(t1.sourceFile, "src/first.ts", "first owned source path");
    const t2 = s.task!.behaviors[1]!;
    assert.equal(t2.kind, "manual", "T2 owns no tests path");
    assert.equal(t2.sourceFile, "src/manual.ts");
    assert.equal(t2.description, "d2");
  });

  it("re-saving keeps status done for task ids done in the prior contract", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s: WorkflowState = {
      phase: "discussing",
      specText: "topic",
      contractV2: {
        ...VALID_V2,
        tasks: [{ id: "T1", description: "x", expectedOutput: ["returns x"], status: "done" }],
      },
    };
    const ctx = ctxWithState(s);

    const res = await getSaveTask(pi).execute("c1", VALID_V2, undefined, undefined, ctx);

    assert.notEqual(res.isError, true, res.content?.[0]?.text ?? "");
    assert.equal(s.contractV2!.tasks[0]!.status, "done", "preserved in the saved contract");
    assert.equal(s.task!.behaviors[0]!.status, "done", "preserved in the derived view");
    assert.match(res.content[0].text, /Preserved done behaviors: T1/);
  });

  it("deriveAllowlist of the saved contract gives an ownerless-looking tests path its owner T2", async () => {
    const { deriveAllowlist } = await import("../extensions/contract-derive.ts");
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s = discussingState();
    const ctx = ctxWithState(s);
    const payload = {
      title: "My Task",
      instruction: "do the thing",
      done: "tests pass",
      sources: [{ path: "src/x.ts", tasks: ["T2"] }],
      tests: [{ path: "tests/b.test.ts", tasks: ["T2"] }],
      tasks: [{ id: "T2", description: "d", expectedOutput: ["e"], status: "active" }],
    };

    await getSaveTask(pi).execute("c1", payload, undefined, undefined, ctx);

    const entry = deriveAllowlist(s.contractV2!).find((e) => e.path === "tests/b.test.ts");
    assert.deepEqual(entry?.refs, ["T2"], "the tests path carries its owning task");
  });

  it("contract modulesWithinLineBudget: the four split modules are each at most 250 lines and finalize.ts at most 300", () => {
    const limits: Array<[string, number]> = [
      ["task-contract.ts", 250],
      ["contract-v2-validate.ts", 250],
      ["completion-gate.ts", 250],
      ["contract-v1-view.ts", 250],
      ["finalize.ts", 300],
    ];
    for (const [file, limit] of limits) {
      const text = fs.readFileSync(new URL(`../extensions/${file}`, import.meta.url), "utf8");
      const lines = text.split("\n").length;
      assert.ok(lines <= limit, `${file} has ${lines} lines (budget ${limit})`);
    }
  });
});

// ═══ per-task path cap (T1) ═══
describe("save_task per-task path cap (T1)", () => {
  it("rejects an over-limit task naming 'task too broad' and leaves state and phase unchanged", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const s: WorkflowState = { phase: "discussing", specText: "topic", contractV2: VALID_V2 };
    const ctx = ctxWithState(s);
    const draft = {
      ...VALID_V2,
      sources: Array.from({ length: 11 }, (_, i) => ({ path: `src/p${i}.ts`, tasks: ["T1"] })),
    };

    const res = await getSaveTask(pi).execute("c1", draft, undefined, undefined, ctx);

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /save_task rejected: task too broad/);
    assert.match(res.content[0].text, /\bT1\b/);
    assert.match(res.content[0].text, /\blimit 10\b/);
    assert.deepEqual(s.contractV2, VALID_V2, "prior contract must stay untouched");
    assert.equal(s.phase, "discussing", "phase must stay unchanged on rejection");
    assert.equal(s.task, undefined, "no v1 view is derived on rejection");
  });

  it("applies the cap to the done-preserved contract: a preserved done task stays exempt", async () => {
    const pi = mockPi();
    registerSaveTaskTool(pi);
    const sources = Array.from({ length: 11 }, (_, i) => ({ path: `src/p${i}.ts`, tasks: ["T1"] }));
    const prior = {
      ...VALID_V2,
      sources,
      tasks: [{ id: "T1", description: "x", expectedOutput: ["returns x"], status: "done" as const }],
    };
    const s: WorkflowState = { phase: "discussing", specText: "topic", contractV2: prior };
    const ctx = ctxWithState(s);
    const draft = { ...VALID_V2, sources };

    const res = await getSaveTask(pi).execute("c1", draft, undefined, undefined, ctx);

    assert.notEqual(res.isError, true, res.content?.[0]?.text ?? "");
    assert.equal(s.phase, "finalizing");
    assert.equal(s.contractV2!.tasks[0]!.status, "done", "preserved done stays done");
  });
});

describe("finalize-prompt.md task-too-broad invariant (T1)", () => {
  it("lists the invariant with the finalize.maxPathsPerTask setting and default 10", async () => {
    const content = await loadContent("finalize-prompt.md");
    assert.match(content, /task too broad/);
    assert.match(content, /finalize\.maxPathsPerTask/);
    assert.match(content, /default 10/);
  });
});
