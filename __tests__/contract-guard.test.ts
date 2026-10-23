import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  checkToolAction,
  classifyBaselineDiff,
  formatDeclaredList,
  normalizeRepoPath,
} from "../extensions/contract-guard-core.ts";
import { commitAndGate } from "../extensions/git-ops.ts";
import {
  deriveDiagnosis,
  renderHaltReport,
  type AttemptRecord,
} from "../extensions/halt-report.ts";
import { runOrchestratedImplement } from "../extensions/implement-loop.ts";
import type { Behavior, TaskContract, WorkflowState } from "../extensions/state.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CWD = "/repo";

const BEHAVIOR: Behavior = {
  id: "T1",
  description: "first behavior",
  expectedOutput: "e1",
  kind: "test",
  status: "active",
};

const TASK: TaskContract = {
  title: "Guard Task",
  instruction: "do things",
  files: [
    { path: "src/new.ts", status: "A" },
    { path: "src/existing.ts", status: "M" },
    { path: "src/gone.ts", status: "D" },
  ],
  done: "all green",
  behaviors: [BEHAVIOR],
};

// ─── Pure core: checkToolAction ───────────────────────────────────────────────

describe("checkToolAction (T2)", () => {
  const check = (action: string, path: string) =>
    checkToolAction({ action, path, cwd: CWD, files: TASK.files });

  it("allows write on declared A and M paths", () => {
    assert.deepEqual(check("write", "src/new.ts"), { allowed: true });
    assert.deepEqual(check("write", "src/existing.ts"), { allowed: true });
  });

  it("allows edit on declared M and A paths", () => {
    assert.deepEqual(check("edit", "src/existing.ts"), { allowed: true });
    assert.deepEqual(check("edit", "src/new.ts"), { allowed: true });
  });

  it("allows delete_file only on declared D paths", () => {
    assert.deepEqual(check("delete_file", "src/gone.ts"), { allowed: true });
    const onM = check("delete_file", "src/existing.ts");
    assert.equal(onM.allowed, false, "delete_file on a declared M path is blocked");
    const onA = check("delete_file", "src/new.ts");
    assert.equal(onA.allowed, false, "delete_file on a declared A path is blocked");
  });

  it("blocks write and edit on declared D paths", () => {
    const write = check("write", "src/gone.ts");
    assert.equal(write.allowed, false);
    const edit = check("edit", "src/gone.ts");
    assert.equal(edit.allowed, false);
    if (edit.allowed) return;
    assert.match(edit.reason, /declared as D/i);
    assert.match(edit.reason, /src\/new\.ts \(A\)/, "reason lists declared files");
  });

  it("blocks undeclared paths and lists the declared files with statuses", () => {
    const result = check("write", "secrets.env");
    assert.equal(result.allowed, false);
    if (result.allowed) return;
    assert.match(result.reason, /secrets\.env/);
    assert.match(result.reason, /not declared/i);
    assert.match(result.reason, /src\/new\.ts \(A\)/);
    assert.match(result.reason, /src\/existing\.ts \(M\)/);
    assert.match(result.reason, /src\/gone\.ts \(D\)/);
    assert.match(
      result.reason,
      /\/discuss -> \/finalize/,
      "reason says a contract change needs /discuss -> /finalize",
    );
  });

  it("blocks any path under .git/", () => {
    for (const path of [
      ".git/config",
      "./.git/hooks/pre-commit",
      "src/../.git/objects/ab/cd",
      `${CWD}/.git/index`,
    ]) {
      const result = check("write", path);
      assert.equal(result.allowed, false, `${path} must be blocked`);
      if (result.allowed) continue;
      assert.match(result.reason, /\.git\//);
    }
  });

  it("blocks paths that resolve outside the repository", () => {
    const result = check("write", "../outside.ts");
    assert.equal(result.allowed, false);
    if (result.allowed) return;
    assert.match(result.reason, /outside the repository/);
  });

  it("normalizes ./ ../ and absolute paths before matching the allowlist", () => {
    assert.deepEqual(check("edit", "./src/existing.ts"), { allowed: true });
    assert.deepEqual(check("edit", "src/nested/../existing.ts"), { allowed: true });
    assert.deepEqual(check("write", `${CWD}/src/new.ts`), { allowed: true });
  });

  it("fails closed on an unknown action", () => {
    const result = check("bash", "src/new.ts");
    assert.equal(result.allowed, false);
  });
});

describe("normalizeRepoPath (T2)", () => {
  it("returns a repo-relative POSIX path", () => {
    const result = normalizeRepoPath("src/./a.ts", CWD);
    assert.deepEqual(result, { ok: true, path: "src/a.ts" });
  });

  it("blocks the .git directory itself and a file named like a git dir sibling", () => {
    assert.equal(normalizeRepoPath(".git", CWD).ok, false);
    assert.equal(normalizeRepoPath(".gitignore", CWD).ok, true);
  });
});

describe("formatDeclaredList (T2)", () => {
  it("joins path (STATUS) items", () => {
    assert.equal(
      formatDeclaredList(TASK.files),
      "src/new.ts (A), src/existing.ts (M), src/gone.ts (D)",
    );
  });
  it("renders an explicit placeholder for an empty allowlist", () => {
    assert.equal(formatDeclaredList([]), "(no files declared)");
  });
});

// ─── Pure core: classifyBaselineDiff ─────────────────────────────────────────

describe("classifyBaselineDiff (T2)", () => {
  const classify = (nameStatus: string) =>
    classifyBaselineDiff({ nameStatus, files: TASK.files, baselineRef: "base123" });

  it("clean when every staged path is declared with exactly that status", () => {
    const result = classify(
      "A\tsrc/new.ts\nM\tsrc/existing.ts\nD\tsrc/gone.ts\n",
    );
    assert.deepEqual(result.violations, []);
  });

  it("flags an undeclared path", () => {
    const result = classify("M\tsecrets.env\n");
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /secrets\.env/);
    assert.match(result.violations[0]!, /undeclared/i);
  });

  it("flags a status mismatch: declared A but staged M", () => {
    const result = classify("M\tsrc/new.ts\n");
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /src\/new\.ts/);
    assert.match(result.violations[0]!, /staged as M/i);
    assert.match(result.violations[0]!, /declared A/);
  });

  it("flags a status mismatch: declared M but staged D", () => {
    const result = classify("D\tsrc/existing.ts\n");
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /src\/existing\.ts/);
  });

  it("flags any staged path under .git/ even when declared", () => {
    const files = [{ path: ".git/config", status: "M" as const }];
    const result = classifyBaselineDiff({ nameStatus: "M\t.git/config\n", files });
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]!, /\.git\//);
  });

  it("investigation carries the baseline ref, name-status lines, declared list and the finalize path", () => {
    const result = classify("M\tsecrets.env\n");
    assert.match(result.investigation, /base123/);
    assert.match(result.investigation, /M\tsecrets\.env/);
    assert.match(result.investigation, /src\/new\.ts \(A\)/);
    assert.match(result.investigation, /\/discuss -> \/finalize/);
  });
});

// ─── Commit gate: contract-guard outcome ─────────────────────────────────────

interface ExecLogEntry {
  cmd: string;
  args: string[];
}

function mockPi(): ExtensionAPI & { calls: Record<string, unknown[]> } {
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
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read" }],
    setActiveTools: record("setActiveTools") as ExtensionAPI["setActiveTools"],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    calls,
  } as unknown as ExtensionAPI & { calls: typeof calls };
}

/** Exec mock: records every call; name-status output comes from the fixture. */
function piWithStaged(nameStatus: string) {
  const pi = mockPi();
  const execLog: ExecLogEntry[] = [];
  let headCounter = 0;
  pi.exec = (async (cmd: string, args: string[]) => {
    execLog.push({ cmd, args });
    if (cmd === "git" && args[0] === "rev-parse") {
      return { stdout: `head${headCounter}\n`, stderr: "", code: 0, killed: false };
    }
    if (cmd === "git" && args[0] === "diff" && args.includes("--name-status")) {
      return { stdout: nameStatus, stderr: "", code: 0, killed: false };
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
  return { pi, execLog };
}

function ctxWithState(state: WorkflowState | null): ExtensionContext {
  return {
    cwd: "/tmp/test",
    sessionManager: {
      getBranch: () =>
        state
          ? [{ type: "custom", customType: "workflow-state", data: state }]
          : [],
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

describe("commitAndGate contract-guard outcome (T2)", () => {
  it("returns contract-guard without invoking git commit when the staged diff violates the allowlist", async () => {
    const { pi, execLog } = piWithStaged("M\tsecrets.env\n");
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): add first behavior",
      BEHAVIOR,
      TASK,
      1,
      "base123",
    );
    assert.equal(attempt.outcome?.kind, "contract-guard");
    assert.ok(attempt.outcome);
    assert.match(JSON.stringify(attempt.outcome), /secrets\.env/);
    assert.ok(
      !execLog.some((e) => e.cmd === "git" && e.args[0] === "commit"),
      "git commit must never run when the allowlist is violated",
    );
  });

  it("measures the staged diff against baselineHead with --no-renames", async () => {
    const { pi, execLog } = piWithStaged("");
    await commitAndGate(pi, "/tmp/test", "feat: x", BEHAVIOR, TASK, 1, "base123");
    const nameStatus = execLog.find(
      (e) => e.cmd === "git" && e.args[0] === "diff" && e.args.includes("--name-status"),
    );
    assert.ok(nameStatus, "the name-status diff runs");
    assert.deepEqual(nameStatus.args, [
      "diff",
      "--cached",
      "--name-status",
      "--no-renames",
      "base123",
    ]);
  });

  it("falls back to HEAD when no baseline was recorded", async () => {
    const { pi, execLog } = piWithStaged("");
    await commitAndGate(pi, "/tmp/test", "feat: x", BEHAVIOR, TASK, 1, undefined);
    const nameStatus = execLog.find(
      (e) => e.cmd === "git" && e.args[0] === "diff" && e.args.includes("--name-status"),
    );
    assert.ok(nameStatus);
    assert.equal(nameStatus.args[nameStatus.args.length - 1], "HEAD");
  });

  it("stages nothing else: the unified diff and commit still run for a clean allowlist", async () => {
    const { pi, execLog } = piWithStaged("A\tsrc/new.ts\nM\tsrc/existing.ts\n");
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): add first behavior",
      BEHAVIOR,
      TASK,
      1,
      "base123",
    );
    assert.equal(attempt.outcome, null);
    assert.equal(attempt.subject, "feat(core): add first behavior");
    assert.ok(
      execLog.some((e) => e.cmd === "git" && e.args[0] === "commit"),
      "a clean allowlist reaches git commit",
    );
  });

  it("returns contract-guard for a status mismatch (declared M, staged D)", async () => {
    const { pi, execLog } = piWithStaged("D\tsrc/existing.ts\n");
    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat: x",
      BEHAVIOR,
      TASK,
      1,
      "base123",
    );
    assert.equal(attempt.outcome?.kind, "contract-guard");
    assert.ok(
      !execLog.some((e) => e.cmd === "git" && e.args[0] === "commit"),
      "git commit must never run on a status mismatch",
    );
  });
});

// ─── behavior-loop halts on contract-guard ───────────────────────────────────

describe("behavior-loop halts on contract-guard (T2)", () => {
  it("halts with the contract-guard diagnosis and never commits", async () => {
    const { pi, execLog } = piWithStaged("M\tsecrets.env\n");
    const state: WorkflowState = {
      phase: "finalizing",
      specText: "topic",
      task: TASK,
      baselineHead: "base123",
    };
    const ctx = ctxWithState(state);
    const spawns: string[] = [];

    const result = await runOrchestratedImplement(
      pi,
      ctx,
      state,
      state.task!,
      async (unit) => {
        spawns.push(unit.behaviorId);
        return { summary: "implemented", suggestedCommit: "feat(core): add first behavior" };
      },
    );

    assert.equal(result.complete, false);
    assert.equal(result.haltedOn, "T1");
    assert.equal(spawns.length, 1, "no fix subagent on contract-guard");
    assert.ok(
      !execLog.some((e) => e.cmd === "git" && e.args[0] === "commit"),
      "git commit must never run when the allowlist is violated",
    );
    const last = result.attempts![result.attempts!.length - 1]!;
    assert.equal(last.outcome, "contract-guard", "the verdict seals the last attempt");
    assert.match(result.error ?? "", /allowlist/i);
    assert.equal(
      result.diagnosis,
      "staged diff violates the declared file allowlist",
      "the halt carries the distinct contract-guard diagnosis",
    );
    assert.match(result.recommendation ?? "", /\/discuss -> \/finalize/);
    assert.match(
      renderHaltReport({
        haltedOn: result.haltedOn,
        error: result.error,
        commits: [],
        attempts: result.attempts,
        diagnosis: result.diagnosis,
        recommendation: result.recommendation,
      }),
      /Diagnosis: staged diff violates the declared file allowlist/,
      "halt-report shows the contract-guard diagnosis",
    );
  });
});

// ─── Halt-report diagnosis ───────────────────────────────────────────────────

describe("deriveDiagnosis contract-guard (T2)", () => {
  const attempt = (outcome: AttemptRecord["outcome"]): AttemptRecord => ({
    attempt: 1,
    outcome,
    durationSec: 1,
    progress: true,
    lastText: "summary",
  });

  it("derives the distinct contract-guard diagnosis", () => {
    const diagnosis = deriveDiagnosis([attempt("contract-guard")], "");
    assert.equal(diagnosis.diagnosis, "staged diff violates the declared file allowlist");
    assert.match(diagnosis.recommendation, /\/discuss -> \/finalize/);
    assert.match(diagnosis.recommendation, /files/);
  });

  it("keeps the contract-guard diagnosis separate from the test-guard diagnosis", () => {
    const diagnosis = deriveDiagnosis(
      [attempt("test-guard"), attempt("contract-guard")],
      "",
    );
    assert.equal(diagnosis.diagnosis, "staged diff violates the declared file allowlist");
    const testGuardOnly = deriveDiagnosis([attempt("test-guard")], "");
    assert.match(testGuardOnly.diagnosis, /staged-diff guard/);
    assert.doesNotMatch(testGuardOnly.diagnosis, /declared file allowlist/);
  });
});
