import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImplement } from "../extensions/implement.ts";
import type { TaskContract, WorkflowState } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Live smoke tests for the orchestrator (M2). They drive the real
 * runImplement entry point against a scratch git repo with a real test
 * command and real commits — only the unit runner (the pi subprocess that
 * edits files) is scripted, since spawning a live model is covered by the
 * opt-in scout integration test. Enable with PI_RUN_INTEGRATION=1.
 */
const RUN_LIVE = process.env.PI_RUN_INTEGRATION === "1";

const T1_TEST = [
  'const { test } = require("node:test");',
  'const assert = require("node:assert");',
  'const fs = require("node:fs");',
  'test("greet returns hello", () => {',
  '  if (!fs.existsSync("src/greet.js")) return;',
  '  const { greet } = require("../src/greet.js");',
  '  assert.equal(greet(), "hello");',
  "});",
  "",
].join("\n");

const T2_TEST = [
  'const { test } = require("node:test");',
  'const assert = require("node:assert");',
  'const fs = require("node:fs");',
  'test("shout returns HELLO", () => {',
  '  if (!fs.existsSync("src/shout.js")) return;',
  '  const { shout } = require("../src/shout.js");',
  '  assert.equal(shout(), "HELLO");',
  "});",
  "",
].join("\n");

/** Real exec backed by spawnSync — exercises actual git and npm. */
function execShim(cwd: string) {
  return async (
    command: string,
    args: string[],
    _opts?: unknown,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const res = spawnSync(command, args, { cwd, encoding: "utf8" });
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      exitCode: res.status ?? 1,
    };
  };
}

function git(repo: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** Create a scratch git repo whose `npm test` runs node:test in test/. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pi-orch-live-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "orch-live@test");
  git(repo, "config", "user.name", "orch-live");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "orch-live", private: true, scripts: { test: "node --test" } }, null, 2),
  );
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  // A real (trivial) scaffold test: keeps test/ tracked in git and gives the
  // verify step a green baseline before any unit lands its own tests.
  writeFileSync(
    join(repo, "test", "sanity.test.js"),
    'const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("sanity", () => assert.equal(1 + 1, 2));\n',
  );
  git(repo, "add", "--all");
  git(repo, "commit", "-q", "-m", "chore: scaffold scratch repo");
  return repo;
}

interface Widget {
  phase: string;
  t1Done: boolean;
  t2Done: boolean;
}

function ctxFor(repo: string, state: WorkflowState) {
  const widgets: Widget[] = [];
  const notifies: string[] = [];
  const ctx = {
    cwd: repo,
    sessionManager: { getBranch: () => [{ type: "custom", customType: "workflow-state", data: state }] },
    ui: {
      notify: (msg: string) => notifies.push(msg),
      setStatus: () => {},
      setTitle: () => {},
      setWidget: (_key: string, lines?: string[]) => {
        if (!lines) {
          widgets.push({ phase: "idle", t1Done: false, t2Done: false });
          return;
        }
        const flat = lines.join("\n");
        widgets.push({
          phase: lines[0] ?? "",
          t1Done: /✓.*T1/.test(flat),
          t2Done: /✓.*T2/.test(flat),
        });
      },
      theme: { fg: (_c: string, t: string) => t },
      addAutocompleteProvider: () => {},
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets, notifies };
}

function piFor(repo: string): ExtensionAPI & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    calls[name] = [...(calls[name] ?? []), args];
  };
  return {
    on: record("on") as ExtensionAPI["on"],
    registerCommand: record("registerCommand") as ExtensionAPI["registerCommand"],
    registerTool: record("registerTool") as ExtensionAPI["registerTool"],
    appendEntry: record("appendEntry") as ExtensionAPI["appendEntry"],
    sendUserMessage: record("sendUserMessage") as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => ["read", "write", "edit", "bash"],
    getAllTools: () => [{ name: "commit_changes" }],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: execShim(repo),
    calls,
  } as unknown as ExtensionAPI & { calls: Record<string, unknown[]> };
}

function contract(): TaskContract {
  return {
    title: "Scratch feature",
    instruction: "Add greet and shout helpers",
    files: ["src/greet.js", "src/shout.js"],
    done: "npm test green",
    behaviors: [
      { id: "T1", description: "greet helper", expectedOutput: "greet() returns hello", kind: "test", status: "active" },
      { id: "T2", description: "shout helper", expectedOutput: "shout() returns HELLO", kind: "test", status: "active" },
    ],
  };
}

function finalizingState(task: TaskContract): WorkflowState {
  return { phase: "finalizing", specText: "scratch feature", task };
}

describe.skipIf(!RUN_LIVE)("orchestrator live smoke (M2)", () => {
  it(
    "default /implement lands one conventional commit per behavior with widget progression",
    { timeout: 120_000 },
    async () => {
      const repo = makeRepo();
      const state = finalizingState(contract());
      const { ctx, widgets, notifies } = ctxFor(repo, state);
      const pi = piFor(repo);

      const runner = async (unit: { behaviorId: string; taskText: string }) => {
        assert.match(unit.taskText, /Implement ONE behavior/);
        if (unit.behaviorId === "T1") {
          writeFileSync(join(repo, "src", "greet.js"), "exports.greet = () => 'hello';\n");
          writeFileSync(join(repo, "test", "t1.test.js"), T1_TEST);
          return { summary: "added greet helper + test", suggestedCommit: "feat: add greet helper" };
        }
        writeFileSync(join(repo, "src", "shout.js"), "exports.shout = () => 'HELLO';\n");
        writeFileSync(join(repo, "test", "t2.test.js"), T2_TEST);
        return { summary: "added shout helper + test", suggestedCommit: "feat: add shout helper" };
      };

      await runImplement("", pi, ctx, runner);
      const subjects = git(repo, "log", "--format=%s").split("\n");
      assert.deepEqual(
        subjects,
        ["feat: add shout helper", "feat: add greet helper", "chore: scaffold scratch repo"],
        "one conventional commit per behavior, newest first, no behavior ids",
      );
      for (const s of subjects.slice(0, 2)) {
        assert.doesNotMatch(s, /\bT[12]\b/, "commit subject must not carry the behavior id");
      }
      assert.equal(state.phase, "idle", "workflow returns to idle on completion");
      assert.ok(state.task!.behaviors.every((b) => b.status === "done"));
      assert.equal(state.lastTestResults!.failed, 0, "final verify is green");
      assert.ok(
        (state.lastTestResults!.passed ?? 0) >= 2,
        "final verify ran the behavior tests (sanity + 2 units)",
      );

      const progressed = widgets.filter((w) => w.t1Done && !w.t2Done);
      assert.ok(progressed.length >= 1, "widget shows T1 done while T2 still pending");
      const finalWidget = widgets.filter((w) => w.t1Done && w.t2Done);
      assert.ok(finalWidget.length >= 1, "widget shows both behaviors done before idle clear");
      assert.equal(git(repo, "status", "--short"), "", "tree is clean after the run");
    },
  );

  it(
    "failing unit retries once, halts with handoff, and /implement resumes from it",
    { timeout: 120_000 },
    async () => {
      const repo = makeRepo();
      const state = finalizingState(contract());
      const { ctx, notifies } = ctxFor(repo, state);
      const pi = piFor(repo);

      const spawns: string[] = [];
      const failingRunner = async (unit: { behaviorId: string }) => {
        spawns.push(unit.behaviorId);
        if (unit.behaviorId === "T1") {
          writeFileSync(join(repo, "src", "greet.js"), "exports.greet = () => 'hello';\n");
          writeFileSync(join(repo, "test", "t1.test.js"), T1_TEST);
          return { summary: "added greet helper + test", suggestedCommit: "feat: add greet helper" };
        }
        // Partial unit: file lands, then the unit blows up.
        writeFileSync(join(repo, "src", "shout.js"), "exports.shout = () => {\n");
        return { summary: "", error: "boom: cannot finish shout helper" };
      };

      await runImplement("", pi, ctx, failingRunner);
      assert.deepEqual(spawns, ["T1", "T2", "T2"], "T2 retried once, then the line stopped");
      assert.equal(state.phase, "implementing", "halt keeps the implementing phase");
      assert.equal(state.task!.behaviors[0]!.status, "done");
      assert.equal(state.task!.behaviors[1]!.status, "active");
      assert.deepEqual(
        git(repo, "log", "--format=%s").split("\n"),
        ["feat: add greet helper", "chore: scaffold scratch repo"],
        "only T1's commit landed before the halt",
      );

      const handoff = notifies[notifies.length - 1]!;
      assert.match(handoff, /T2/, "handoff names the failed unit");
      assert.match(handoff, /boom: cannot finish shout helper/, "handoff carries the error");
      assert.match(handoff, /feat: add greet helper/, "handoff lists commits landed so far");
      assert.match(handoff, /\/implement again to resume/, "handoff explains how to resume");
      assert.ok(
        /src\/shout\.js/.test(handoff) || /\(clean\)/.test(handoff),
        "handoff carries the real tree state",
      );

      // Resume: re-run /implement; only the remaining active unit spawns.
      const resumeSpawns: string[] = [];
      const fixingRunner = async (unit: { behaviorId: string }) => {
        resumeSpawns.push(unit.behaviorId);
        writeFileSync(join(repo, "src", "shout.js"), "exports.shout = () => 'HELLO';\n");
        writeFileSync(join(repo, "test", "t2.test.js"), T2_TEST);
        return { summary: "finished shout helper + test", suggestedCommit: "feat: add shout helper" };
      };

      await runImplement("", pi, ctx, fixingRunner);

      assert.deepEqual(resumeSpawns, ["T2"], "resume spawns only the first active behavior");
      assert.equal(state.phase, "idle", "resume completes the workflow");
      assert.ok(state.task!.behaviors.every((b) => b.status === "done"));
      assert.deepEqual(
        git(repo, "log", "--format=%s").split("\n"),
        ["feat: add shout helper", "feat: add greet helper", "chore: scaffold scratch repo"],
        "resume lands the second behavior's commit",
      );
      assert.equal(git(repo, "status", "--short"), "", "tree is clean after resume");
    },
  );
});
