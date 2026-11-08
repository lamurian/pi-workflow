import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  composeCompletionReport,
  composeHaltReport,
} from "../extensions/implement-report.ts";
import {
  runOrchestratedImplement,
  type OrchestratorResult,
} from "../extensions/implement-loop.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockPi, ctxWithState, finalizingState } from "./helpers/implement-harness.ts";

// ═══ T5: staged-diff guard halts the loop before commit ═══
describe("T5: staged-diff guard halts the loop before commit", () => {
  function guardTask(): TaskContract {
    return {
      title: "Guard Task",
      instruction: "do things",
      // The test-kind sourceFile is declared D so the contract allowlist stays
      // clean and the staged-diff guard's sourceFile-deletion rule is what
      // trips (undeclared paths now halt earlier as contract-guard).
      files: [
        { path: "src/a.ts", status: "M" },
        { path: "tests/a.test.ts", status: "D" },
      ],
      done: "all green",
      behaviors: [
        {
          id: "T1",
          description: "first behavior",
          expectedOutput: "e1",
          kind: "test",
          status: "active",
          sourceFile: "tests/a.test.ts",
        },
      ],
    };
  }

  interface ExecLogEntry { cmd: string; args: string[] }

  /** Exec mock: add succeeds; staged diff shows an undeclared test deletion. */
  function piWithTamperDiff(): {
    pi: ExtensionAPI & { calls: Record<string, unknown[]> };
    execLog: ExecLogEntry[];
  } {
    const pi = mockPi();
    const execLog: ExecLogEntry[] = [];
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "add") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--name-status")) {
        return { stdout: "D\ttests/a.test.ts\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff") {
        return {
          stdout:
            "diff --git a/tests/a.test.ts b/tests/a.test.ts\n" +
            "--- a/tests/a.test.ts\n+++ b/tests/a.test.ts\n" +
            "@@ -1,2 +0,0 @@\n" +
            "-func TestOld(t *testing.T) { assert.True(t, true) }\n",
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (cmd === "git" && args[0] === "commit") {
        throw new Error("git commit must never run when the guard trips");
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  it("halts immediately on test-guard: no commit, no fix subagent, lastHalt carries lines + guidance", async () => {
    const { pi, execLog } = piWithTamperDiff();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: guardTask() };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedImplement(
      pi,
      ctx,
      state,
      state.task!,
      async (unit) => {
        spawns.push(unit.behaviorId);
        return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat(core): add first behavior" };
      },
    );

    assert.equal(spawns.length, 1, "only the base unit runs — no fix subagent on test-guard");
    assert.ok(
      !execLog.some((e) => e.cmd === "git" && e.args[0] === "commit"),
      "git commit must never be invoked when the guard trips",
    );
    assert.equal(result.complete, false);
    assert.equal(result.haltedOn, "T1");
    assert.match(result.error ?? "", /test-guard|Staged-diff guard/i);
    assert.ok(state.lastHalt, "halt persists lastHalt");
    assert.equal(state.lastHalt!.behaviorId, "T1");
    assert.match(state.lastHalt!.error, /D\ttests\/a\.test\.ts/, "lastHalt carries the name-status lines");
    assert.match(state.lastHalt!.error, /re-declare/, "lastHalt carries re-declare guidance");
    assert.match(state.lastHalt!.error, /\/finalize/, "lastHalt names the /discuss -> /finalize path");
  });

  it("clean staged diff: staged diff inspected between add and commit, commit lands once", async () => {
    const pi = mockPi();
    const execLog: ExecLogEntry[] = [];
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "add") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: guardTask() };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedImplement(
      pi,
      ctx,
      state,
      state.task!,
      async (unit) => {
        spawns.push(unit.behaviorId);
        return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat(core): add first behavior" };
      },
    );

    assert.equal(result.complete, true, "clean staged diff lands the commit");
    assert.equal(state.task!.behaviors[0].status, "done");
    // Exclude the T6 progress fingerprint's `git diff --stat` queries: the
    // guard must run the staged diff between add and commit.
    const gitCommands = execLog
      .filter((e) => !(e.cmd === "git" && e.args[0] === "diff" && e.args.includes("--stat")))
      .map((e) => (e.cmd === "git" ? e.args[0] : e.cmd));
    const addIdx = gitCommands.indexOf("add");
    const diffIdx = gitCommands.indexOf("diff");
    const commitIdx = gitCommands.indexOf("commit");
    assert.ok(addIdx !== -1 && diffIdx !== -1 && commitIdx !== -1, "add, diff, commit all run");
    assert.ok(addIdx < diffIdx && diffIdx < commitIdx, "staged diff inspected between add and commit");
  });
});

// ═══ T1: the default unit runner threads the session model into the child argv ═══
describe("T1: session model reaches the spawned implementer unit", () => {
  it("runOrchestratedImplement without an injected runner spawns the unit with --model <provider>/<id>", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-model-ref-"));
    const argvFile = join(dir, "argv.txt");
    const reportFile = join(dir, "report.jsonl");
    const fake = join(dir, "fake-pi.sh");
    const reportText =
      'done.\n```json\n{"summary": "implemented", "suggestedCommit": "feat(x): done"}\n```';
    writeFileSync(
      reportFile,
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: reportText }] },
      }) + "\n",
    );
    // Fake pi: record the argv it received, answer prompts with the report,
    // exit on the graceful abort the runner sends after the report.
    writeFileSync(
      fake,
      "#!/bin/sh\n" +
        'printf "%s\\n" "$@" > "$PI_ARGV_FILE"\n' +
        "while IFS= read -r line; do\n" +
        "  case \"$line\" in\n" +
        "    *'\"type\":\"prompt\"'*) cat \"$PI_REPORT_FILE\" ;;\n" +
        "    *'\"type\":\"abort\"'*) exit 0 ;;\n" +
        "  esac\n" +
        "done\nexit 0\n",
    );
    chmodSync(fake, 0o755);

    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: {
        title: "Model Ref Task",
        instruction: "thread the session model",
        files: [{ path: "src/a.ts", status: "M" }],
        done: "all green",
        behaviors: [
          {
            id: "T1",
            description: "spawn with the session model",
            expectedOutput: "e1",
            kind: "test",
            status: "active",
          },
        ],
      },
    };
    const ctx = {
      ...ctxWithState(state),
      cwd: dir,
      model: { provider: "opencode-go", id: "mimo-v2.6-flash" },
    } as unknown as ExtensionContext;

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

    const prev = {
      PI_BIN: process.env.PI_BIN,
      PI_ARGV_FILE: process.env.PI_ARGV_FILE,
      PI_REPORT_FILE: process.env.PI_REPORT_FILE,
    };
    process.env.PI_BIN = fake;
    process.env.PI_ARGV_FILE = argvFile;
    process.env.PI_REPORT_FILE = reportFile;
    try {
      const result = await runOrchestratedImplement(pi, ctx, state, state.task!);
      assert.equal(result.complete, true, `default-runner run must complete (error: ${result.error})`);
    } finally {
      for (const key of ["PI_BIN", "PI_ARGV_FILE", "PI_REPORT_FILE"] as const) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }

    const argv = readFileSync(argvFile, "utf8").split("\n");
    const idx = argv.indexOf("--model");
    assert.notEqual(idx, -1, "the spawned unit must receive --model");
    assert.equal(
      argv[idx + 1],
      "opencode-go/mimo-v2.6-flash",
      "the ref is the session model as provider/id",
    );
    assert.ok(!argv.includes("--provider"), "a single provider/id reference suffices");
  });
});

// ═══ T2: the default unit runner threads the escalation floor into --thinking ═══
describe("T2: escalation floor reaches the spawned child argv", () => {
  it("createDefaultUnitRunner spawns the child with --thinking <floor> when the unit carries one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-thinking-floor-"));
    const argvFile = join(dir, "argv.txt");
    const reportFile = join(dir, "report.jsonl");
    const fake = join(dir, "fake-pi.sh");
    const reportText =
      'done.\n```json\n{"summary": "implemented", "suggestedCommit": "feat(x): done"}\n```';
    writeFileSync(
      reportFile,
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: reportText }] },
      }) + "\n",
    );
    // Fake pi: record the argv it received, answer prompts with the report,
    // exit on the graceful abort the runner sends after the report.
    writeFileSync(
      fake,
      "#!/bin/sh\n" +
        'printf "%s\\n" "$@" > "$PI_ARGV_FILE"\n' +
        "while IFS= read -r line; do\n" +
        "  case \"$line\" in\n" +
        "    *'\"type\":\"prompt\"'*) cat \"$PI_REPORT_FILE\" ;;\n" +
        "    *'\"type\":\"abort\"'*) exit 0 ;;\n" +
        "  esac\n" +
        "done\nexit 0\n",
    );
    chmodSync(fake, 0o755);

    const state = finalizingState();
    const pi = mockPi();
    const prev = {
      PI_BIN: process.env.PI_BIN,
      PI_ARGV_FILE: process.env.PI_ARGV_FILE,
      PI_REPORT_FILE: process.env.PI_REPORT_FILE,
    };
    process.env.PI_BIN = fake;
    process.env.PI_ARGV_FILE = argvFile;
    process.env.PI_REPORT_FILE = reportFile;
    try {
      const { createDefaultUnitRunner } = await import("../extensions/unit-runner-default.ts");
      const runner = createDefaultUnitRunner(pi, state, state.task!);
      const report = await runner(
        { behaviorId: "T1", taskText: "do the thing", thinking: "medium" },
        dir,
        undefined,
        () => {},
      );
      try {
        assert.equal(report.error, undefined, `the fake child must complete (error: ${report.error})`);
        assert.equal(report.summary, "implemented");
      } finally {
        await report.client?.shutdown();
      }
    } finally {
      for (const key of ["PI_BIN", "PI_ARGV_FILE", "PI_REPORT_FILE"] as const) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }

    const argv = readFileSync(argvFile, "utf8").split("\n");
    const idx = argv.indexOf("--thinking");
    assert.notEqual(idx, -1, "the spawned child receives --thinking");
    assert.equal(argv[idx + 1], "medium", "the unit's escalation floor reaches the child argv");
    assert.notEqual(argv[idx + 1], "minimal", "the old minimal pin is gone");
  });
});

describe("blockedCommands: mustRunNow pause-halt", () => {
  function twoBehaviorTask(): TaskContract {
    return {
      title: "Code Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  function execRecordingPi(): {
    pi: ExtensionAPI & { calls: Record<string, unknown[]> };
    execLog: Array<{ cmd: string; args: string[] }>;
  } {
    const pi = mockPi();
    const execLog: Array<{ cmd: string; args: string[] }> = [];
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  it("a mustRunNow report halts immediately: no commit, behavior stays active, pendingCommand persisted", async () => {
    const { pi, execLog } = execRecordingPi();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: twoBehaviorTask() };
    const ctx = ctxWithState(state);
    let spawns = 0;

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async () => {
      spawns++;
      return {
        summary: "implemented but blocked on a sandbox command",
        suggestedCommit: "feat(core): add first behavior",
        blockedCommands: [
          { command: "cd src && npx vitest run", reason: "sandbox blocks cd chaining", mustRunNow: true },
        ],
      };
    });

    assert.equal(result.complete, false, "a mustRunNow halt is not a completion");
    assert.equal(result.haltedOn, "T1", "halts on the blocked behavior");
    assert.equal(spawns, 1, "no retry spawn after a mustRunNow halt");
    assert.equal(result.unitsRun, 1, "no retry-budget consumption");
    assert.ok(
      !execLog.some((e) => e.cmd === "git" && e.args[0] === "commit"),
      "no commit attempt for a mustRunNow halt",
    );
    assert.equal(state.task!.behaviors[0]!.status, "active", "behavior stays active for resume");
    assert.equal(state.task!.behaviors[1]!.status, "active", "later behaviors untouched");
    assert.deepEqual(
      state.lastHalt?.pendingCommand,
      { command: "cd src && npx vitest run", reason: "sandbox blocks cd chaining" },
      "pendingCommand persisted on lastHalt",
    );
    assert.equal(result.pendingCommand?.command, "cd src && npx vitest run");
  });

  it("a unit report without blockedCommands never sets pendingCommand", async () => {
    const { pi } = execRecordingPi();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: twoBehaviorTask() };
    const ctx = ctxWithState(state);

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => ({
      summary: `implemented ${unit.behaviorId}`,
      suggestedCommit: `feat(core): add ${unit.behaviorId}`,
    }));

    assert.equal(result.complete, true);
    assert.equal(result.pendingCommand, undefined, "no pendingCommand without blockedCommands");
    assert.equal(state.lastHalt, undefined);
  });

  it("composeHaltReport renders an Action required section naming the pending command, before the resume line", () => {
    const result: OrchestratorResult = {
      complete: false,
      unitsRun: 1,
      landedCommits: [],
      haltedOn: "T5",
      error: "unit reported a sandbox-blocked command that must run now",
      treeState: " M src/a.ts",
      pendingCommand: {
        command: "cd src && npx vitest run App.test.tsx",
        reason: "sandbox blocks cd chaining",
      },
    };

    const report = composeHaltReport(result);

    assert.match(report, /Action required/, "action section present");
    assert.match(report, /cd src && npx vitest run App\.test\.tsx/, "the command is named verbatim");
    assert.match(report, /sandbox blocks cd chaining/, "the reason is carried");
    assert.match(report, /run \/implement again to resume/i, "resume instruction present");
    assert.ok(
      report.indexOf("Action required") < report.indexOf("Resume:"),
      "action section precedes the resume line",
    );
  });
});

describe("blockedCommands: deferrable collection", () => {
  function twoBehaviorTask(): TaskContract {
    return {
      title: "Code Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  function execRecordingPi(): {
    pi: ExtensionAPI & { calls: Record<string, unknown[]> };
    execLog: Array<{ cmd: string; args: string[] }>;
  } {
    const pi = mockPi();
    const execLog: Array<{ cmd: string; args: string[] }> = [];
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  it("lands the commit and collects deferrable entries into deferredCommands", async () => {
    const { pi } = execRecordingPi();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: twoBehaviorTask() };
    const ctx = ctxWithState(state);
    const deferrable = [
      { command: "npx prettier --check src", reason: "sandbox blocks write to cache", mustRunNow: false },
    ];

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) =>
      unit.behaviorId === "T1"
        ? {
            summary: "implemented, one check deferred",
            suggestedCommit: "feat(core): add first behavior",
            blockedCommands: deferrable,
          }
        : {
            summary: "implemented T2",
            suggestedCommit: "feat(core): add second behavior",
          },
    );

    assert.equal(result.complete, true, "deferrable entries never block landing");
    assert.deepEqual(state.task!.behaviors.map((b) => b.status), ["done", "done"]);
    assert.deepEqual(result.deferredCommands, deferrable, "deferrable entries are collected");
    assert.equal(result.pendingCommand, undefined, "deferrable entries never pause-halt");
  });

  it("a unit report without blockedCommands yields empty deferredCommands", async () => {
    const { pi } = execRecordingPi();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: twoBehaviorTask() };
    const ctx = ctxWithState(state);

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => ({
      summary: `implemented ${unit.behaviorId}`,
      suggestedCommit: `feat(core): add ${unit.behaviorId}`,
    }));

    assert.equal(result.complete, true);
    assert.deepEqual(result.deferredCommands, [], "no blockedCommands yields an empty list");
  });

  it("composeCompletionReport lists deferred commands with run-outside-sandbox guidance", () => {
    const task = twoBehaviorTask();
    task.behaviors.forEach((b) => (b.status = "done"));
    const result: OrchestratorResult = {
      complete: true,
      unitsRun: 2,
      landedCommits: ["feat(core): add first behavior"],
      deferredCommands: [
        { command: "npx prettier --check src", reason: "sandbox blocks cache write", mustRunNow: false },
      ],
    };

    const report = composeCompletionReport(result, task);

    assert.match(report, /Deferred commands/i, "deferred section present");
    assert.match(report, /npx prettier --check src/, "the deferred command is named verbatim");
    assert.match(report, /outside the sandbox/i, "run-outside-sandbox guidance present");
    assert.match(report, /sandbox blocks cache write/, "the reason is carried");
  });
});

describe("blockedCommands: resume assumes the pending command was run", () => {
  function twoBehaviorTask(): TaskContract {
    return {
      title: "Code Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  function execRecordingPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
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

  it("splices the assumed-run note into the pending behavior's task only, then clears pendingCommand", async () => {
    const pi = execRecordingPi();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: twoBehaviorTask(),
      lastHalt: {
        behaviorId: "T2",
        error: "Unit T2 reported a sandbox-blocked command that must run now: cd src && npx vitest run",
        at: new Date().toISOString(),
        pendingCommand: { command: "cd src && npx vitest run", reason: "sandbox blocks cd chaining" },
      },
    };
    const ctx = ctxWithState(state);
    const taskTexts: Record<string, string> = {};

    const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
      taskTexts[unit.behaviorId] = unit.taskText;
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId}`,
      };
    });

    assert.equal(result.complete, true, "resume run completes");
    const pendingText = taskTexts["T2"]!;
    assert.match(pendingText, /Previously blocked command/, "section header present");
    assert.match(pendingText, /cd src && npx vitest run/, "the command is named verbatim");
    assert.match(pendingText, /assumed run|Assume it has been executed/, "assumed-run wording");
    assert.match(pendingText, /Do NOT attempt to run it yourself/, "no-attempt instruction");
    assert.match(pendingText, /verify its effects by other means/i, "verify-by-other-means instruction");
    assert.match(pendingText, /report .*if .*effects.*missing|If its effects are missing/i, "re-report instruction");
    assert.ok(!/Previously blocked command/.test(taskTexts["T1"]!), "T1 must not inherit the note");
    assert.equal(state.lastHalt?.pendingCommand, undefined, "pendingCommand cleared after splice");
  });

  it("a resume without pendingCommand splices no note", async () => {
    const pi = execRecordingPi();
    const state: WorkflowState = {
      phase: "implementing",
      specText: "topic",
      task: twoBehaviorTask(),
      lastHalt: {
        behaviorId: "T2",
        error: "pre-commit hook rejected the commit for T2 after 5 retries",
        at: new Date().toISOString(),
      },
    };
    const ctx = ctxWithState(state);
    const taskTexts: Record<string, string> = {};

    await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
      taskTexts[unit.behaviorId] = unit.taskText;
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId}`,
      };
    });

    assert.ok(!/Previously blocked command/.test(taskTexts["T1"]!));
    assert.ok(!/Previously blocked command/.test(taskTexts["T2"]!));
  });
});
