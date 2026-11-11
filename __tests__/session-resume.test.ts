// T3 — behavior resume sessions: the default unit runner forwards
// unit.session to the child argv, every attempt of a behavior carries the
// same deterministic session id, and follow-up prompts drop the base task
// text once the behavior's transcript exists on disk.

import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runOrchestratedImplement, type UnitAttempt, type UnitRunner } from "../extensions/implement-loop.ts";
import type { WorkflowState, TaskContract } from "../extensions/state.ts";
import type { UnitTask } from "../extensions/implementer-runner.ts";
import { mockPi, finalizingState } from "./helpers/implement-harness.ts";

/** Task baseline head; the resume session id embeds its first 8 chars. */
const BASELINE = "abcdef1234567890";
/** Expected resume session id: `<behaviorId>-<baselineHead first 8 chars>`. */
const SESSION_ID = "T1-abcdef12";
/** Marker string that appears only inside the rendered base task text. */
const BASE_MARKER = "unmistakable base task marker";

/** Behavior/task contract whose T1 description carries the base-text marker. */
function resumeTask(): TaskContract {
  return {
    title: "Resume Task",
    instruction: "do things",
    files: [{ path: "src/a.ts", status: "M" }],
    done: "all green",
    behaviors: [
      { id: "T1", description: BASE_MARKER, expectedOutput: "e1", kind: "test", status: "active" },
    ],
  };
}

/** Finalizing state with the baseline head that keys the resume session. */
function resumeState(): WorkflowState {
  return { phase: "finalizing", specText: "topic", baselineHead: BASELINE, task: resumeTask() };
}

/** Mock context rooted at a temp cwd (the session dir lives under it). */
function ctxAt(state: WorkflowState, cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "workflow-state", data: state }],
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

/** Mock API whose git exec answers rev-parse/commit and logs commits. */
function piHarness() {
  const pi = mockPi();
  let headCounter = 0;
  const commits: string[] = [];
  pi.exec = (async (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "commit") {
      headCounter++;
      commits.push(args.join(" "));
      return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  }) as ExtensionAPI["exec"];
  return { pi, commits };
}

/**
 * Runner recording every spawned unit and replaying a scripted outcome per
 * spawn index: partial-with-findings, partial-without-progress, success.
 */
function scriptedRunner(spawns: UnitTask[]): UnitRunner {
  const steps: Array<() => UnitAttempt> = [
    () => ({
      summary: "explored the codebase",
      status: "partial",
      nextSteps: "keep going",
      findings: ["fact: explored the parser"],
    }),
    () => ({
      summary: "could not make progress",
      status: "partial",
      nextSteps: "nothing new to try",
    }),
    () => ({ summary: "implemented T1", suggestedCommit: "feat(core): add behavior" }),
  ];
  return async (unit) => {
    spawns.push(unit);
    return steps[spawns.length - 1]!();
  };
}

/** Run one base→continuation→retry→success sequence in a fresh temp repo. */
async function runSequence(spawns: UnitTask[], cwd: string) {
  const { pi, commits } = piHarness();
  const state = resumeState();
  const ctx = ctxAt(state, cwd);
  const result = await runOrchestratedImplement(pi, ctx, state, state.task!, scriptedRunner(spawns));
  return { result, state, commits };
}

describe("T3: default unit runner forwards unit.session to the child argv", () => {
  it("the default unit runner spawns the child with the session args built from unit.session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-session-resume-"));
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
    // Fake pi: record argv, answer prompts with the report, exit on abort.
    writeFileSync(
      fake,
      "#!/bin/sh\n" +
        'printf "%s\\n" "$@" > "$PI_ARGV_FILE"\n' +
        "while IFS= read -r line; do\n" +
        "  case \"$line\" in\n" +
        `    *'"type":"prompt"'*) cat "$PI_REPORT_FILE" ;;\n` +
        `    *'"type":"abort"'*) exit 0 ;;\n` +
        "  esac\n" +
        "done\nexit 0\n",
    );
    chmodSync(fake, 0o755);

    const state = finalizingState();
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
      const runner = createDefaultUnitRunner(mockPi(), state, state.task!);
      const sessionDir = join(dir, ".pi", "workflow", "sessions");
      const report = await runner(
        { behaviorId: "T1", taskText: "do the thing", session: { dir: sessionDir, id: SESSION_ID } },
        dir,
        undefined,
        () => {},
      );
      try {
        expect(report.error, `the fake child must complete (error: ${report.error})`).toBeUndefined();
        const argv = readFileSync(argvFile, "utf8").split("\n");
        const dirIdx = argv.indexOf("--session-dir");
        const idIdx = argv.indexOf("--session-id");
        expect(dirIdx, "--session-dir must reach the child argv").not.toBe(-1);
        expect(argv[dirIdx + 1]).toBe(sessionDir);
        expect(idIdx, "--session-id must reach the child argv").not.toBe(-1);
        expect(argv[idIdx + 1]).toBe(SESSION_ID);
        expect(argv, "a session spec replaces --no-session").not.toContain("--no-session");
      } finally {
        await report.client?.shutdown();
      }
    } finally {
      for (const key of ["PI_BIN", "PI_ARGV_FILE", "PI_REPORT_FILE"] as const) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  }, 60_000);
});

describe("T3: every attempt of a behavior carries the same resume session", () => {
  it("base attempt, continuation and retry all carry session id <behaviorId>-<baselineHead first 8 chars>", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-session-loop-"));
    const spawns: UnitTask[] = [];
    const { result } = await runSequence(spawns, cwd);

    expect(result.complete, `run must complete (error: ${result.error})`).toBe(true);
    expect(spawns.length, "base attempt, one continuation, one retry").toBe(3);
    const expectedDir = join(cwd, ".pi", "workflow", "sessions");
    for (const [i, spawn] of spawns.entries()) {
      expect(spawn.session, `spawn ${i} must carry the resume session`).toBeDefined();
      expect(spawn.session!.id, `spawn ${i} session id`).toBe(SESSION_ID);
      expect(spawn.session!.dir, `spawn ${i} session dir`).toBe(expectedDir);
    }
  }, 60_000);

  it("a missing transcript keeps the full base task text in continuation and retry", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-session-missing-"));
    const spawns: UnitTask[] = [];
    const { result } = await runSequence(spawns, cwd);

    expect(result.complete, `run must complete (error: ${result.error})`).toBe(true);
    expect(spawns.length).toBe(3);
    const continuation = spawns[1]!.taskText;
    expect(continuation, "continuation heading").toMatch(/## Continue previous partial attempt/);
    expect(continuation, "continuation keeps ### Original task + base text").toContain(
      "### Original task",
    );
    expect(continuation, "continuation keeps the full base task text").toContain(BASE_MARKER);
    const retry = spawns[2]!.taskText;
    expect(retry, "retry heading").toMatch(/Previous attempt failed \(retry 1\/5\)/);
    expect(retry, "retry keeps ## Original task + base text").toContain("## Original task");
    expect(retry, "retry keeps the full base task text").toContain(BASE_MARKER);
  }, 60_000);

  it("an existing transcript omits the base task text from continuation and retry", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-session-exists-"));
    // The behavior's transcript is already on disk (suffix `_<sessionId>.jsonl`).
    const sessions = join(cwd, ".pi", "workflow", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `prev_${SESSION_ID}.jsonl`), "");

    const spawns: UnitTask[] = [];
    const { result } = await runSequence(spawns, cwd);

    expect(result.complete, `run must complete (error: ${result.error})`).toBe(true);
    expect(spawns.length).toBe(3);
    // The base attempt always carries the full base task text.
    expect(spawns[0]!.taskText, "base attempt keeps the base task text").toContain(BASE_MARKER);
    expect(spawns[1]!.taskText, "continuation omits the base task text").not.toContain(BASE_MARKER);
    expect(spawns[2]!.taskText, "retry omits the base task text").not.toContain(BASE_MARKER);
  }, 60_000);
});
