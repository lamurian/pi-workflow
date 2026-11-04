import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RETRY_BUDGET,
  buildFixTask,
  buildInvestigation,
  classifyCommit,
  detectFailingStage,
  retryExhaustedDetail,
  type GateInput,
} from "../extensions/commit-gate.ts";
import { classifyStagedDiff } from "../extensions/staged-diff-guard.ts";
import { commitAndGate } from "../extensions/git-commit-gate.ts";
import { filterOrchestratorOwned } from "../extensions/git-guard-diff.ts";
import type { SlopGateRunner } from "../extensions/slop-gate.ts";
import type { SlopVerdict } from "../extensions/slop-scan.ts";
import type { Behavior, ContractV2, TaskContract } from "../extensions/state.ts";

const BEHAVIOR: Behavior = {
  id: "T1",
  description: "first behavior",
  expectedOutput: "e1",
  kind: "test",
  status: "active",
};

const TASK: TaskContract = {
  title: "Orch Task",
  instruction: "do things",
  files: [{ path: "src/a.ts", status: "M" }],
  done: "all green",
  behaviors: [BEHAVIOR],
};

function gateInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    headBefore: "headA",
    headAfter: "headA",
    commitExitCode: 1,
    commitOutput: "golangci-lint run failed\nexit status 1",
    timedOut: false,
    statusAfter: " M src/a.ts",
    diffStat: " src/a.ts | 2 +-",
    timeoutMs: 300_000,
    ...overrides,
  };
}

describe("detectFailingStage", () => {
  it("attributes lint output to lint", () => {
    assert.equal(detectFailingStage("golangci-lint run failed: 3 issues"), "lint");
  });
  it("attributes format output to format", () => {
    assert.equal(detectFailingStage("gofmt -l reported dirty files"), "format");
  });
  it("attributes test output to test", () => {
    assert.equal(detectFailingStage("FAIL\tgithub.com/x/y\t0.5s"), "test");
  });
  it("returns unknown when nothing matches", () => {
    assert.equal(detectFailingStage("something odd happened"), "unknown");
  });
});

describe("classifyCommit (T2)", () => {
  it("landed when HEAD moved — hooks passed", () => {
    const outcome = classifyCommit(BEHAVIOR, gateInput({ headAfter: "headB", commitExitCode: 0 }));
    assert.equal(outcome.kind, "landed");
  });

  it("hook-rejected when HEAD unchanged and the tree is dirty", () => {
    const outcome = classifyCommit(BEHAVIOR, gateInput());
    assert.equal(outcome.kind, "hook-rejected");
    if (outcome.kind !== "hook-rejected") return;
    assert.match(outcome.investigation, /git commit exit code: 1/);
    assert.match(outcome.investigation, /failing stage \(best-effort\): lint/);
    assert.match(outcome.investigation, /git status --short: M src\/a\.ts/);
    assert.match(outcome.investigation, /diff --stat: src\/a\.ts \| 2 \+-/);
    assert.match(outcome.investigation, /Hook output tail/);
    assert.match(outcome.hookOutput, /golangci-lint run failed/);
  });

  it("no-changes when HEAD unchanged and the tree is clean", () => {
    const outcome = classifyCommit(
      BEHAVIOR,
      gateInput({ statusAfter: "", diffStat: "", commitOutput: "nothing to commit" }),
    );
    assert.equal(outcome.kind, "no-changes");
    if (outcome.kind !== "no-changes") return;
    assert.match(outcome.investigation, /No changes detected for T1/);
  });

  it("landed (hardening) when heads are unavailable, the commit exited 0, and the tree is clean", () => {
    // git commit exit 0 means the commit was created even when rev-parse
    // HEAD is unavailable — a successful commit must never be misclassified
    // as no-changes just because HEAD could not be read.
    const outcome = classifyCommit(
      BEHAVIOR,
      gateInput({
        headBefore: null,
        headAfter: null,
        commitExitCode: 0,
        commitOutput: "",
        timedOut: false,
        statusAfter: "",
        diffStat: "",
      }),
    );
    assert.equal(outcome.kind, "landed");
  });

  it("commit-timeout wins over hook-rejection even on a dirty tree", () => {
    const outcome = classifyCommit(BEHAVIOR, gateInput({ timedOut: true, commitOutput: "timed out after 300000ms" }));
    assert.equal(outcome.kind, "commit-timeout");
    if (outcome.kind !== "commit-timeout") return;
    assert.match(outcome.investigation, /timed out after 300000ms/);
    assert.match(outcome.investigation, /infrastructure failure, not a hook verdict/i);
  });

  it("landed when HEAD moved even if the commit printed failure-looking output", () => {
    const outcome = classifyCommit(
      BEHAVIOR,
      gateInput({ headAfter: "headB", commitExitCode: 0, commitOutput: "FAIL something" }),
    );
    assert.equal(outcome.kind, "landed");
  });
});

describe("buildInvestigation (T2)", () => {
  it("names the behavior, exit code, stage, tree evidence, and hook tail", () => {
    const text = buildInvestigation(BEHAVIOR, gateInput());
    assert.match(text, /commit for T1 did not land/);
    assert.match(text, /git commit exit code: 1/);
    assert.match(text, /failing stage \(best-effort\): lint/);
    assert.match(text, /git status --short: M src\/a\.ts/);
    assert.match(text, /diff --stat/);
    assert.match(text, /golangci-lint run failed/);
  });
});

describe("buildFixTask (T2)", () => {
  it("carries the budget header, investigation, raw hook output, and original task", () => {
    const original = "Implement ONE behavior: T1.\nDescription: first behavior";
    const outcome = classifyCommit(BEHAVIOR, gateInput());
    assert.equal(outcome.kind, "hook-rejected");
    if (outcome.kind !== "hook-rejected") return;

    const taskText = buildFixTask(BEHAVIOR, TASK, original, outcome, 1);

    assert.match(taskText, /Previous attempt failed \(retry 1\/5\)/);
    assert.match(taskText, /Investigation: commit for T1 did not land/);
    assert.match(taskText, /Raw hook output/);
    assert.match(taskText, /golangci-lint run failed/);
    assert.match(taskText, /Original task/);
    assert.match(taskText, /Implement ONE behavior: T1\./);
  });

  it("uses the engineer's retry budget of 5", () => {
    assert.equal(RETRY_BUDGET, 5);
  });
});

// ═══ classifyStagedDiff — staged-diff tamper guard (T4) ═══

describe("classifyStagedDiff (T4)", () => {
  const DECLARED = ["src/a.ts", "tests/a.test.ts"];
  const SOURCE_FILES = ["tests/a.test.ts"];

  function staged(overrides: Partial<Parameters<typeof classifyStagedDiff>[0]> = {}) {
    return classifyStagedDiff({
      nameStatus: "",
      declaredFiles: DECLARED,
      testKindSourceFiles: SOURCE_FILES,
      attempt: 1,
      ...overrides,
    });
  }

  it("test-guard on D of an undeclared test path, with the offending path", () => {
    const r = staged({ nameStatus: "D\tpkg/old_test.go\n" });
    assert.equal(r.kind, "test-guard");
    assert.ok(
      r.violations.some((v) => v.includes("pkg/old_test.go")),
      `violations must name the offending path, got ${JSON.stringify(r.violations)}`,
    );
  });

  it("test-guard on D of a declared test-kind sourceFile", () => {
    const r = staged({ nameStatus: "D\ttests/a.test.ts\n" });
    assert.equal(r.kind, "test-guard");
    assert.ok(r.violations.some((v) => v.includes("tests/a.test.ts")));
  });

  it("test-guard on skip/only markers added to an undeclared test path", () => {
    const r = staged({
      nameStatus: "M\ttests/other.test.ts\n",
      unifiedDiff:
        "diff --git a/tests/other.test.ts b/tests/other.test.ts\n" +
        "--- a/tests/other.test.ts\n" +
        "+++ b/tests/other.test.ts\n" +
        "@@ -1 +1 @@\n" +
        "-it('works')\n" +
        "+it.skip('works')\n",
    });
    assert.equal(r.kind, "test-guard");
    assert.ok(r.violations.some((v) => v.includes("tests/other.test.ts")));
  });

  it("A on any test path and M on a declared test path yield no violation", () => {
    const r = staged({
      nameStatus: "A\ttests/new.test.ts\nM\ttests/a.test.ts\n",
      unifiedDiff:
        "diff --git a/tests/a.test.ts b/tests/a.test.ts\n" +
        "--- a/tests/a.test.ts\n" +
        "+++ b/tests/a.test.ts\n" +
        "@@ -1 +1 @@\n" +
        "-it('old')\n" +
        "+it('new')\n",
    });
    assert.equal(r.kind, "clean");
    assert.deepEqual(r.violations, []);
  });

  it("M on an undeclared test path: clean on attempt 1, test-guard on retry", () => {
    const nameStatus = "M\ttests/other.test.ts\n";
    const first = staged({ nameStatus });
    assert.equal(first.kind, "clean");

    const retry = staged({ nameStatus, attempt: 2 });
    assert.equal(retry.kind, "test-guard");
    assert.ok(retry.violations.some((v) => v.includes("tests/other.test.ts")));
  });

  it("assertion deltas appear in the investigation for all outcomes, never gating", () => {
    const diff =
      "diff --git a/tests/a.test.ts b/tests/a.test.ts\n" +
      "--- a/tests/a.test.ts\n" +
      "+++ b/tests/a.test.ts\n" +
      "@@ -1,2 +1,2 @@\n" +
      "-it('old', () => { expect(x).toBe(1); })\n" +
      "+it('new', () => { expect(x).toBe(2); })\n" +
      "+it('extra', () => { assert.ok(y); })\n";
    const clean = staged({ nameStatus: "M\ttests/a.test.ts\n", unifiedDiff: diff });
    assert.equal(clean.kind, "clean");
    assert.match(clean.investigation, /tests\/a\.test\.ts/);
    assert.match(clean.investigation, /assertion/i);

    const guard = staged({
      nameStatus: "M\ttests/other.test.ts\nD\tpkg/old_test.go\n",
      unifiedDiff: diff,
      attempt: 2,
    });
    assert.equal(guard.kind, "test-guard");
    assert.match(guard.investigation, /tests\/a\.test\.ts/);
    assert.match(guard.investigation, /assertion/i);
  });

  it("investigation lists the exact name-status test lines", () => {
    const r = staged({ nameStatus: "D\tpkg/old_test.go\nM\tsrc/a.ts\n" });
    assert.equal(r.kind, "test-guard");
    assert.match(r.investigation, /D\tpkg\/old_test\.go/);
  });

  it("buildFixTask for test-guard states the rule is enforced and carries name-status lines", () => {
    const original = "Implement ONE behavior: T1.";
    const classified = staged({ nameStatus: "D\tpkg/old_test.go\n" });
    assert.equal(classified.kind, "test-guard");

    const taskText = buildFixTask(BEHAVIOR, TASK, original, classified, 1);
    assert.match(taskText, /enforced/i);
    assert.match(taskText, /pkg\/old_test\.go/);
    assert.match(taskText, /Original task/);
  });
});

// ═══ T6/T2: commit path — auto-unstage cross-task contamination ═══

/** v2 contract: T1 owns src/mine.ts + tests/a.test.ts; T2 owns src/theirs.ts. */
const CONTAMINATION_CONTRACT: ContractV2 = {
  title: "Ownership Task",
  instruction: "shared context only",
  done: "green",
  sources: [
    { path: "src/mine.ts", status: "M", tasks: ["T1"] },
    { path: "src/theirs.ts", status: "M", tasks: ["T2"] },
  ],
  tests: [{ path: "tests/a.test.ts", status: "A", tasks: ["T1"] }],
  tasks: [
    { id: "T1", description: "mine", expectedOutput: ["lands the owned subset"], status: "active" },
    { id: "T2", description: "theirs", expectedOutput: ["lands later"], status: "active" },
  ],
};

/** One recorded git command with the stdout it returned. */
interface T6Call {
  cmd: string;
  args: string[];
  stdout: string;
}

/** The views the commit gate reads in a v2 session (T3). */
interface T6Fixture {
  /** `git diff --name-status --no-renames <baselineRef>` — the worktree teeth. */
  worktree?: string;
  /** `git diff --cached --name-status --no-renames <baselineRef>` — the staged set. */
  baseline?: string;
  /** `git diff --cached --name-status --no-renames HEAD` — the staged set. */
  head?: string;
  /** `git status --short`. */
  status?: string;
  /** `git ls-files --cached --others --exclude-standard` — the stageable paths. */
  lsFiles?: string;
}

/**
 * Exec mock for the T6/T2/T3 commit path: records every git command with its
 * stdout, advances HEAD on commit, serves the worktree-teeth, staged-baseline
 * and HEAD name-status views separately, answers `git status`/`git ls-files`
 * from the fixture, and honors `git restore --staged -- <path>` by dropping
 * that path from every name-status view.
 *
 * @param fixture - The gate's views (a plain string fills all name-status views).
 * @returns The mock ExtensionAPI plus the recorded call log.
 */
function piT6(fixture: string | T6Fixture): { pi: ExtensionAPI; calls: T6Call[] } {
  const fx: T6Fixture =
    typeof fixture === "string"
      ? { worktree: fixture, baseline: fixture, head: fixture }
      : fixture;
  const calls: T6Call[] = [];
  const restored = new Set<string>();
  let head = 0;
  const render = (raw: string) =>
    raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => !restored.has(line.split("\t")[1] ?? ""))
      .map((line) => `${line}\n`)
      .join("");
  const pi = {
    on: () => () => {},
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: () => {},
    sendUserMessage: () => {},
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read" }],
    setActiveTools: () => {},
    exec: (async (cmd: string, args: string[]) => {
      let stdout = "";
      if (cmd === "git" && args[0] === "rev-parse") stdout = `head${head}\n`;
      else if (cmd === "git" && args[0] === "restore") {
        restored.add(args[args.length - 1] ?? "");
      } else if (cmd === "git" && args[0] === "ls-files") stdout = fx.lsFiles ?? "";
      else if (cmd === "git" && args[0] === "status") stdout = fx.status ?? "";
      else if (cmd === "git" && args[0] === "diff" && args.includes("--name-status")) {
        if (!args.includes("--cached")) stdout = render(fx.worktree ?? "");
        else
          stdout = render(
            args[args.length - 1] === "HEAD" ? (fx.head ?? "") : (fx.baseline ?? ""),
          );
      } else if (cmd === "git" && args[0] === "commit") {
        head++;
        stdout = "[main t6] landed\n";
      }
      const result = { stdout, stderr: "", code: 0, killed: false };
      if (cmd === "git") calls.push({ cmd, args, stdout });
      return result;
    }),
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

/** Name-status reads recorded by the mock, in call order. */
function nameStatusReads(calls: T6Call[]): T6Call[] {
  return calls.filter((c) => c.args[0] === "diff" && c.args.includes("--name-status"));
}

describe("commitUnstagesCrossTaskContamination", () => {
  it("unstages other-task paths via git restore --staged, commits the owned subset, and reports the remediation note", async () => {
    const { pi, calls } = piT6("M\tsrc/mine.ts\nM\tsrc/theirs.ts\n");
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      "base123",
      CONTAMINATION_CONTRACT,
    );

    assert.equal(
      attempt.outcome,
      null,
      `expected the owned subset to land, got ${JSON.stringify(attempt.outcome)}`,
    );
    const restore = calls.find((c) => c.args[0] === "restore");
    assert.deepEqual(
      restore ? [restore.cmd, ...restore.args] : undefined,
      ["git", "restore", "--staged", "--", "src/theirs.ts"],
      "the contaminated path is unstaged with the exact remediation command",
    );
    assert.ok(
      calls.some((c) => c.args[0] === "commit"),
      "the owned subset still reaches git commit",
    );
    // The allowlist gate keeps measuring the baseline diff; contamination is
    // measured against HEAD; the staged diff is re-read after the unstage.
    const reads = nameStatusReads(calls);
    assert.equal(
      reads.length,
      4,
      "worktree teeth read, staged-set read, HEAD staged-set read, staged re-read after the unstage",
    );
    assert.deepEqual(
      reads[0]!.args,
      ["diff", "--name-status", "--no-renames", "base123"],
      "the allowlist check measures the WORKTREE against the baseline ref (teeth, T3)",
    );
    assert.match(reads[0]!.stdout, /src\/theirs\.ts/, "teeth: the worktree lists both changes");
    assert.deepEqual(
      reads[1]!.args,
      ["diff", "--cached", "--name-status", "--no-renames", "base123"],
      "the staged set is still measured against the baseline ref",
    );
    assert.deepEqual(
      reads[2]!.args,
      ["diff", "--cached", "--name-status", "--no-renames", "HEAD"],
      "contamination is measured against HEAD",
    );
    assert.match(reads[1]!.stdout, /src\/theirs\.ts/, "before: contamination is staged");
    assert.match(reads[2]!.stdout, /src\/theirs\.ts/, "before: contamination is staged vs HEAD");
    assert.doesNotMatch(reads[3]!.stdout, /src\/theirs\.ts/, "after: contamination is gone");
    assert.match(reads[3]!.stdout, /src\/mine\.ts/, "after: the owned path is still staged");
    // The attempt report carries the remediation note: path + owner task + command.
    const note = (attempt.remediation ?? []).join("\n");
    assert.match(note, /src\/theirs\.ts/, "the note names the unstaged path");
    assert.match(note, /T2/, "the note names the owner task");
    assert.match(
      note,
      /git restore --staged -- src\/theirs\.ts/,
      "the note carries the exact command",
    );
    assert.match(note, /stays on disk/, "the note states the work stays on disk");
  });
});

describe("committedSinceBaselineIsNotContamination (T2)", () => {
  it("never classifies a file committed since the baseline as contamination and emits no remediation line", async () => {
    // src/theirs.ts (owned by T2) changed since the baseline through a COMMIT:
    // it is in the baseline diff but not in `git diff --cached --name-only
    // HEAD`, so there is nothing to unstage — it must never be classified as
    // contamination and must never emit a remediation line.
    const { pi, calls } = piT6({
      baseline: "M\tsrc/mine.ts\nM\tsrc/theirs.ts\n",
      head: "M\tsrc/mine.ts\n",
    });
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      "base123",
      CONTAMINATION_CONTRACT,
    );

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    assert.ok(
      calls.some((c) => c.args[0] === "commit"),
      "the owned subset still reaches git commit",
    );
    assert.ok(
      !calls.some((c) => c.args[0] === "restore"),
      "a file committed since the baseline is never unstaged",
    );
    assert.equal(
      attempt.remediation,
      undefined,
      "no remediation line for a file committed since the baseline",
    );
    const reads = nameStatusReads(calls);
    assert.equal(
      reads.length,
      3,
      "teeth + staged baseline + HEAD; no post-unstage re-read without an unstage",
    );
    assert.deepEqual(
      reads[0]!.args,
      ["diff", "--name-status", "--no-renames", "base123"],
      "the allowlist check measures the WORKTREE against the baseline ref (teeth, T3)",
    );
    assert.deepEqual(
      reads[1]!.args,
      ["diff", "--cached", "--name-status", "--no-renames", "base123"],
      "the staged set is still measured against the baseline ref",
    );
    assert.match(
      reads[1]!.stdout,
      /src\/theirs\.ts/,
      "the baseline diff still lists the committed file",
    );
    assert.doesNotMatch(
      reads[2]!.stdout,
      /src\/theirs\.ts/,
      "the HEAD staged set does not — it is committed, not staged",
    );
  });
});

describe("commitStillHaltsOnOwnerlessStagedPath (T2)", () => {
  it("halts a staged path no task owns as undeclared before any unstage", async () => {
    // src/orphan.ts is declared but its refs name no owning task: the
    // allowlist passes it, yet nobody may commit it — the gate must halt as
    // undeclared before unstaging anything.
    const OWNERLESS_CONTRACT: ContractV2 = {
      title: "Ownership Task",
      instruction: "shared context only",
      done: "green",
      sources: [
        { path: "src/mine.ts", status: "M", tasks: ["T1"] },
        { path: "src/orphan.ts", status: "M", tasks: [] },
      ],
      tests: [{ path: "tests/a.test.ts", status: "A", tasks: ["T1"] }],
      tasks: [{ id: "T1", description: "mine", expectedOutput: ["lands the owned subset"], status: "active" }],
    };
    const { pi, calls } = piT6("M\tsrc/mine.ts\nM\tsrc/orphan.ts\n");
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      "base123",
      OWNERLESS_CONTRACT,
    );

    assert.equal(attempt.outcome?.kind, "contract-guard");
    const investigation = attempt.outcome?.investigation ?? "";
    assert.match(investigation, /src\/orphan\.ts/, "the ownerless path is named");
    assert.match(investigation, /no owning task/i, "the halt states the path has no owning task");
    assert.match(
      investigation,
      /\/discuss -> \/finalize/,
      "the contract-change hint is present",
    );
    assert.ok(
      !calls.some((c) => c.args[0] === "commit"),
      "git commit never runs on an ownerless path",
    );
    assert.ok(
      !calls.some((c) => c.args[0] === "restore"),
      "the halt happens before any unstage",
    );
    assert.equal(attempt.remediation, undefined, "no remediation note on a halting commit");
  });
});

describe("commitStillHaltsOnUndeclaredPath", () => {
  it("halts with the contract-change hint, never commits, and never unstages an undeclared path", async () => {
    const { pi, calls } = piT6("M\tsrc/mine.ts\nM\tsrc/nowhere.ts\n");
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      "base123",
      CONTAMINATION_CONTRACT,
    );

    assert.equal(attempt.outcome?.kind, "contract-guard");
    const investigation = attempt.outcome?.investigation ?? "";
    assert.match(investigation, /src\/nowhere\.ts/, "the undeclared path is named");
    assert.match(
      investigation,
      /\/discuss -> \/finalize/,
      "the contract-change hint is present",
    );
    assert.ok(
      !calls.some((c) => c.args[0] === "commit"),
      "git commit never runs on an undeclared path",
    );
    assert.ok(
      !calls.some((c) => c.args[0] === "restore"),
      "undeclared paths are never unstaged",
    );
    assert.equal(attempt.remediation, undefined, "no remediation note on a halting commit");
  });
});

describe("pathScopedRealRepoKeepsForeignWorkOutOfCommit (T3 A2)", () => {
  it("path-scoped staging keeps the foreign file out of the commit: no add --all, no restore, the work stays on disk", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-t3-pathscoped-"));
    const gitIn = (...args: string[]): string => {
      const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
      return (res.stdout ?? "").trim();
    };
    gitIn("init", "-q");
    gitIn("config", "user.email", "t3@test");
    gitIn("config", "user.name", "t3");
    gitIn("config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "mine.ts"), "mine v1\n");
    writeFileSync(join(repo, "src", "theirs.ts"), "theirs v1\n");
    gitIn("add", "--all");
    gitIn("commit", "-q", "-m", "chore: baseline");
    const baseline = gitIn("rev-parse", "HEAD");
    writeFileSync(join(repo, "src", "mine.ts"), "mine v2\n");
    writeFileSync(join(repo, "src", "theirs.ts"), "theirs v2\n");

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const execShim = async (
      command: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
      if (command === "git") calls.push({ cmd: command, args });
      const res = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
      return {
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        code: res.status ?? 1,
        killed: false,
      };
    };
    const attempt = await commitAndGate(
      { exec: execShim } as unknown as ExtensionAPI,
      repo,
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      baseline,
      CONTAMINATION_CONTRACT,
    );

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    assert.ok(
      !calls.some((c) => c.args[0] === "add" && c.args.includes("--all")),
      "never git add --all under a v2 contract",
    );
    assert.ok(
      calls.some(
        (c) => c.args[0] === "add" && c.args.includes("--") && c.args.includes("src/mine.ts"),
      ),
      "the unit's owned path is staged sole-path (git add -- <paths>)",
    );
    assert.ok(
      !calls.some((c) => c.args[0] === "restore"),
      "the foreign file is never staged, so nothing is ever unstaged",
    );
    assert.equal(attempt.remediation, undefined, "no remediation note: nothing was unstaged");
    // The foreign file survives on disk with the owning task's edits intact.
    assert.ok(existsSync(join(repo, "src", "theirs.ts")), "the file stays on disk");
    assert.equal(
      readFileSync(join(repo, "src", "theirs.ts"), "utf8"),
      "theirs v2\n",
      "the owning task's work is untouched",
    );
    // The commit carries only the committing task's paths.
    assert.equal(gitIn("show", "HEAD:src/mine.ts"), "mine v2");
    assert.equal(gitIn("show", "HEAD:src/theirs.ts"), "theirs v1", "foreign work is not committed");
    assert.match(
      gitIn("status", "--porcelain"),
      /^ ?M src\/theirs\.ts$/m,
      "the foreign path is an unstaged modification, not deleted",
    );
  });
});

// "Bug 1": the orchestrator-owned test extension vs the /implement baseline.
describe("orchestrator-owned test extension vs baseline (bug 1)", () => {
  /** A real temp repo whose test extension changed via a commit AFTER the baseline. */
  function repoWithPostBaselineChore(): {
    repo: string;
    baseline: string;
    gitIn: (...args: string[]) => string;
    pi: ExtensionAPI;
  } {
    const repo = mkdtempSync(join(tmpdir(), "pi-bug1-"));
    const gitIn = (...args: string[]): string => {
      const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
      return (res.stdout ?? "").trim();
    };
    gitIn("init", "-q");
    gitIn("config", "user.email", "bug1@test");
    gitIn("config", "user.name", "bug1");
    gitIn("config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(repo, "src", "mine.ts"), "mine v1\n");
    writeFileSync(join(repo, ".pi", "extensions", "test.ts"), "// generated v1\n");
    gitIn("add", "--all");
    gitIn("commit", "-q", "-m", "chore: baseline");
    const baseline = gitIn("rev-parse", "HEAD");
    // The orchestrator's start-of-run chore commit lands AFTER the baseline.
    writeFileSync(join(repo, ".pi", "extensions", "test.ts"), "// generated v2\n");
    gitIn("add", "--", ".pi/extensions/test.ts");
    gitIn("commit", "-q", "-m", "chore: regenerate test extension");
    // The unit's declared work.
    writeFileSync(join(repo, "src", "mine.ts"), "mine v2\n");
    const exec = async (command: string, args: string[]) => {
      const res = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
      return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? 1, killed: false };
    };
    return { repo, baseline, gitIn, pi: { exec } as unknown as ExtensionAPI };
  }

  it("lands the task commit when .pi/extensions/test.ts differs from the baseline only through a post-baseline commit", async () => {
    const { baseline, gitIn, pi, repo } = repoWithPostBaselineChore();
    const attempt = await commitAndGate(
      pi, repo, "feat(core): land T1", BEHAVIOR, TASK, 1, baseline, CONTAMINATION_CONTRACT,
    );
    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    assert.equal(gitIn("show", "HEAD:src/mine.ts"), "mine v2", "the task commit landed");
    assert.equal(gitIn("log", "-1", "--pretty=%s"), "feat(core): land T1");
  });

  it("still returns a contract-guard outcome naming .pi/extensions/test.ts when it is staged with changes against HEAD", async () => {
    const { baseline, gitIn, pi, repo } = repoWithPostBaselineChore();
    const headBefore = gitIn("rev-parse", "HEAD");
    writeFileSync(join(repo, ".pi", "extensions", "test.ts"), "// unit tampering\n");
    const attempt = await commitAndGate(
      pi, repo, "feat(core): land T1", BEHAVIOR, TASK, 1, baseline, CONTAMINATION_CONTRACT,
    );
    assert.equal(attempt.outcome?.kind, "contract-guard");
    const violations = (attempt.outcome as { violations: string[] }).violations.join("\n");
    assert.match(violations, /\.pi\/extensions\/test\.ts/, "the violation names the extension");
    assert.equal(gitIn("rev-parse", "HEAD"), headBefore, "nothing was committed");
  });

  it("filterOrchestratorOwned omits the test-extension line when the HEAD-relative staged set lacks it and keeps other lines verbatim", () => {
    const nameStatus = "M\t.pi/extensions/test.ts\nA\tsrc/mine.ts\nD\tsrc/old.ts\n";
    assert.equal(filterOrchestratorOwned(nameStatus, []), "A\tsrc/mine.ts\nD\tsrc/old.ts\n");
    assert.equal(
      filterOrchestratorOwned(nameStatus, [".pi/extensions/test.ts"]),
      nameStatus,
      "a HEAD-relative change keeps the line (a real unit change stays a violation)",
    );
    assert.equal(
      filterOrchestratorOwned("A\tsrc/mine.ts\n", []),
      "A\tsrc/mine.ts\n",
      "output without the extension line is untouched",
    );
  });
});

// ═══ T3: path-scoped staging (v2 sessions) ═══

describe("pathScopedStaging (T3 A1)", () => {
  it("stages only the unit's owned paths via git add -- <paths> and never git add --all", async () => {
    const { pi, calls } = piT6({
      worktree: "M\tsrc/mine.ts\n",
      baseline: "M\tsrc/mine.ts\n",
      head: "M\tsrc/mine.ts\n",
      status: " M src/mine.ts\n?? tests/a.test.ts\n",
      lsFiles: "src/mine.ts\ntests/a.test.ts\n",
    });
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      "base123",
      CONTAMINATION_CONTRACT,
    );

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    const adds = calls.filter((c) => c.args[0] === "add");
    assert.ok(adds.length > 0, "git add runs in a v2 session");
    assert.deepEqual(
      adds[0]!.args,
      ["add", "--", "src/mine.ts", "tests/a.test.ts"],
      "staged paths are the unit's owned scope, sources then tests",
    );
    assert.ok(
      !adds.some((c) => c.args.includes("--all")),
      "git add --all is never invoked under a v2 contract",
    );
  });
});

describe("pathScopedTeethKeepContractGuard (T3 A3)", () => {
  it("an owned path edited outside the allowlist raises contract-guard from the WORKTREE view and never commits", async () => {
    // src/rogue.ts is edited on disk but never staged: the index views below
    // never carry it, so only the worktree teeth can raise the halt.
    const { pi, calls } = piT6({
      worktree: "M\tsrc/mine.ts\nM\tsrc/rogue.ts\n",
      baseline: "M\tsrc/mine.ts\n",
      head: "M\tsrc/mine.ts\n",
      status: " M src/mine.ts\n M src/rogue.ts\n",
      lsFiles: "src/mine.ts\n",
    });
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      "base123",
      CONTAMINATION_CONTRACT,
    );

    assert.equal(attempt.outcome?.kind, "contract-guard", JSON.stringify(attempt.outcome));
    const investigation = attempt.outcome?.investigation ?? "";
    assert.match(investigation, /src\/rogue\.ts/, "the never-staged worktree edit is named");
    assert.match(investigation, /\/discuss -> \/finalize/, "the contract-change hint is present");
    assert.ok(
      !calls.some((c) => c.args[0] === "commit"),
      "git commit never runs on a worktree allowlist violation",
    );
  });
});

describe("v1SessionsStillStageAll (T3 A4)", () => {
  it("without a v2 contract commitAndGate falls back to git add --all", async () => {
    const { pi, calls } = piT6("M\tsrc/a.ts\n");
    const attempt = await commitAndGate(pi, "/tmp/test", "feat: x", BEHAVIOR, TASK, 1, "base123");

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    const add = calls.find((c) => c.args[0] === "add");
    assert.ok(add, "git add runs in a v1 session");
    assert.deepEqual(add!.args, ["add", "--all"], "v1 keeps the plain stage-all path");
  });
});

describe("emptyOwnedStagedSetIsNoChanges (T3 A5)", () => {
  it("a dirty foreign path with an empty owned staged set returns no-changes without invoking git commit", async () => {
    const { pi, calls } = piT6({
      worktree: "M\tsrc/theirs.ts\n",
      baseline: "",
      head: "",
      status: " M src/theirs.ts\n",
      lsFiles: "src/mine.ts\n",
    });
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      "base123",
      CONTAMINATION_CONTRACT,
    );

    assert.equal(attempt.outcome?.kind, "no-changes", JSON.stringify(attempt.outcome));
    assert.match(attempt.outcome?.investigation ?? "", /T1/, "the investigation names the behavior");
    assert.ok(
      !calls.some((c) => c.args[0] === "commit"),
      "git commit is never invoked on an empty owned staged set",
    );
    assert.ok(
      !calls.some((c) => c.args[0] === "add" && c.args.includes("--all")),
      "the foreign dirty file is never staged",
    );
    assert.equal(attempt.remediation, undefined, "no remediation note without an unstage");
  });
});

// ═══ T5: the slop gate in the commit path ═══

/** Blocking verdict a fake slop runner returns (mode hard). */
const BLOCK_VERDICT: SlopVerdict = {
  kind: "block",
  notes: [],
  violations: ["src/a.ts:3 slop-noise — flagged content"],
  investigation: "slop gate blocked: mode=hard, codeFailBelow=80, proseGate=25",
};

/**
 * Build a fake slop-gate runner that counts its invocations and returns the
 * fixed verdict on every run.
 *
 * @param verdict - The verdict returned by every run call.
 * @returns The runner (9th commitAndGate param) plus a live run counter.
 */
function fakeSlopRunner(verdict: SlopVerdict): { runner: SlopGateRunner; runs: () => number } {
  let count = 0;
  return {
    runner: {
      mode: verdict.kind === "block" ? "hard" : "advisory",
      run: async () => {
        count++;
        return verdict;
      },
    },
    runs: () => count,
  };
}

describe("commitAndGate slop gate (T5)", () => {
  it("a blocking slop verdict returns slop-guard with investigation and violations and never invokes git commit", async () => {
    const { pi, calls } = piT6("M\tsrc/a.ts\n");
    const { runner, runs } = fakeSlopRunner(BLOCK_VERDICT);

    const attempt = await commitAndGate(
      pi, "/tmp/test", "feat(core): land T1", BEHAVIOR, TASK, 1, "base123", undefined, runner,
    );

    const outcome = attempt.outcome;
    if (outcome?.kind !== "slop-guard") {
      assert.fail(`expected slop-guard, got ${JSON.stringify(attempt.outcome)}`);
    }
    assert.match(outcome.investigation, /slop gate blocked/, "the investigation rides the outcome");
    assert.ok(
      outcome.violations.some((v) => v.includes("src/a.ts")),
      `violations carry the flagged content, got ${JSON.stringify(outcome.violations)}`,
    );
    assert.equal(runs(), 1, "the slop runner runs exactly once");
    assert.ok(
      !calls.some((c) => c.args[0] === "commit"),
      "git commit is never invoked on a blocking slop verdict",
    );
  });

  it("an annotate slop verdict reaches git commit and returns the notes as slopNotes", async () => {
    const { pi, calls } = piT6("M\tsrc/a.ts\n");
    const notes = ["slop advisory: code score 42 is below codeFailBelow 80"];
    const { runner, runs } = fakeSlopRunner({ kind: "annotate", notes, violations: [], investigation: "" });

    const attempt = await commitAndGate(
      pi, "/tmp/test", "feat(core): land T1", BEHAVIOR, TASK, 1, "base123", undefined, runner,
    );

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    assert.equal(runs(), 1, "the slop runner runs once, before the commit");
    assert.ok(calls.some((c) => c.args[0] === "commit"), "git commit still runs for advisory notes");
    assert.deepEqual(attempt.slopNotes, notes, "the notes ride back as slopNotes");
  });

  it("the slop runner is not invoked when the staged-diff guard returns test-guard", async () => {
    // D of a declared test-kind sourceFile trips the staged-diff guard on any
    // attempt — the gate short-circuits before the slop runner and before git commit.
    const guardBehavior: Behavior = { ...BEHAVIOR, sourceFile: "tests/a.test.ts" };
    const guardTask: TaskContract = {
      title: "Guard Task",
      instruction: "delete a declared test",
      files: [{ path: "tests/a.test.ts", status: "D" }],
      done: "green",
      behaviors: [guardBehavior],
    };
    const { pi, calls } = piT6("D\ttests/a.test.ts\n");
    const { runner, runs } = fakeSlopRunner(BLOCK_VERDICT);

    const attempt = await commitAndGate(
      pi, "/tmp/test", "feat(core): land T1", guardBehavior, guardTask, 1, "base123", undefined, runner,
    );

    assert.equal(attempt.outcome?.kind, "test-guard", JSON.stringify(attempt.outcome));
    assert.equal(runs(), 0, "the staged-diff guard short-circuits before the slop runner");
    assert.ok(!calls.some((c) => c.args[0] === "commit"), "git commit is never invoked");
  });
});

describe("buildFixTask slop-guard (T5)", () => {
  it("includes the investigation, instructs removing the flagged slop, and forbids aislop-ignore directives", () => {
    const investigation =
      `${BLOCK_VERDICT.investigation}\nviolations=${BLOCK_VERDICT.violations.length}\n` +
      BLOCK_VERDICT.violations.join("\n");
    const outcome = {
      kind: "slop-guard" as const,
      investigation,
      violations: BLOCK_VERDICT.violations,
    };
    const original = "Implement ONE behavior: T1.\nDescription: first behavior";

    const taskText = buildFixTask(BEHAVIOR, TASK, original, outcome, 1);

    assert.ok(taskText.includes(investigation), "the outcome's investigation is carried verbatim");
    assert.match(taskText, /remove the flagged slop/i, "the fix instructs removing the flagged slop");
    assert.match(taskText, /aislop-ignore/, "the fix forbids adding aislop-ignore directives");
    assert.match(taskText, /Previous attempt failed \(retry 1\/5\)/, "budgeted retry header kept");
    assert.match(taskText, /Original task/, "the original task still rides the fix text");
  });
});

describe("retryExhaustedDetail (T5)", () => {
  it("returns the slop-guard text and keeps the hook-rejected and no-changes texts", () => {
    assert.equal(
      retryExhaustedDetail("slop-guard", "T1"),
      "slop gate blocked the commit for T1 after 5 retries",
    );
    assert.equal(
      retryExhaustedDetail("hook-rejected", "T1"),
      "pre-commit hook rejected the commit for T1 after 5 retries",
    );
    assert.equal(
      retryExhaustedDetail("no-changes", "T1"),
      "no changes detected for T1 after 5 retries",
    );
  });
});
