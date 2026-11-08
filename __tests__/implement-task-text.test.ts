import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runImplement } from "../extensions/implement.ts";
import type { UnitRunner } from "../extensions/implement-loop.ts";
import { buildRetryTask, buildUnitTask } from "../extensions/unit-task-text.ts";
import type { WorkflowState, TaskContract, Behavior } from "../extensions/state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mockPi, ctxWithState, runOrchestratedViaSeam } from "./helpers/implement-harness.ts";

// ═══ buildUnitTask renders the D/M/A allowlist (T1) ═══
describe("buildUnitTask file rendering (T1)", () => {
  it("renders each declared file as 'path (STATUS)'", () => {
    const task: TaskContract = {
      title: "Allowlist Task",
      instruction: "do the thing",
      files: [
        { path: "src/a.ts", status: "M" },
        { path: "tests/a.test.ts", status: "A" },
        { path: "src/legacy.ts", status: "D" },
      ],
      done: "tests pass",
      behaviors: [
        { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
      ],
    };

    const text = buildUnitTask(task.behaviors[0]!, task);

    assert.match(text, /Files: src\/a\.ts \(M\), tests\/a\.test\.ts \(A\), src\/legacy\.ts \(D\)/);
    assert.match(text, /src\/a\.ts \(M\)/, "contract block carries the status too");
  });
});

// ═══ buildUnitTask verification line (T3) ═══
describe("buildUnitTask verification line (T3)", () => {
  const task: TaskContract = {
    title: "Verify Task",
    instruction: "do the thing",
    files: [{ path: "src/a.ts", status: "M" }],
    done: "tests pass",
    behaviors: [
      { id: "T1", description: "x", expectedOutput: "y", kind: "test", status: "active" },
    ],
  };

  it("suites present: tells the unit to call the test tool with the joined argv", () => {
    const text = buildUnitTask(task.behaviors[0]!, task, {
      testTool: {
        source: "detected",
        suites: [{ label: "javascript (npm run test)", argv: ["npm", "run", "test"] }],
      },
    });

    assert.match(text, /call the `test` tool \(runs: npm run test\)/);
    assert.match(text, /## Verification/, "the line lives under its own heading");
  });

  it("multiple suites are joined with '; '", () => {
    const text = buildUnitTask(task.behaviors[0]!, task, {
      testTool: {
        source: "config",
        suites: [
          { label: "config (npm run test:unit)", argv: ["npm", "run", "test:unit"] },
          { label: "make (make test)", argv: ["make", "test"] },
        ],
      },
    });

    assert.match(text, /call the `test` tool \(runs: npm run test:unit; make test\)/);
  });

  it("no suites + test kind: verification falls back to the pre-commit hook", () => {
    const text = buildUnitTask(task.behaviors[0]!, task, {
      testTool: { source: "none", suites: [] },
    });

    assert.match(text, /no test tool; verification is the pre-commit hook/);
  });

  it("testTool absent entirely: same pre-commit-hook fallback for test kind", () => {
    const text = buildUnitTask(task.behaviors[0]!, task);

    assert.match(text, /no test tool; verification is the pre-commit hook/);
  });

  it("no suites + manual kind: verification is by inspection", () => {
    const manual: Behavior = { ...task.behaviors[0]!, kind: "manual" };
    const text = buildUnitTask(manual, task, {
      testTool: { source: "none", suites: [] },
    });

    assert.match(text, /no test tool; verify by inspection/);
    assert.doesNotMatch(text, /pre-commit hook/, "manual behaviors never point at the hook");
  });
});

describe("buildRetryTask: timeout and missingReport branches", () => {
  function fixture(): {
    behavior: Parameters<typeof buildRetryTask>[0];
    task: TaskContract;
  } {
    const task: TaskContract = {
      title: "Header Task",
      instruction: "add a header",
      files: [{ path: "src/App.tsx", status: "M" }],
      done: "tests green",
      behaviors: [
        {
          id: "T5",
          description: "header renders",
          expectedOutput: "AppHeader shown",
          kind: "test",
          status: "active",
        },
      ],
    };
    return { behavior: task.behaviors[0]!, task };
  }

  it("timedOut prior renders the wall-clock branch: not a check failure, diff-first, report even if unverified", () => {
    const { behavior, task } = fixture();
    const prior = {
      summary: "investigating the uncaught exception",
      error:
        "timed out after 600000ms\n\n--- last assistant text ---\nchecking whether AppHeader causes the App.test.tsx uncaught exception",
      timedOut: true,
    };

    const text = buildRetryTask(behavior, task, prior, 1);

    assert.match(text, /wall.clock|time limit/i, "wall-clock wording present");
    assert.match(text, /infrastructure timeout, not a check failure/i, "classified as infrastructure");
    assert.match(text, /git status and git diff first|inspect .*diff first/i, "diff-first instruction");
    assert.match(text, /do NOT redo it from scratch/i, "no-redo instruction");
    assert.match(text, /fix exactly one blocking issue/i, "one-blocker instruction");
    assert.match(
      text,
      /emit the JSON report even if verification is incomplete/i,
      "report-even-if-unverified instruction",
    );
    assert.match(
      text,
      /checking whether AppHeader causes the App\.test\.tsx uncaught exception/,
      "context is the last assistant text",
    );
    assert.match(text, /Implement ONE behavior: T5\./, "original task text preserved");
  });

  it("missingReport prior renders the headless branch: no user mid-run, blockedCommands not prose", () => {
    const { behavior, task } = fixture();
    const prior = {
      summary: "Please run npx vitest run manually",
      error:
        "implementer ended without the required JSON report block (a prose handover plea is not a report).\n\n" +
        "--- final assistant text ---\nPlease run npx vitest run outside the sandbox for me.",
      missingReport: true,
    };

    const text = buildRetryTask(behavior, task, prior, 2);

    assert.match(text, /headless/i, "headless wording present");
    assert.match(text, /no user is available mid-run/i, "no-user statement present");
    assert.match(text, /blockedCommands/, "points at the structured channel");
    assert.match(text, /never as a prose request/i, "no-prose-plea rule present");
    assert.match(text, /Please run npx vitest run outside the sandbox for me\./, "prior message quoted");
    assert.match(text, /Implement ONE behavior: T5\./, "original task text preserved");
  });

  it("a plain failure prior keeps the default wording byte-compatible", () => {
    const { behavior, task } = fixture();
    const prior = { summary: "", error: "boom: cannot write file" };

    const text = buildRetryTask(behavior, task, prior, 3);

    assert.match(text, /^## Previous attempt failed \(retry 3\/5\)\nboom: cannot write file\n\n## Original task\n/);
  });
});

// ═══ engineer's note: orchestrated forwarding ═══
describe("engineer's note: orchestrated forwarding", () => {
  const NOTE = "use strict null checks";

  function noteTask(): TaskContract {
    return {
      title: "Note Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  /** Exec mock where git commit advances HEAD so the loop can land commits. */
  function piWithAdvancingHead() {
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

  it("forwards the note into every active unit's first-attempt task text", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: noteTask() };
    const ctx = ctxWithState(state);
    const taskTexts: string[] = [];

    const result = await runOrchestratedViaSeam(
      pi,
      ctx,
      async (unit) => {
        taskTexts.push(unit.taskText);
        return {
          summary: `implemented ${unit.behaviorId}`,
          suggestedCommit: `feat(core): add ${unit.behaviorId}`,
        };
      },
      NOTE,
    );

    assert.equal(result.complete, true, "the orchestrated run completes");
    assert.equal(taskTexts.length, 2, "one first-attempt task text per active behavior");
    for (const text of taskTexts) {
      assert.match(text, /## Engineer's note/, "note section heading present");
      assert.match(text, /use strict null checks/, "the note text is forwarded");
      assert.match(
        text,
        /do not implement beyond the contract/,
        "the guard sentence rides along",
      );
      assert.match(text, /tell the user to run \/finalize/, "the finalize guidance rides along");
    }
  });

  it("solo mode keeps its existing note section", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: noteTask() };
    const ctx = ctxWithState(state);

    await runImplement(`--solo ${NOTE} also wire the retries`, pi, ctx);

    const send = pi.calls["sendUserMessage"] ?? [];
    assert.equal(send.length, 1, "solo mode steers the in-session agent");
    const [text] = send[0] as [string];
    assert.match(text, /## Engineer's note/);
    assert.match(text, /use strict null checks/);
    assert.match(text, /do not implement beyond the contract/);
  });

  it("with no note, no unit task text carries an Engineer's note section", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: noteTask() };
    const ctx = ctxWithState(state);
    const taskTexts: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      taskTexts.push(unit.taskText);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId}`,
      };
    });

    assert.equal(result.complete, true, "the orchestrated run completes");
    assert.equal(taskTexts.length, 2, "one first-attempt task text per active behavior");
    for (const text of taskTexts) {
      assert.doesNotMatch(text, /## Engineer's note/, "no note section without a note");
    }
  });
});

// ═══ engineer's note: retry and fix task texts (T2) ═══
describe("engineer's note: retry and fix task texts", () => {
  const NOTE = "use strict null checks";

  /** Two-behavior contract; each behavior fails its first attempt. */
  function noteTask(): TaskContract {
    return {
      title: "Note Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  /** Exec mock where git commit advances HEAD so the loop can land commits. */
  function piWithAdvancingHead() {
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

  const HOOK_STDERR =
    ">>> Pre-commit hook failed\n" +
    "golangci-lint run failed\n" +
    "approve.go:42:1: unused variable \"x\"\n" +
    "exit status 1";

  /** Exec mock where the pre-commit hook always rejects (output varies per attempt, T4): HEAD never moves, tree dirty. */
  function piWithRejectingHook() {
    const pi = mockPi();
    let commitAttempts = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "headA\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "diff") {
        return { stdout: " src/a.ts | 2 +-\n", stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        commitAttempts++;
        return { stdout: "", stderr: `${HOOK_STDERR} (attempt ${commitAttempts})`, code: 1, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  /** Shared assertions: the note section rides along with its guard. */
  function assertNoteRetained(text: string, where: string) {
    assert.match(text, /## Engineer's note/, `${where}: note section heading present`);
    assert.match(text, /use strict null checks/, `${where}: the note text is retained`);
    assert.match(
      text,
      /do not implement beyond the contract/,
      `${where}: the guard sentence rides along`,
    );
    assert.match(text, /tell the user to run \/finalize/, `${where}: the finalize guidance rides along`);
  }

  it("retry task texts (unit error path) retain the note alongside the failure investigation", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: noteTask() };
    const ctx = ctxWithState(state);
    const spawns: Array<{ behaviorId: string; taskText: string }> = [];

    const result = await runOrchestratedViaSeam(
      pi,
      ctx,
      async (unit) => {
        spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
        // First attempt per behavior fails with a unit error; the retry succeeds.
        if (spawns.length % 2 === 1) {
          return { summary: "", error: `boom: ${unit.behaviorId} subprocess died` };
        }
        return {
          summary: `implemented ${unit.behaviorId}`,
          suggestedCommit: `feat(core): add ${unit.behaviorId}`,
        };
      },
      NOTE,
    );

    assert.equal(result.complete, true, "the orchestrated run completes after retries");
    assert.deepEqual(
      spawns.map((s) => `${s.behaviorId}#${s.taskText.includes("Previous attempt failed") ? "retry" : "first"}`),
      ["T1#first", "T1#retry", "T2#first", "T2#retry"],
      "each behavior gets a failing first attempt and one retry",
    );
    // The retry texts (buildRetryTask + noteSection) carry the failure
    // investigation AND the engineer's note.
    for (const spawn of [spawns[1]!, spawns[3]!]) {
      assertNoteRetained(spawn.taskText, `${spawn.behaviorId} retry`);
      assert.match(
        spawn.taskText,
        /## Previous attempt failed \(retry 1\/5\)/,
        "the retry keeps its failure section",
      );
      assert.match(spawn.taskText, /boom: /, "the prior error text is quoted");
      assert.match(spawn.taskText, /## Original task/, "the original task section is preserved");
    }
  });

  it("fix task texts (hook-rejected commits) retain the note alongside the investigation", async () => {
    const pi = piWithRejectingHook();
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: {
        title: "Hook Note Task",
        instruction: "do things",
        files: [{ path: "src/a.ts", status: "M" }],
        done: "all green",
        behaviors: [
          { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        ],
      },
    };
    const ctx = ctxWithState(state);
    const spawns: Array<{ behaviorId: string; taskText: string }> = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
      return { summary: `attempt ${spawns.length}`, suggestedCommit: "feat(core): add first behavior" };
    }, NOTE);

    assert.equal(result.complete, false, "persistent rejection halts the run");
    assert.equal(spawns.length, 1 + 5, "initial unit + exactly 5 fix subagents");
    // Every fix attempt (buildFixTask loop output) keeps the failure
    // investigation AND the engineer's note.
    for (const spawn of spawns.slice(1)) {
      assertNoteRetained(spawn.taskText, "fix attempt");
      assert.match(spawn.taskText, /Previous attempt failed \(retry \d\/5\)/, "fix keeps its retry header");
      assert.match(spawn.taskText, /Investigation: commit for T1 did not land/, "investigation present");
      assert.match(spawn.taskText, /Raw hook output/, "raw hook output section present");
      assert.match(spawn.taskText, /golangci-lint run failed/, "hook stderr quoted");
    }
  });
});

// ═══ engineer's note: halt/resume persistence (T3) ═══
describe("engineer's note: halt/resume persistence", () => {
  const NOTE = "use strict null checks";
  const NEW_NOTE = "also pin the commit subjects";
  const BLOCKED = "npx vitest run";

  /** Two-behavior contract; both behaviors active. */
  function noteTask(): TaskContract {
    return {
      title: "Note Task",
      instruction: "do things",
      files: [{ path: "src/a.ts", status: "M" }],
      done: "all green",
      behaviors: [
        { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        { id: "T2", description: "second behavior", expectedOutput: "e2", kind: "test", status: "active" },
      ],
    };
  }

  /** Exec mock where git commit advances HEAD so the loop can land commits. */
  function piWithAdvancingHead() {
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

  /**
   * Unit runner that pause-halts on its first spawn: a mustRunNow
   * sandbox-blocked command. Any later spawn is a test bug.
   */
  function haltingRunner(): UnitRunner {
    let spawns = 0;
    return async () => {
      spawns++;
      if (spawns === 1) {
        return {
          summary: "",
          blockedCommands: [
            { command: BLOCKED, reason: "sandbox blocks vitest", mustRunNow: true },
          ],
        };
      }
      return { summary: `unexpected extra spawn #${spawns}`, suggestedCommit: "feat(core): unreachable" };
    };
  }

  /** Successful unit runner that records each spawn's task text and note. */
  function succeedingRunner(state: WorkflowState, captures: Array<{ taskText: string; noteAtSpawn: unknown }>): UnitRunner {
    return async (unit) => {
      captures.push({ taskText: unit.taskText, noteAtSpawn: state.engineerNote });
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId}`,
      };
    };
  }

  it("a mustRunNow pause-halt persists engineerNote into workflow state", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: noteTask() };
    const ctx = ctxWithState(state);

    const result = await runOrchestratedViaSeam(pi, ctx, haltingRunner(), NOTE);

    assert.equal(result.complete, false, "the mustRunNow command halts the run");
    assert.equal(result.haltedOn, "T1", "the first behavior halted");
    assert.equal(state.phase, "implementing", "phase stays implementing so a re-run resumes");
    assert.equal(state.engineerNote, NOTE, "the note is persisted on the workflow state");
    assert.equal(state.lastHalt?.pendingCommand?.command, BLOCKED, "the pause handoff carries the command");
    const saves = (pi.calls["appendEntry"] ?? []) as Array<[string, WorkflowState]>;
    const lastSave = saves.filter(([type]) => type === "workflow-state").at(-1);
    assert.equal(lastSave?.[1].engineerNote, NOTE, "the persisted state entry contains the note");
  });

  it("a resume re-run without args reuses the note; completion clears it", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: noteTask() };
    const ctx = ctxWithState(state);

    // First run: halt with the note persisted.
    const halted = await runOrchestratedViaSeam(pi, ctx, haltingRunner(), NOTE);
    assert.equal(halted.complete, false, "the first run halts");
    assert.equal(state.engineerNote, NOTE, "the note survived the halt");

    // Resume: /implement with no args must reuse the persisted note.
    const captures: Array<{ taskText: string; noteAtSpawn: unknown }> = [];
    const resumed = await runOrchestratedViaSeam(pi, ctx, succeedingRunner(state, captures), "");

    assert.equal(resumed.complete, true, "the resumed run completes");
    assert.equal(captures.length, 2, "one first-attempt task text per active behavior");
    for (const capture of captures) {
      assert.match(capture.taskText, /## Engineer's note/, "the persisted note section is present");
      assert.match(capture.taskText, /use strict null checks/, "the persisted note text is reused");
      assert.match(capture.taskText, /do not implement beyond the contract/, "the guard sentence rides along");
    }
    assert.equal(state.phase, "idle", "completion switches the phase to idle");
    assert.equal(state.engineerNote, undefined, "completion clears the persisted note");
  });

  it("a different note on resume replaces the persisted one and is then cleared", async () => {
    const pi = piWithAdvancingHead();
    const state: WorkflowState = { phase: "finalizing", specText: "topic", task: noteTask() };
    const ctx = ctxWithState(state);

    // First run: halt with NOTE persisted.
    const halted = await runOrchestratedViaSeam(pi, ctx, haltingRunner(), NOTE);
    assert.equal(halted.complete, false, "the first run halts");
    assert.equal(state.engineerNote, NOTE, "the original note is persisted");

    // Resume with a different note: it replaces the persisted one.
    const captures: Array<{ taskText: string; noteAtSpawn: unknown }> = [];
    const resumed = await runOrchestratedViaSeam(pi, ctx, succeedingRunner(state, captures), NEW_NOTE);

    assert.equal(resumed.complete, true, "the resumed run completes");
    assert.ok(captures.length >= 2, "both behaviors ran");
    for (const capture of captures) {
      assert.equal(capture.noteAtSpawn, NEW_NOTE, "the loop ran with the replaced note");
      assert.match(capture.taskText, /## Engineer's note/, "the note section heading is present");
      assert.match(capture.taskText, /also pin the commit subjects/, "the new note text is used");
      assert.doesNotMatch(capture.taskText, /use strict null checks/, "the old note text is gone");
    }
    assert.equal(state.phase, "idle", "completion switches the phase to idle");
    assert.equal(state.engineerNote, undefined, "completion clears the replaced note too");
  });
});
