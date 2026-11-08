import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runOrchestratedImplement } from "../extensions/implement-loop.ts";
import type { WorkflowState } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  mockPi,
  ctxWithState,
  finalizingState,
  runOrchestratedViaSeam,
} from "./helpers/implement-harness.ts";

// ═══ T4: early halt on cross-ownership hook blocks ═══
describe("T4: early halt on cross-ownership hook blocks", () => {
  /** Hook output naming another task's declared path (extensions/other.ts is owned by T7/T2). */
  const CROSS_OWNED_HOOK =
    "golangci-lint run failed\n" +
    "extensions/other.ts:12:5: undefined: Probe\n" +
    "exit status 1";

  /** Hook output naming a foreign task's path that is NOT in the true index (phantom). */
  const PHANTOM_FOREIGN_HOOK =
    "golangci-lint run failed\n" +
    "extensions/other.ts:12:5: undefined: Probe\n" +
    "exit status 1";

  /** Hook output naming only the unit's own path plus an undeclared path. */
  const OWN_ONLY_HOOK =
    "golangci-lint run failed\n" +
    "src/a.ts:10:1: lint error\n" +
    "some/undeclared/file.go:3:1: nope\n" +
    "exit status 1";

  /** Finalizing state whose v2 contract gives T1 src/a.ts and T7/T2 extensions/other.ts. */
  function ownershipState(): WorkflowState {
    return {
      phase: "finalizing",
      specText: "topic",
      contractV2: {
        title: "Ownership Task",
        instruction: "do things",
        done: "all green",
        sources: [
          { path: "src/a.ts", tasks: ["T1"] },
          { path: "extensions/other.ts", tasks: ["T7", "T2"] },
        ],
        tests: [{ path: "__tests__/a.test.ts", tasks: ["T1"] }],
        tasks: [
          { id: "T1", description: "first behavior", expectedOutput: ["e1"], status: "active" },
          { id: "T7", description: "other behavior", expectedOutput: ["e7"], status: "active" },
          { id: "T2", description: "third behavior", expectedOutput: ["e2"], status: "active" },
        ],
      },
      task: {
        title: "Ownership Task",
        instruction: "do things",
        files: [
          { path: "src/a.ts", status: "M" },
          { path: "extensions/other.ts", status: "M" },
        ],
        done: "all green",
        behaviors: [
          { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        ],
      },
    };
  }

  /**
   * Exec mock: a dirty tree whose baseline name-status lists only the unit's
   * own path; the pre-commit hook always rejects with `hookStderr` (HEAD never
   * moves), so every commit attempt classifies as hook-rejected. The staged
   * index (`git diff --cached --name-only HEAD`) answers `stagedPaths`.
   *
   * @param hookStderr - Raw hook output of the failing git commit.
   * @param stagedPaths - True-index paths (git diff --cached --name-only HEAD).
   * @returns The mock ExtensionAPI.
   */
  function piWithHook(hookStderr: string, stagedPaths = "src/a.ts\n") {
    const pi = mockPi();
    let commitAttempts = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
      if (cmd === "git" && args[0] === "rev-parse") return ok("headA\n");
      if (cmd === "git" && args[0] === "status") return ok(" M src/a.ts\n");
      if (cmd === "git" && args[0] === "add") return ok();
      if (cmd === "git" && args[0] === "diff" && args.includes("--name-status")) {
        return ok("M\tsrc/a.ts\n");
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--name-only")) {
        return ok(stagedPaths);
      }
      if (cmd === "git" && args[0] === "commit") {
        commitAttempts++;
        return { stdout: "", stderr: `${hookStderr} (attempt ${commitAttempts})`, code: 1, killed: false };
      }
      return ok();
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("crossOwnershipHaltsImmediately: a hook-rejected commit naming another task's staged path halts with no fix-forward round and no retry charge", async () => {
    const pi = piWithHook(CROSS_OWNED_HOOK, "src/a.ts\nextensions/other.ts\n");
    const state = ownershipState();
    const ctx = ctxWithState(state);
    const statuses: Array<[string, string | undefined]> = [];
    ctx.ui.setStatus = ((key: string, value: string | undefined) => {
      statuses.push([key, value]);
    }) as unknown as ExtensionContext["ui"]["setStatus"];
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: "implemented T1", suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(result.complete, false, "the cross-ownership block halts the run");
    assert.equal(result.haltedOn, "T1");
    assert.deepEqual(spawns, ["T1"], "no fix-forward round is spawned after the cross-ownership rejection");
    assert.equal(result.unitsRun, 1, "the retry budget is never charged");
    const retryFrames = statuses.filter(([, v]) => typeof v === "string" && v.includes("retry"));
    assert.deepEqual(retryFrames, [], "no retry frame — the loop halts before any fix round");
    assert.doesNotMatch(result.error ?? "", /after \d+ retries/, "not a budget-exhaustion halt");
  });

  it("crossOwnershipHaltNamesPathOwnersFallback: the halt error names the blocking path, its owning task ids, and the manual fallback", async () => {
    const pi = piWithHook(CROSS_OWNED_HOOK, "src/a.ts\nextensions/other.ts\n");
    const state = ownershipState();
    const ctx = ctxWithState(state);

    const result = await runOrchestratedViaSeam(pi, ctx, async () => ({
      summary: "implemented T1",
      suggestedCommit: "feat(core): add first behavior",
    }));

    const error = result.error ?? "";
    assert.match(error, /extensions\/other\.ts/, "the blocking path is named");
    assert.match(error, /T7/, "the first owning task id is named");
    assert.match(error, /T2/, "the second owning task id is named");
    assert.match(error, /fix the file for the owning task/i, "fallback: fix the file for the owning task");
    assert.match(
      error,
      /unstage\/keep it out of this unit's commit/i,
      "fallback: unstage/keep the path out of this unit's commit",
    );
    assert.match(state.lastHalt?.error ?? "", /extensions\/other\.ts/, "lastHalt persists the same error");
  });

  it("phantomForeignPathFallsThrough: a hook-named foreign path absent from the true index halts no cross-ownership — the ordinary hook-rejected halt carries its own diagnostics", async () => {
    // extensions/other.ts is foreign-owned but NOT staged: the halt must fall
    // through to the ordinary hook-rejected path with its investigation.
    const pi = piWithHook(PHANTOM_FOREIGN_HOOK, "src/a.ts\n");
    const state = ownershipState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: `attempt ${spawns.length}`, suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(spawns.length, 6, "initial + 5 budgeted retries — the phantom never blocks");
    assert.equal(result.complete, false);
    assert.match(
      result.error ?? "",
      /pre-commit hook rejected the commit for T1 after 5 retries/,
      "the ordinary hook-rejected halt",
    );
    assert.match(result.error ?? "", /golangci-lint run failed/, "the halt carries the hook diagnostics");
    assert.doesNotMatch(result.error ?? "", /Cross-ownership/, "a phantom foreign path raises no cross-ownership halt");
  });

  it("investigationOnlyForeignPathKeepsFixForward: a foreign path in the investigation text (not the hook output) raises no cross-ownership halt", async () => {
    // The hook output names no foreign path; the investigation text embeds
    // git status / diff --stat which may mention foreign paths — scanning only
    // the raw hook evidence means the ordinary fix-forward path proceeds.
    const INNOCENT_HOOK = "golangci-lint run failed\nundefined: Probe\nexit status 1";
    const pi = mockPi();
    let commitAttempts = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
      if (cmd === "git" && args[0] === "rev-parse") return ok("headA\n");
      // The tree state/diff --stat embed the foreign path in the investigation text.
      // T6 preflight reads porcelain: keep the foreign path out of the dirty
      // status so the preflight passes; `--short` still embeds it in the
      // investigation text (the actual subject of this test).
      if (cmd === "git" && args[0] === "status") {
        if (args.includes("--porcelain")) return ok(" M src/a.ts\n");
        return ok(" M src/a.ts\n M extensions/other.ts\n");
      }
      if (cmd === "git" && args[0] === "add") return ok();
      if (cmd === "git" && args[0] === "diff" && args.includes("--name-status")) {
        return ok("M\tsrc/a.ts\n");
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--name-only")) {
        return ok("src/a.ts\nextensions/other.ts\n");
      }
      if (cmd === "git" && args[0] === "commit") {
        commitAttempts++;
        return { stdout: "", stderr: `${INNOCENT_HOOK} (attempt ${commitAttempts})`, code: 1, killed: false };
      }
      return ok();
    }) as ExtensionAPI["exec"];
    const state = ownershipState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: `attempt ${spawns.length}`, suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(spawns.length, 6, "initial + 5 budgeted fix rounds — ordinary fix-forward path");
    assert.match(
      result.error ?? "",
      /pre-commit hook rejected the commit for T1 after 5 retries/,
      "the ordinary budget-exhaustion halt",
    );
    assert.doesNotMatch(result.error ?? "", /Cross-ownership/, "investigation-only foreign paths never block");
  });

  it("haltAdvisesLocalHookWhenNamedPathCommittedOrClean: the halt text advises running the hook locally for a named declared path absent from the index", async () => {
    // The hook names the staged foreign path (blocking) AND a declared path
    // that is already committed/clean — the halt then advises a local hook run.
    const HOOK_WITH_CLEAN_PATH =
      "golangci-lint run failed\n" +
      "extensions/other.ts:12:5: undefined: Probe\n" +
      "__tests__/a.test.ts:3:1: formatting\n" +
      "exit status 1";
    const pi = piWithHook(HOOK_WITH_CLEAN_PATH, "src/a.ts\nextensions/other.ts\n");
    const state = ownershipState();
    const ctx = ctxWithState(state);

    const result = await runOrchestratedViaSeam(pi, ctx, async () => ({
      summary: "implemented T1",
      suggestedCommit: "feat(core): add first behavior",
    }));

    const error = result.error ?? "";
    assert.match(error, /extensions\/other\.ts/, "the blocking path is named");
    assert.match(error, /__tests__\/a\.test\.ts/, "the committed/clean named path is named");
    assert.match(error, /run the hook locally/i, "advises running the hook locally");
  });

  it("ownOrUndeclaredHookPathsKeepFixForward: a hook rejection naming only the unit's own or undeclared paths takes the normal fix-forward path", async () => {
    const pi = piWithHook(OWN_ONLY_HOOK);
    const state = ownershipState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: `attempt ${spawns.length}`, suggestedCommit: "feat(core): add first behavior" };
    });

    assert.equal(
      spawns.length,
      6,
      "initial attempt + 5 budgeted fix rounds — the ordinary fix-forward path",
    );
    assert.equal(result.complete, false);
    assert.match(
      result.error ?? "",
      /pre-commit hook rejected the commit for T1 after 5 retries/,
      "the ordinary budget-exhaustion halt",
    );
    assert.doesNotMatch(result.error ?? "", /Cross-ownership/, "no cross-ownership halt for own/undeclared paths");
    assert.equal(state.task!.behaviors[0]!.status, "active");
  });

  it("crossOwnershipHelpersArePure: extractRepoPaths + findCrossOwnershipBlock verify hook evidence against the true index without I/O", async () => {
    const { extractRepoPaths, findCrossOwnershipBlock, buildCrossOwnershipHaltText } = await import(
      "../extensions/cross-ownership.ts"
    );
    const contract = ownershipState().contractV2!;

    const paths = extractRepoPaths(
      "approve.go:42:1: undefined\n M src/a.ts\n./pkg/x/y.go | 2 +-\nsome/undeclared/file.go:3",
    );
    assert.ok(paths.includes("approve.go"), "a dotted file name is extracted");
    assert.ok(paths.includes("src/a.ts"), "a git-status path is extracted");
    assert.ok(paths.includes("pkg/x/y.go"), "a ./-prefixed path is normalized");
    assert.ok(paths.includes("some/undeclared/file.go"), "an undeclared path is still extracted");

    const staged = ["src/a.ts", "extensions/other.ts"];
    const block = findCrossOwnershipBlock(
      "lint failed:\nextensions/other.ts:12:5: undefined: Probe",
      contract,
      "T1",
      staged,
    );
    assert.deepEqual(block, { path: "extensions/other.ts", owners: ["T7", "T2"] }, "staged cross-owned path blocks with its owners");
    assert.equal(
      findCrossOwnershipBlock("lint failed: src/a.ts:10", contract, "T1", staged),
      undefined,
      "the unit's own path never blocks",
    );
    assert.equal(
      findCrossOwnershipBlock("lint failed: some/undeclared/file.go", contract, "T1", staged),
      undefined,
      "an undeclared path never blocks",
    );
    assert.equal(
      findCrossOwnershipBlock("lint failed: extensions/other.ts:12", contract, "T1", ["src/a.ts"]),
      undefined,
      "a foreign path absent from the true index (phantom) never blocks",
    );
    assert.equal(findCrossOwnershipBlock("x extensions/other.ts", undefined, "T1", staged), undefined, "v1 sessions (no contract) never block");

    const text = buildCrossOwnershipHaltText("extensions/other.ts:12:5: bad", contract, "T1", staged);
    assert.match(text ?? "", /extensions\/other\.ts/, "the built error names the path");
    assert.match(text ?? "", /T7, T2/, "the built error names every owning task id");
    assert.match(text ?? "", /fix the file for the owning task/i, "fallback: fix for the owning task");
    assert.match(text ?? "", /unstage\/keep it out of this unit's commit/i, "fallback: unstage/keep out of this commit");
    assert.equal(buildCrossOwnershipHaltText("src/a.ts:10:1: bad", contract, "T1", staged), undefined, "no block → no error");
  });
});

// ═══ T5: the slop gate in the orchestrator commit path ═══
describe("T5: slop gate wiring in the orchestrator loop", () => {
  /** One exec call recorded by piWithSlopGate. */
  interface SlopExecEntry { cmd: string; args: string[] }

  /** aislop JSON: a hard-mode block (score 12 < codeFailBelow 80). */
  const HARD_BLOCK_SCAN = JSON.stringify({
    score: 12,
    diagnostics: [
      { filePath: "src/a.ts", line: 3, rule: "no-todo", severity: "warn", message: "leftover TODO" },
    ],
  });
  /** aislop JSON: a clean scan (score 95 ≥ codeFailBelow 80). */
  const CLEAN_SCAN = JSON.stringify({ score: 95, diagnostics: [] });
  /** aislop JSON: an advisory breach (score 42 < codeFailBelow 80). */
  const ADVISORY_SCAN = JSON.stringify({ score: 42, diagnostics: [] });

  /**
   * Exec mock for the loop-level slop-gate runs: git plumbing answers the
   * gate's reads (HEAD advances only on commit), `which aislop` resolves the
   * scanner, and each aislop invocation answers with the next scripted JSON
   * report (clamped to the last answer when exhausted).
   *
   * @param scanAnswers - Raw JSON stdout returned by successive aislop runs.
   * @returns The mock ExtensionAPI plus the recorded exec log.
   */
  function piWithSlopGate(scanAnswers: string[]): {
    pi: ExtensionAPI & { calls: Record<string, unknown[]> };
    execLog: SlopExecEntry[];
  } {
    const pi = mockPi();
    const execLog: SlopExecEntry[] = [];
    let headCounter = 0;
    let scanIdx = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
      if (cmd === "git" && args[0] === "rev-parse") return ok(`head${headCounter}\n`);
      if (cmd === "git" && args[0] === "status") return ok(" M src/a.ts\n");
      if (cmd === "git" && args[0] === "add") return ok();
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return ok("[main abc] committed");
      }
      if (cmd === "git" && args[0] === "diff") {
        if (args.includes("--name-status")) return ok("M\tsrc/a.ts\n");
        if (args.includes("--name-only")) return ok("src/a.ts\n");
        if (args.includes("--stat")) return ok(" src/a.ts | 2 +-");
        return ok("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
      }
      if (cmd === "which") return ok(); // code 0: aislop resolves on PATH
      if (cmd === "aislop" || cmd.endsWith("/aislop")) {
        const answer = scanAnswers[Math.min(scanIdx, scanAnswers.length - 1)] ?? "{}";
        scanIdx++;
        return ok(answer);
      }
      return ok();
    }) as ExtensionAPI["exec"];
    return { pi, execLog };
  }

  it("hardRunBlocksFirstCommitSpawnsFixRoundAndLandsNextAttempt: the first attempt is slop-guard-blocked, a fix round follows, and the next clean attempt lands", async () => {
    process.env.PI_SLOP_GATE = "hard";
    try {
      const { pi, execLog } = piWithSlopGate([HARD_BLOCK_SCAN, CLEAN_SCAN]);
      const state = finalizingState();
      const ctx = ctxWithState(state);
      const spawns: Array<{ behaviorId: string; taskText: string }> = [];

      const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
        spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
        return {
          summary: `implemented ${unit.behaviorId}`,
          suggestedCommit: "feat(core): add first behavior",
        };
      });

      assert.equal(
        result.complete,
        true,
        `the second (clean) attempt must land, got: ${result.error ?? ""}`,
      );
      assert.equal(spawns.length, 2, "initial unit + exactly one slop-guard fix round");
      const commits = execLog.filter((e) => e.cmd === "git" && e.args[0] === "commit");
      assert.equal(commits.length, 1, "only the clean second attempt invokes git commit");
      assert.match(spawns[1]!.taskText, /slop/, "the fix round text names the slop gate");
      assert.match(
        spawns[1]!.taskText,
        /Previous attempt failed \(retry 1\/5\)/,
        "the slop-guard fix round is a budgeted retry",
      );
      assert.equal(state.task!.behaviors[0]!.status, "done", "the behavior lands on the clean attempt");
    } finally {
      process.env.PI_SLOP_GATE = "off";
    }
  });

  it("advisoryRunLandsFirstAttemptAndRecordsNote: the commit lands immediately and the advisory note joins the shared findings ledger", async () => {
    process.env.PI_SLOP_GATE = "advisory";
    try {
      const { pi, execLog } = piWithSlopGate([ADVISORY_SCAN]);
      // Snapshot every persisted workflow-state entry: the loop mutates the
      // live state object and completion clears state.findings, so the
      // advisory note must be asserted against clones taken at persist time.
      const realAppend = pi.appendEntry;
      pi.appendEntry = ((type: string, data: unknown) =>
        realAppend(type, type === "workflow-state" ? structuredClone(data) : data)) as ExtensionAPI["appendEntry"];
      const state = finalizingState();
      const ctx = ctxWithState(state);
      const spawns: Array<{ behaviorId: string; taskText: string }> = [];

      const result = await runOrchestratedImplement(pi, ctx, state, state.task!, async (unit) => {
        spawns.push({ behaviorId: unit.behaviorId, taskText: unit.taskText });
        return {
          summary: `implemented ${unit.behaviorId}`,
          suggestedCommit: "feat(core): add first behavior",
        };
      });

      assert.equal(result.complete, true, `an advisory note never blocks, got: ${result.error ?? ""}`);
      assert.equal(spawns.length, 1, "no fix round — the first attempt lands");
      const commits = execLog.filter((e) => e.cmd === "git" && e.args[0] === "commit");
      assert.equal(commits.length, 1, "the first attempt invokes git commit exactly once");
      const NOTE = "slop advisory: code score 42 is below codeFailBelow 80";
      const snapshots = (pi.calls["appendEntry"] ?? []) as Array<[string, WorkflowState]>;
      const withNote = snapshots.filter(
        ([type, saved]) =>
          type === "workflow-state" &&
          (saved.findings ?? []).some((f) => f.behaviorId === "T1" && f.text === NOTE),
      );
      assert.ok(
        withNote.length >= 1,
        "a persisted snapshot carries the advisory note in the findings ledger",
      );
    } finally {
      process.env.PI_SLOP_GATE = "off";
    }
  });

  it("vitestEnvPinsSlopGateOff: the vitest environment sets PI_SLOP_GATE to off", () => {
    assert.equal(
      process.env.PI_SLOP_GATE,
      "off",
      "vitest.config.ts test.env pins PI_SLOP_GATE=off",
    );
  });
});

// ═══ T6: dirty-tree preflight at /implement start and resume ═══
describe("T6: dirty-tree preflight at /implement", () => {
  /** v2 state whose contract gives T1 src/a.ts and T7/T2 extensions/other.ts. */
  function preflightState(phase: "finalizing" | "implementing" = "finalizing"): WorkflowState {
    return {
      phase,
      specText: "topic",
      contractV2: {
        title: "Preflight Task",
        instruction: "do things",
        done: "all green",
        sources: [
          { path: "src/a.ts", tasks: ["T1"] },
          { path: "extensions/other.ts", tasks: ["T7", "T2"] },
        ],
        tests: [{ path: "__tests__/a.test.ts", tasks: ["T1"] }],
        tasks: [
          { id: "T1", description: "first behavior", expectedOutput: ["e1"], status: "active" },
          { id: "T7", description: "other behavior", expectedOutput: ["e7"], status: "active" },
          { id: "T2", description: "third behavior", expectedOutput: ["e2"], status: "active" },
        ],
      },
      task: {
        title: "Preflight Task",
        instruction: "do things",
        files: [
          { path: "src/a.ts", status: "M" },
          { path: "extensions/other.ts", status: "M" },
        ],
        done: "all green",
        behaviors: [
          { id: "T1", description: "first behavior", expectedOutput: "e1", kind: "test", status: "active" },
        ],
      },
    };
  }

  /** Exec mock with a fixed porcelain status; HEAD advances on each commit. */
  function piWithPorcelain(porcelain: string) {
    const pi = mockPi();
    let headCounter = 0;
    pi.exec = (async (cmd: string, args: string[]) => {
      const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
      if (cmd === "git" && args[0] === "rev-parse") return ok(`head${headCounter}\n`);
      if (cmd === "git" && args[0] === "status") return ok(porcelain);
      if (cmd === "git" && args[0] === "commit") {
        headCounter++;
        return ok("[main abc] committed");
      }
      return ok();
    }) as ExtensionAPI["exec"];
    return pi;
  }

  it("halts before spawning any unit when a later-task-owned path is dirty, naming path, owners and fallbacks", async () => {
    const pi = piWithPorcelain(" M extensions/other.ts\n");
    const state = preflightState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: `feat(core): add ${unit.behaviorId}` };
    });

    assert.deepEqual(spawns, [], "the preflight halts before any unit spawns");
    assert.equal(result.complete, false, "a blocking dirty path halts the run");
    assert.equal(result.haltedOn, "T1");
    const error = result.error ?? "";
    assert.match(error, /before any unit spawned/, "the halt states it happened pre-spawn");
    assert.match(error, /extensions\/other\.ts/, "names the blocking path");
    assert.match(error, /owners: T7, T2/, "names the owner ids");
    assert.match(error, /checkpoint/i, "fallback: commit as a checkpoint");
    assert.match(error, /git stash push -- extensions\/other\.ts/, "fallback: stash the paths");
    assert.match(error, /re-finalize/i, "fallback: re-finalize so the first active task owns them");
    assert.match(state.lastHalt?.error ?? "", /extensions\/other\.ts/, "lastHalt persists the halt");
  });

  it("applies the same preflight halt on resume (phase implementing)", async () => {
    const pi = piWithPorcelain(" M extensions/other.ts\n");
    const state = preflightState("implementing");
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return { summary: `implemented ${unit.behaviorId}`, suggestedCommit: `feat(core): add ${unit.behaviorId}` };
    });

    assert.deepEqual(spawns, [], "resume runs the same preflight before any unit spawns");
    assert.equal(result.complete, false, "the resume preflight halts too");
    assert.equal(result.haltedOn, "T1");
    const error = result.error ?? "";
    assert.match(error, /extensions\/other\.ts/, "names the blocking path");
    assert.match(error, /owners: T7, T2/, "names the owner ids");
    assert.match(error, /git stash push -- extensions\/other\.ts/, "fallback: stash the paths");
    assert.match(error, /re-finalize/i, "fallback: re-finalize");
  });

  it("proceeds and spawns the first unit when only first-task-owned or undeclared paths are dirty", async () => {
    const pi = piWithPorcelain(" M src/a.ts\n?? scratch.txt\n");
    const state = preflightState();
    const ctx = ctxWithState(state);
    const spawns: string[] = [];
    const notifies: string[] = [];
    ctx.ui.notify = ((msg: string) => {
      notifies.push(msg);
    }) as unknown as ExtensionContext["ui"]["notify"];

    const result = await runOrchestratedViaSeam(pi, ctx, async (unit) => {
      spawns.push(unit.behaviorId);
      return {
        summary: `implemented ${unit.behaviorId}`,
        suggestedCommit: `feat(core): add ${unit.behaviorId}`,
      };
    });

    assert.deepEqual(
      spawns,
      ["T1"],
      "first-task-owned and undeclared dirt never blocks the first unit",
    );
    assert.equal(result.complete, true, `the run completes, got: ${result.error ?? ""}`);
    assert.ok(
      notifies.some((m) => /scratch\.txt/.test(m)),
      "the undeclared dirty path surfaces as an advisory notify",
    );
  });
});
