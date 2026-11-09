import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { registerCompleteImplementationTool } from "../extensions/implement-tools.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mockPi,
  ctxWithState,
  finalizingState,
  getTool,
  runOrchestratedViaSeam,
} from "./helpers/implement-harness.ts";

// ═══ T7: orchestrator final gate — triage, one FULL-GATE fix round, halts ═══
describe("T7: orchestrator final gate", () => {
  const JS_SUITE = { label: "javascript (npm run test)", argv: ["npm", "run", "test"] };

  /** Finalizing state: one active behavior, recorded suites, v2 refs for triage owners. */
  function finalGateState(): WorkflowState {
    return {
      phase: "finalizing",
      specText: "topic",
      testTool: { source: "detected", suites: [JS_SUITE] },
      contractV2: {
        title: "Final Gate Task",
        instruction: "do things",
        done: "all green",
        sources: [{ path: "src/a.ts", tasks: ["T1"] }],
        tests: [{ path: "__tests__/a.test.ts", status: "M", tasks: ["T1"] }],
        tasks: [
          { id: "T1", description: "first behavior", expectedOutput: ["e1"], status: "active" },
        ],
      },
      task: {
        title: "Final Gate Task",
        instruction: "do things",
        files: [
          { path: "src/a.ts", status: "M" },
          { path: "__tests__/a.test.ts", status: "M" },
        ],
        done: "all green",
        behaviors: [
          { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        ],
      },
    };
  }

  type NpmResult = { code: number; stdout: string; stderr: string };

  /**
   * Exec mock: git commits advance HEAD; every npm call shifts the next
   * queued result (scope-gate runs included), defaulting to green.
   * R2a: each red final-gate suite re-runs once in-gate, so every red
   * entry must be listed twice (the run and its in-gate retry).
   */
  function piWithNpmQueue(results: NpmResult[]) {
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
      if (cmd === "npm") {
        const next = results.shift() ?? { code: 0, stdout: "ok", stderr: "" };
        return { ...next, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  const GREEN: NpmResult = { code: 0, stdout: "ok", stderr: "" };
  /** Red suite whose only failing test is declared with owner T1. */
  const RED_DECLARED: NpmResult = {
    code: 1,
    stdout: "",
    stderr: "FAIL  __tests__/a.test.ts > suite > test",
  };

  it("a green final gate after the completion gate completes the run and returns the workflow to idle", async () => {
    const { pi, execLog } = piWithNpmQueue([GREEN]);
    const state = finalGateState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: "feat(core): add first behavior",
      };
    });

    assert.equal(result.complete, true, result.error ?? "");
    assert.equal(state.phase, "idle", "a green final gate returns the workflow to idle");
    assert.equal(state.finalGate?.passed, true, "the final-gate result is persisted");
    assert.deepEqual(spawns, ["T1"], "no fix unit runs on a green final gate");
    const npmRuns = execLog.filter((e) => e.cmd === "npm");
    assert.equal(npmRuns.length, 2, "scope gate + final gate each run the suite once");
    const lastCommit = execLog.findLastIndex((e) => e.cmd === "git" && e.args[0] === "commit");
    assert.ok(
      execLog.indexOf(npmRuns[1]!) > lastCommit,
      "the final gate runs after the completion gate passes (last commit landed)",
    );
  });

  it("runs the final gate on resume when every task is already done", async () => {
    const { pi, execLog } = piWithNpmQueue([GREEN]);
    const state = finalGateState();
    state.phase = "implementing";
    state.task!.behaviors[0]!.status = "done";
    state.contractV2!.tasks[0]!.status = "done";
    const ctx = ctxWithState(state);
    let spawned = 0;

    const result = await runOrchestratedViaSeam(pi, ctx, async () => {
      spawned++;
      return { summary: "x", suggestedCommit: "feat: x" };
    });

    assert.equal(spawned, 0, "the all-done resume path spawns no unit");
    assert.equal(result.complete, true, result.error ?? "");
    assert.equal(state.phase, "idle");
    assert.equal(state.finalGate?.passed, true, "the final gate still ran on the resume path");
    assert.equal(
      execLog.filter((e) => e.cmd === "npm").length,
      1,
      "the resume path runs the recorded suites through the final gate",
    );
  });

  it("runs exactly one FULL-GATE fix unit with tails, landed commits and failing-test owners, commits its work and re-runs the gate", async () => {
    const { pi, execLog } = piWithNpmQueue([GREEN, RED_DECLARED, RED_DECLARED, GREEN]);
    const state = finalGateState();
    const ctx = ctxWithState(state);
    const units: Array<{ id: string; taskText: string }> = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      units.push({ id: unit.behaviorId, taskText: unit.taskText });
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit:
          unit.behaviorId === "FULL-GATE"
            ? "fix(final): repair the failing test"
            : "feat(core): add first behavior",
      };
    });

    assert.equal(result.complete, true, result.error ?? "");
    assert.deepEqual(
      units.map((u) => u.id),
      ["T1", "FULL-GATE"],
      "exactly one FULL-GATE fix unit runs when every failing test is declared",
    );
    const fix = units[1]!;
    assert.match(fix.taskText, /## Failing tests \(with owning tasks\)/, "the failing tests section");
    assert.match(
      fix.taskText,
      /__tests__\/a\.test\.ts — declared \(owners: T1\)/,
      "failing tests are mapped to their owning tasks",
    );
    assert.match(
      fix.taskText,
      /feat\(core\): add first behavior/,
      "the landed commit subjects ride the fix task text",
    );
    assert.match(
      fix.taskText,
      /FAIL  __tests__\/a\.test\.ts > suite > test/,
      "the red suite tail rides the fix task text",
    );
    const commits = execLog.filter((e) => e.cmd === "git" && e.args[0] === "commit");
    assert.equal(commits.length, 2, "the fix unit's work is committed through the commit gate");
    assert.deepEqual(
      commits[0]!.args,
      ["commit", "-m", "feat(core): add first behavior", "--signoff"],
      "the orchestrator commit runs through the core (signed off)",
    );
    assert.deepEqual(
      commits[1]!.args,
      ["commit", "-m", "fix: restore green test suite", "--signoff"],
      "the FULL-GATE fix commit lands with the fixed subject (T3)",
    );
    assert.equal(
      execLog.filter((e) => e.cmd === "npm").length,
      4,
      "scope gate, red final gate run + its in-gate retry, then the post-fix re-run final gate",
    );
    assert.equal(state.finalGate?.passed, true, "the re-run final gate is green");
    assert.equal(state.phase, "idle");
  });

  it("halts with the full-gate report when the final gate stays red after the fix round", async () => {
    const { pi, execLog } = piWithNpmQueue([
      GREEN,
      RED_DECLARED,
      RED_DECLARED,
      RED_DECLARED,
      RED_DECLARED,
    ]);
    const state = finalGateState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit:
          unit.behaviorId === "FULL-GATE"
            ? "fix(final): repair the failing test"
            : "feat(core): add first behavior",
      };
    });

    assert.equal(result.complete, false, "a red gate after the fix round halts the run");
    assert.equal(result.haltedOn, "FULL-GATE");
    assert.match(result.error ?? "", /stayed red after the single FULL-GATE fix round/);
    assert.match(result.error ?? "", /## Orchestrator full gate: FULL-GATE — RED/, "the full-gate report");
    assert.match(result.error ?? "", /FAIL  __tests__\/a\.test\.ts/, "the failing suite tail");
    assert.equal(
      spawns.filter((id) => id === "FULL-GATE").length,
      1,
      "exactly one fix round runs before the halt",
    );
    assert.equal(
      execLog.filter((e) => e.cmd === "npm").length,
      5,
      "scope gate + both red gate visits (run + in-gate retry each); no third visit",
    );
    assert.equal(state.phase, "implementing", "the halt keeps the resume phase");
  });

  it("halts without a fix round when a failing test is undeclared, listing it and steering to /discuss -> /finalize -> /implement", async () => {
    const RED_UNDECLARED: NpmResult = {
      code: 1,
      stdout: "",
      stderr: "FAIL  secrets/hidden.test.ts > suite > test",
    };
    const { pi, execLog } = piWithNpmQueue([GREEN, RED_UNDECLARED, RED_UNDECLARED]);
    const state = finalGateState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(result.complete, false);
    assert.equal(result.haltedOn, "FULL-GATE");
    assert.match(result.error ?? "", /secrets\/hidden\.test\.ts — undeclared/, "the undeclared failing test is listed");
    assert.match(result.error ?? "", /__tests__\/a\.test\.ts|no fix/, "the triage report renders");
    assert.match(result.error ?? "", /\/discuss -> \/finalize -> \/implement/, "the contract-change steer");
    assert.deepEqual(spawns, ["T1"], "no fix round runs for an undeclared failing test");
    assert.equal(
      execLog.filter((e) => e.cmd === "npm").length,
      3,
      "the gate visit ran its run + in-gate retry and never re-ran",
    );
  });

  it("halts without a fix round when a red suite yields no parseable failing test path", async () => {
    const RED_UNPARSEABLE: NpmResult = {
      code: 1,
      stdout: "",
      stderr: "worker crashed before reporting any test",
    };
    const { pi, execLog } = piWithNpmQueue([GREEN, RED_UNPARSEABLE, RED_UNPARSEABLE]);
    const state = finalGateState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(result.complete, false);
    assert.equal(result.haltedOn, "FULL-GATE");
    assert.match(result.error ?? "", /Unparseable red suites/, "the unparseable suite is reported");
    assert.match(result.error ?? "", /javascript \(npm run test\)/, "the red suite label is named");
    assert.match(result.error ?? "", /\/discuss -> \/finalize -> \/implement/);
    assert.deepEqual(spawns, ["T1"], "no fix round runs on unparseable output");
    assert.equal(
      execLog.filter((e) => e.cmd === "npm").length,
      3,
      "the gate visit ran its run + in-gate retry and never re-ran",
    );
  });

  it("halts with the requested paths when the fix unit is blocked on an undeclared path", async () => {
    const { pi, execLog } = piWithNpmQueue([GREEN, RED_DECLARED, RED_DECLARED]);
    const state = finalGateState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      if (unit.behaviorId === "FULL-GATE") {
        return { summary: "blocked on an undeclared path", findings: ["BLOCKED PATH: secrets/env.ts"] };
      }
      return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(result.complete, false);
    assert.equal(result.haltedOn, "FULL-GATE");
    assert.match(result.error ?? "", /## FULL-GATE fix round blocked on undeclared paths/);
    assert.match(result.error ?? "", /- secrets\/env\.ts — undeclared/, "the requested path is listed");
    assert.match(result.error ?? "", /\/discuss -> \/finalize -> \/implement/, "the same contract-change steer");
    assert.deepEqual(spawns, ["T1", "FULL-GATE"], "the blocked fix unit is the only fix round");
    assert.equal(
      execLog.filter((e) => e.cmd === "git" && e.args[0] === "commit").length,
      1,
      "no fix commit lands when the unit is blocked",
    );
    assert.equal(
      execLog.filter((e) => e.cmd === "npm").length,
      3,
      "scope gate + the red gate visit (run + in-gate retry); no post-fix gate re-run after a blocked fix unit",
    );
  });
});

// ═══ T6: solo final-gate attempt counter ═══
describe("T6: solo complete_implementation final-gate attempt counter", () => {
  const GO_SUITE = { label: "go (go test ./...)", argv: ["go", "test", "./..."] };
  const JS_SUITE = { label: "javascript (npm run test)", argv: ["npm", "run", "test"] };

  /** Implementing state with all behaviors done and the recorded suites. */
  function soloState(): WorkflowState {
    const s = finalizingState();
    s.phase = "implementing";
    s.task!.behaviors[0].status = "done";
    s.testTool = { source: "detected", suites: [GO_SUITE, JS_SUITE] };
    return s;
  }

  /** Exec mock where the go suite fails while `goFails()` returns true. */
  function piWithGoFailing(goFails: () => boolean) {
    const pi = mockPi();
    registerCompleteImplementationTool(pi);
    pi.exec = (async (cmd: string) => {
      if (cmd === "go" && goFails()) {
        return { stdout: "", stderr: "--- FAIL: TestGate", code: 1, killed: false };
      }
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];
    return pi;
  }

  /** Invoke complete_implementation with a live AbortSignal. */
  function complete(pi: ReturnType<typeof piWithGoFailing>, ctx: ReturnType<typeof ctxWithState>) {
    return getTool(pi, "complete_implementation")!.execute(
      "c1",
      {},
      new AbortController().signal,
      undefined,
      ctx,
    );
  }

  it("a first red blocks with the failing suite and tail; a second consecutive red increments the attempt counter and refuses with a stop-and-report instruction", async () => {
    const pi = piWithGoFailing(() => true);
    const s = soloState();
    const ctx = ctxWithState(s);

    const first = await complete(pi, ctx);

    assert.equal(first.isError, true, "a red final gate blocks completion");
    assert.match(first.content[0].text, /go \(go test \.\/\.\.\.\)/, "the first red names the failing suite");
    assert.match(first.content[0].text, /--- FAIL: TestGate/, "the first red carries the output tail");
    assert.doesNotMatch(
      first.content[0].text,
      /stop and report to the user/i,
      "the first red still invites a fix instead of stopping",
    );
    assert.equal(s.finalGateAttempts, 1, "the first red increments the attempt counter");
    assert.equal(s.phase, "implementing", "completion stays blocked");

    const second = await complete(pi, ctx);

    assert.equal(second.isError, true, "the second red still blocks completion");
    assert.equal(s.finalGateAttempts, 2, "the second consecutive red increments the counter again");
    assert.match(
      second.content[0].text,
      /stop and report to the user/i,
      "the second red refuses with the stop-and-report instruction",
    );
    assert.match(second.content[0].text, /--- FAIL: TestGate/, "the second red still names the tail");
    assert.equal(s.phase, "implementing", "completion stays blocked");
    assert.equal(s.finalGate?.passed, false, "the red result is persisted on state");
  });

  it("a green final gate after a red resets the attempt counter and completes", async () => {
    let failing = true;
    const pi = piWithGoFailing(() => failing);
    const s = soloState();
    const ctx = ctxWithState(s);

    const first = await complete(pi, ctx);
    assert.equal(first.isError, true, "the red gate blocks completion");
    assert.equal(s.finalGateAttempts, 1, "the red incremented the counter");

    failing = false;
    const ok = await complete(pi, ctx);

    assert.notEqual(ok.isError, true, "a green gate allows completion");
    assert.equal(s.phase, "idle");
    assert.equal(s.finalGateAttempts, 0, "a green final gate resets the attempt counter");
    assert.equal(s.finalGate?.passed, true, "the green result is persisted on state");
  });
});

// ═══ T9: implement-start ensure + sole chore commit ═══
describe("T9: implement-start test extension chore commit", () => {
  const JS_SUITE = { label: "javascript (npm run test)", argv: ["npm", "run", "test"] };

  /** A finalizing state with one active behavior and the recorded test suite. */
  function choreState(): WorkflowState {
    const state = finalizingState();
    state.testTool = { source: "detected", suites: [JS_SUITE] };
    return state;
  }

  interface GitExecEntry { cmd: string; args: string[] }

  /**
   * Exec mock for the start-chore flow: git commits advance HEAD (unless
   * opts.failCommit simulates a rejected chore commit); the chore change
   * query (`diff --cached --name-only HEAD -- <path>`) answers from the
   * sole-path staging flag; a full staged-set query reports the injected
   * foreign staged paths too; every baseline/gate diff stays empty so the
   * behavior commit lands clean.
   */
  function piWithChoreExec(
    foreignStaged: string[] = [],
    opts: { failCommit?: boolean } = {},
  ): {
    pi: ExtensionAPI & { calls: Record<string, unknown[]> };
    execLog: GitExecEntry[];
  } {
    const pi = mockPi();
    const execLog: GitExecEntry[] = [];
    let headCounter = 0;
    let choreStaged = false;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
      if (cmd === "git" && args[0] === "rev-parse") return ok(`head${headCounter}\n`);
      if (cmd === "git" && args[0] === "add" && args[1] === "--") {
        choreStaged = true; // sole-path staging of the changed generated file
        return ok();
      }
      if (cmd === "git" && args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") {
        // The chore commit's change query: HEAD-relative, limited to the chore path.
        return ok(choreStaged ? `${args[args.length - 1]}\n` : "");
      }
      if (cmd === "git" && args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-status") {
        if (args.length === 3) {
          // A full staged-set query (index vs HEAD).
          const lines = [
            ...(choreStaged ? ["M\t.pi/extensions/test.ts"] : []),
            ...foreignStaged.map((p) => `M\t${p}`),
          ];
          return ok(lines.length ? lines.join("\n") + "\n" : "");
        }
        return ok(); // commitAndGate baseline query: clean tree
      }
      if (cmd === "git" && args[0] === "commit") {
        if (opts.failCommit) return { stdout: "", stderr: "pre-commit hook failed", code: 1, killed: false };
        headCounter++;
        return ok(`[main c${headCounter}] committed`);
      }
      return ok(); // status / add --all / unified diff / ls-tree / anything else
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  /** Temp project dir holding a manifest (deterministic dogfood-free cwd). */
  function tempProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-t9-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "t9", scripts: { test: "vitest run" } }),
    );
    return dir;
  }

  /** Extension context pinned to a real temp cwd carrying the given state. */
  function ctxAt(state: WorkflowState, cwd: string): ExtensionContext {
    const ctx = ctxWithState(state);
    (ctx as { cwd: string }).cwd = cwd;
    return ctx;
  }

  it("implementStartCommitsTestExtensionChore: at /implement start, before the first unit spawns, the orchestrator runs ensureTestTool and commits the changed generated file alone as 'chore: regenerate test extension'", async () => {
    const { TEST_EXTENSION_CHORE_SUBJECT } = await import("../extensions/test-extension-chore.ts");
    const { GENERATED_MARKER } = await import("../extensions/test-extension-constants.ts");
    const cwd = tempProject();
    const { pi, execLog } = piWithChoreExec();
    const state = choreState();
    const ctx = ctxAt(state, cwd);
    let spawnIdx = -1;

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawnIdx = execLog.length;
      return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat: implement x" };
    });

    // The orchestrator-owned ensure step generated the test extension.
    const generated = join(cwd, ".pi", "extensions", "test.ts");
    assert.ok(existsSync(generated), "ensureTestTool generated the test extension");
    assert.ok(
      readFileSync(generated, "utf8").includes(GENERATED_MARKER),
      "the generated file carries the GENERATED marker",
    );

    // The chore commit staged ONLY the chore path and used the fixed subject.
    const choreAdd = execLog.findIndex(
      (e) => e.cmd === "git" && e.args[0] === "add" && e.args[1] === "--",
    );
    assert.ok(choreAdd >= 0, "the chore file is staged sole-path (git add -- <path>), never add --all");
    assert.deepEqual(execLog[choreAdd]!.args, ["add", "--", ".pi/extensions/test.ts"]);
    const choreCommit = execLog.findIndex(
      (e) => e.cmd === "git" && e.args[0] === "commit" && e.args.includes(TEST_EXTENSION_CHORE_SUBJECT),
    );
    assert.ok(choreCommit >= 0, `the chore commit lands with subject "${TEST_EXTENSION_CHORE_SUBJECT}"`);
    assert.deepEqual(execLog[choreCommit]!.args, [
      "commit", "-m", "chore: regenerate test extension", "--signoff", "--only", "--", ".pi/extensions/test.ts",
    ]);
    assert.ok(spawnIdx > choreCommit, "the chore commit lands before the first unit spawns");

    // The run itself is unaffected: the behavior lands its own separate commit.
    assert.equal(result.complete, true, result.error ?? "");
    assert.deepEqual(
      result.landedCommits,
      ["feat: implement x"],
      "the behavior commit is separate from the chore commit",
    );
    const behaviorCommits = execLog.filter(
      (e) => e.cmd === "git" && e.args[0] === "commit" && !e.args.includes(TEST_EXTENSION_CHORE_SUBJECT),
    );
    assert.equal(behaviorCommits.length, 1, "exactly one behavior commit after the chore commit");
    assert.equal(state.task!.behaviors[0]!.status, "done");
  });

  it("choreCommitToleratesOtherStagedPaths: a foreign staged path no longer halts \u2014 the path-limited chore commit lands, then the first unit spawns", async () => {
    const cwd = tempProject();
    const { pi, execLog } = piWithChoreExec(["src/other.ts"]);
    const state = choreState();
    const ctx = ctxAt(state, cwd);
    let spawnIdx = -1;

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      if (spawnIdx < 0) spawnIdx = execLog.length;
      return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: "feat: implement x" };
    });

    const choreCommit = execLog.findIndex(
      (e) => e.cmd === "git" && e.args[0] === "commit" && e.args.includes("--only"),
    );
    assert.ok(choreCommit >= 0, "the path-limited chore commit ran despite the foreign staged path");
    assert.ok(spawnIdx > choreCommit, "the first unit spawns after the chore commit");
    assert.equal(result.complete, true, result.error ?? "");
    assert.equal(result.haltedOn, undefined, "the run does not halt");
  });

  it("failedChoreAtStartIsDiagnosedAsPreUnitHalt: a start-time chore commit failure halts with the pre-spawn diagnosis (T9)", async () => {
    const cwd = tempProject();
    const { pi } = piWithChoreExec([], { failCommit: true });
    const state = choreState();
    const ctx = ctxAt(state, cwd);
    let spawns = 0;

    const result = await runOrchestratedViaSeam(pi, ctx, async () => {
      spawns++;
      return { summary: "should never run", suggestedCommit: "feat: nope" };
    });

    assert.equal(spawns, 0, "the chore failure halts before any unit spawns");
    assert.equal(result.complete, false);
    assert.match(result.error ?? "", /Test-extension chore commit failed/, "the halt names the chore failure");
    assert.equal(
      result.diagnosis,
      "the run halted before any unit started",
      "an empty attempt history gets the pre-unit diagnosis",
    );
    assert.equal(state.lastHalt?.diagnosis, "the run halted before any unit started", "persisted to lastHalt");
  });

  it("noOtherOrchestratorCommitPath: git commit argv is spelled out only in commit-core.ts, and commitAndGate routes through buildCommitArgs", async () => {
    const extDir = fileURLToPath(new URL("../extensions", import.meta.url));
    const collect = (dir: string): string[] => {
      const files: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...collect(full));
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
      return files;
    };
    const offenders = collect(extDir)
      .filter((file) => /\[\s*"commit"\s*,/.test(readFileSync(file, "utf8")))
      .map((file) => relative(extDir, file).split(sep).join("/"));
    assert.deepEqual(
      offenders.sort(),
      ["commit-core.ts"],
      "only the shared commit core may spell out git commit argv (T3: the gate routes through it)",
    );
    for (const file of offenders) {
      const text = readFileSync(join(extDir, file), "utf8");
      assert.equal(
        (text.match(/\[\s*"commit"\s*,/g) ?? []).length,
        1,
        `${file} has exactly one commit call site`,
      );
    }
    const gate = readFileSync(join(extDir, "git-commit-gate.ts"), "utf8");
    assert.match(
      gate,
      /buildCommitArgs\(subject\)/,
      "commitAndGate builds its commit argv through the core (signoff included)",
    );
    assert.ok(
      !/\[\s*"commit"\s*,/.test(gate),
      "git-commit-gate.ts never spells out the commit argv itself",
    );
  });

  it("gitModulesWithinLineBudget: the split git modules are each at most 250 lines", () => {
    const extDir = fileURLToPath(new URL("../extensions", import.meta.url));
    for (const file of ["git-ops.ts", "git-commit-gate.ts", "git-guard-diff.ts", "test-extension-chore.ts"]) {
      const lines = readFileSync(join(extDir, file), "utf8").split("\n").length;
      assert.ok(lines <= 250, `${file} has ${lines} lines (budget 250)`);
    }
  });
});

// "T8": implement-loop split into loop + default runner + halt builder.
describe("implement-loop module split (T8)", () => {
  it("implementLoopModulesWithinLineBudget: implement-loop and its two extracted modules are at most 250 lines", () => {
    const extDir = fileURLToPath(new URL("../extensions", import.meta.url));
    for (const file of ["implement-loop.ts", "unit-runner-default.ts", "orchestrator-halt.ts"]) {
      const lines = readFileSync(join(extDir, file), "utf8").split("\n").length;
      assert.ok(lines <= 250, `${file} has ${lines} lines (budget 250)`);
    }
  });
});

// "T13": implement.ts splits into implement + implement-solo.
describe("implement module split (T13)", () => {
  it("implementModulesWithinLineBudget: implement.ts and implement-solo.ts are each at most 250 lines", () => {
    const extDir = fileURLToPath(new URL("../extensions", import.meta.url));
    for (const file of ["implement.ts", "implement-solo.ts"]) {
      const lines = readFileSync(join(extDir, file), "utf8").split("\n").length;
      assert.ok(lines <= 250, `${file} has ${lines} lines (budget 250)`);
    }
  });
});
