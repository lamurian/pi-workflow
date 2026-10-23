import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
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

// ═══════════════════════════════════════════════════════════════════════════════
// T3 — bash-free units: child guard extension, delete_file, guard file
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildImplementerArgs (T3 bash-free units)", () => {
  it("loads the contract-guard extension via --no-extensions -e <absolute path>", async () => {
    delete process.env.PI_IMPLEMENTER_TOOLS;
    const { buildImplementerArgs, contractGuardExtensionPath } = await import(
      "../extensions/implementer-report.ts"
    );
    const args = buildImplementerArgs("sys");
    assert.ok(args.includes("--no-extensions"), "--no-extensions stays");
    const idx = args.indexOf("-e");
    assert.notEqual(idx, -1, "-e must load the child contract-guard extension");
    const guardPath = args[idx + 1]!;
    assert.ok(isAbsolute(guardPath), "the -e path is absolute");
    assert.equal(guardPath, contractGuardExtensionPath());
    assert.ok(
      guardPath.split(sep).join("/").endsWith("extensions/contract-guard/index.ts"),
      `-e points at extensions/contract-guard/index.ts, got ${guardPath}`,
    );
    assert.ok(existsSync(guardPath), "the guard extension file exists on disk");
  });

  it("defaults --tools to read,write,edit,grep,find,ls,delete_file with no bash", async () => {
    delete process.env.PI_IMPLEMENTER_TOOLS;
    const { buildImplementerArgs } = await import("../extensions/implementer-report.ts");
    const args = buildImplementerArgs("sys");
    const idx = args.indexOf("--tools");
    assert.notEqual(idx, -1, "--tools should be present");
    assert.equal(args[idx + 1], "read,write,edit,grep,find,ls,delete_file");
    assert.doesNotMatch(args[idx + 1]!, /bash/, "units are shell-free");
  });
});

// ─── Guard file: written by the orchestrator before each spawn ──────────────

describe("contract-guard file (T3)", () => {
  it("writes .git/pi-workflow/contract-guard.json with the allowlist and baselineExisting", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-guard-file-"));
    const execLog: Array<{ cmd: string; args: string[] }> = [];
    const pi = mockPi();
    pi.exec = (async (cmd: string, args: string[]) => {
      execLog.push({ cmd, args });
      if (cmd === "git" && args[0] === "ls-tree") {
        return { stdout: "src/existing.ts\nsrc/gone.ts\n", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExtensionAPI["exec"];

    const { writeContractGuardFile, contractGuardFilePath } = await import(
      "../extensions/contract-guard-file.ts"
    );
    const guardPath = await writeContractGuardFile(pi, tmp, TASK.files, "base123");

    assert.equal(guardPath, contractGuardFilePath(tmp));
    assert.equal(
      guardPath.split(sep).join("/"),
      `${tmp.split(sep).join("/")}/.git/pi-workflow/contract-guard.json`,
    );
    const payload = JSON.parse(readFileSync(guardPath, "utf8")) as Record<string, unknown>;
    assert.equal(payload.repoRoot, tmp);
    assert.equal(payload.baselineHead, "base123");
    assert.deepEqual(payload.files, TASK.files);
    assert.deepEqual(
      payload.baselineExisting,
      ["src/existing.ts", "src/gone.ts"],
      "baselineExisting comes from git ls-tree at the baseline",
    );
    const lsTree = execLog.find((e) => e.cmd === "git" && e.args[0] === "ls-tree");
    assert.ok(lsTree, "the orchestrator queries the baseline tree");
    assert.deepEqual(
      lsTree.args,
      ["ls-tree", "-r", "--name-only", "base123", "--", "src/new.ts", "src/existing.ts", "src/gone.ts"],
    );
  });

  it("spawns the unit with PI_CONTRACT_GUARD_FILE in its env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-guard-spawn-"));
    const capture = join(dir, "capture.txt");
    const fake = join(dir, "fake-pi.sh");
    writeFileSync(
      fake,
      "#!/bin/sh\n" +
        `printf 'GUARD:%s\\n' "$PI_CONTRACT_GUARD_FILE" > "${capture}"\n` +
        "while IFS= read -r line; do :; done\nexit 0\n",
    );
    chmodSync(fake, 0o755);
    const prev = process.env.PI_BIN;
    process.env.PI_BIN = fake;
    try {
      const { spawnRpcUnitClient } = await import("../extensions/rpc-unit-client.ts");
      const client = spawnRpcUnitClient({
        systemPrompt: "sys",
        cwd: dir,
        env: { PI_CONTRACT_GUARD_FILE: join(dir, "guard.json") },
      });
      try {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && !existsSync(capture)) {
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.ok(existsSync(capture), "the fake pi must observe its env");
        assert.equal(
          readFileSync(capture, "utf8").trim(),
          `GUARD:${join(dir, "guard.json")}`,
          "PI_CONTRACT_GUARD_FILE reaches the child process env",
        );
      } finally {
        await client.shutdown(200);
      }
    } finally {
      if (prev === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prev;
    }
  });
});

// ─── The child guard extension's tool_call hook ─────────────────────────────

/** Valid guard payload written to a temp file for hook tests. */
function writeGuardFile(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-guard-ext-"));
  const file = join(dir, "contract-guard.json");
  writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload));
  return file;
}

/** Load the guard extension against a mock pi; return the tool_call hook and tools. */
async function loadGuardExtension(guardFile?: string): Promise<{
  hook: (event: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | undefined>;
  tools: Array<{ name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }>;
}> {
  const mod = await import("../extensions/contract-guard/index.ts");
  const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
  const tools: Array<Record<string, unknown>> = [];
  const pi = {
    on: (name: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, handler);
      return () => {};
    },
    registerTool: (tool: Record<string, unknown>) => {
      tools.push(tool);
    },
  };
  const env = guardFile ? { PI_CONTRACT_GUARD_FILE: guardFile } : {};
  mod.createContractGuardExtension(env)(pi as never);
  return {
    hook: handlers.get("tool_call") as (event: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | undefined>,
    tools: tools as never,
  };
}

const GUARD_PAYLOAD = {
  repoRoot: CWD,
  baselineHead: "base123",
  files: [
    { path: "src/new.ts", status: "A" },
    { path: "src/existing.ts", status: "M" },
    { path: "src/gone.ts", status: "D" },
  ],
  baselineExisting: ["src/existing.ts", "src/gone.ts"],
};

/** Build a tool_call event. */
function toolCall(toolName: string, path?: string): Record<string, unknown> {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName,
    input: path === undefined ? {} : { path },
  };
}

describe("contract-guard extension hook (T3)", () => {
  it("passes read, grep, find and ls through", async () => {
    const { hook } = await loadGuardExtension(writeGuardFile(GUARD_PAYLOAD));
    for (const toolName of ["read", "grep", "find", "ls"]) {
      assert.equal(
        await hook(toolCall(toolName, "secrets.env")),
        undefined,
        `${toolName} must pass the guard`,
      );
    }
  });

  it("allows write/edit on declared A/M paths and delete_file on declared D", async () => {
    const { hook } = await loadGuardExtension(writeGuardFile(GUARD_PAYLOAD));
    assert.equal(await hook(toolCall("write", "src/new.ts")), undefined);
    assert.equal(await hook(toolCall("write", "src/existing.ts")), undefined);
    assert.equal(await hook(toolCall("edit", "src/existing.ts")), undefined);
    assert.equal(await hook(toolCall("edit", "src/new.ts")), undefined);
    assert.equal(await hook(toolCall("delete_file", "src/gone.ts")), undefined);
  });

  it("blocks write/edit/delete_file on disallowed paths with the declared list", async () => {
    const { hook } = await loadGuardExtension(writeGuardFile(GUARD_PAYLOAD));
    const undeclared = await hook(toolCall("write", "secrets.env"));
    assert.equal(undeclared?.block, true);
    assert.match(undeclared?.reason ?? "", /secrets\.env/);
    assert.match(undeclared?.reason ?? "", /src\/new\.ts \(A\)/);
    assert.match(undeclared?.reason ?? "", /src\/existing\.ts \(M\)/);
    assert.match(undeclared?.reason ?? "", /src\/gone\.ts \(D\)/);
    assert.match(undeclared?.reason ?? "", /\/discuss -> \/finalize/);

    const editOnD = await hook(toolCall("edit", "src/gone.ts"));
    assert.equal(editOnD?.block, true, "edit on a declared D path is blocked");
    const deleteOnM = await hook(toolCall("delete_file", "src/existing.ts"));
    assert.equal(deleteOnM?.block, true, "delete_file requires a declared D path");
  });

  it("blocks bash even when it is granted to the unit", async () => {
    const { hook } = await loadGuardExtension(writeGuardFile(GUARD_PAYLOAD));
    const result = await hook(toolCall("bash", "src/new.ts"));
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /bash/);
  });

  it("blocks any unknown tool", async () => {
    const { hook } = await loadGuardExtension(writeGuardFile(GUARD_PAYLOAD));
    for (const toolName of ["commit_changes", "mark_task_done", "run_tests", "totally_unknown"]) {
      const result = await hook(toolCall(toolName, "src/new.ts"));
      assert.equal(result?.block, true, `${toolName} must be blocked`);
    }
  });

  it("fails closed on all mutating tools when the guard file is missing", async () => {
    const { hook } = await loadGuardExtension(undefined);
    for (const [toolName, path] of [
      ["write", "src/new.ts"],
      ["edit", "src/existing.ts"],
      ["delete_file", "src/gone.ts"],
    ] as const) {
      const result = await hook(toolCall(toolName, path));
      assert.equal(result?.block, true, `${toolName} must fail closed`);
      assert.match(result?.reason ?? "", /missing or invalid/i);
    }
    assert.equal(await hook(toolCall("read", "src/new.ts")), undefined, "read still passes");
    assert.equal((await hook(toolCall("bash")))?.block, true, "bash stays blocked");
  });

  it("fails closed when the guard file path does not exist or is invalid", async () => {
    const missing = join(tmpdir(), "pi-guard-definitely-missing.json");
    const { hook: missingHook } = await loadGuardExtension(missing);
    assert.equal((await missingHook(toolCall("write", "src/new.ts")))?.block, true);

    const { hook: brokenHook } = await loadGuardExtension(writeGuardFile("{not json"));
    assert.equal((await brokenHook(toolCall("write", "src/new.ts")))?.block, true);

    const badStatus = { ...GUARD_PAYLOAD, files: [{ path: "src/new.ts", status: "NEW" }] };
    const { hook: badShapeHook } = await loadGuardExtension(writeGuardFile(badStatus));
    assert.equal((await badShapeHook(toolCall("write", "src/new.ts")))?.block, true);

    const noRoot = { files: GUARD_PAYLOAD.files };
    const { hook: noRootHook } = await loadGuardExtension(writeGuardFile(noRoot));
    assert.equal((await noRootHook(toolCall("write", "src/new.ts")))?.block, true);
  });
});

describe("delete_file tool (T3)", () => {
  it("removes a declared-D file from disk", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-delete-file-"));
    const target = join(tmp, "gone.ts");
    writeFileSync(target, "// to be deleted\n");
    const { tools } = await loadGuardExtension(writeGuardFile(GUARD_PAYLOAD));
    const del = tools.find((t) => t.name === "delete_file");
    assert.ok(del, "the guard extension registers delete_file");
    const res = await del.execute("call-1", { path: "gone.ts" }, undefined, undefined, { cwd: tmp });
    assert.equal(res.isError ?? false, false, JSON.stringify(res));
    assert.ok(!existsSync(target), "the declared-D file must be gone");
  });

  it("reports an error when the file does not exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-delete-file-"));
    const { tools } = await loadGuardExtension(writeGuardFile(GUARD_PAYLOAD));
    const del = tools.find((t) => t.name === "delete_file")!;
    const res = await del.execute("call-1", { path: "missing.ts" }, undefined, undefined, { cwd: tmp });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /delete_file failed/);
  });
});

// ─── unit-prompt.md: bash-free rewrite ──────────────────────────────────────

describe("unit-prompt.md (T3)", () => {
  it("has no shell, sandbox-blocks or blockedCommands instructions", async () => {
    const { loadContent } = await import("../extensions/utils.ts");
    const text = await loadContent("unit-prompt.md");
    assert.doesNotMatch(text, /bash/i, "the unit prompt must not mention bash");
    assert.doesNotMatch(text, /Sandbox blocks/i, "the Sandbox blocks section is gone");
    assert.doesNotMatch(text, /blockedCommands/, "blockedCommands is out of the report format");
    assert.doesNotMatch(text, /mustRunNow/, "mustRunNow is out of the report format");
    assert.doesNotMatch(text, /command-based self-check/i, "no command-based self-check");
    assert.doesNotMatch(text, /Self-check test runs/i, "no command-based self-check");
  });

  it("explains the allowlist, delete_file and orchestrator-owned verification", async () => {
    const { loadContent } = await import("../extensions/utils.ts");
    const text = await loadContent("unit-prompt.md");
    assert.match(text, /allowlist/i, "the allowlist is explained");
    assert.match(text, /delete_file/, "delete_file is explained");
    assert.match(text, /\/discuss -> \/finalize/, "the contract-change path is named");
    assert.match(text, /pre-commit hook/i, "verification is the orchestrator's hook run");
    assert.match(text, /steers?/i, "hook results arrive as steers");
    assert.match(text, /`read`/, "the tool list is stated");
    assert.match(text, /`write`/, "the tool list is stated");
    assert.match(text, /`edit`/, "the tool list is stated");
  });
});

// ─── The default runner writes the guard file before spawning ───────────────

describe("orchestrator spawn wiring (T3)", () => {
  it("writes the guard file and spawns the default unit with PI_CONTRACT_GUARD_FILE", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-guard-loop-"));
    const capture = join(tmp, "env-capture.txt");
    const fake = join(tmp, "fake-pi.sh");
    writeFileSync(
      fake,
      "#!/bin/sh\n" +
        `printf 'GUARD:%s\\n' "$PI_CONTRACT_GUARD_FILE" > "${capture}"\n` +
        "while IFS= read -r line; do\n" +
        "  case \"$line\" in\n" +
        "    *'\"type\":\"prompt\"'*)\n" +
        "      printf '%s\\n' \"{\\\"type\\\":\\\"message_end\\\",\\\"message\\\":{\\\"role\\\":\\\"assistant\\\",\\\"content\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"ok \\`\\`\\`json {\\\\\\\"summary\\\\\\\":\\\\\\\"guarded unit\\\\\\\",\\\\\\\"suggestedCommit\\\\\\\":\\\\\\\"feat(core): add first behavior\\\\\\\"} \\`\\`\\`\\\"}]}}\"\n" +
        "      ;;\n" +
        "    *'\"type\":\"abort\"'*) exit 0 ;;\n" +
        "  esac\n" +
        "done\nexit 0\n",
    );
    chmodSync(fake, 0o755);
    const prev = process.env.PI_BIN;
    process.env.PI_BIN = fake;
    try {
      const { pi, execLog } = piWithStaged("");
      const taskCopy: TaskContract = {
        ...TASK,
        files: TASK.files.map((f) => ({ ...f })),
        behaviors: [{ ...BEHAVIOR }],
      };
      const state: WorkflowState = {
        phase: "finalizing",
        specText: "topic",
        task: taskCopy,
        baselineHead: "base123",
      };
      const ctx = { ...ctxWithState(state), cwd: tmp } as ExtensionContext;

      const result = await runOrchestratedImplement(pi, ctx, state, taskCopy);

      assert.equal(result.complete, true, result.error ?? "");
      const guardPath = join(tmp, ".git", "pi-workflow", "contract-guard.json");
      assert.ok(existsSync(guardPath), "the orchestrator wrote the guard file");
      const payload = JSON.parse(readFileSync(guardPath, "utf8")) as Record<string, unknown>;
      assert.equal(payload.repoRoot, tmp);
      assert.equal(payload.baselineHead, "base123");
      assert.deepEqual(payload.files, taskCopy.files);
      assert.ok(
        execLog.some((e) => e.cmd === "git" && e.args[0] === "ls-tree"),
        "baselineExisting is queried via git ls-tree at the baseline",
      );
      assert.equal(
        readFileSync(capture, "utf8").trim(),
        `GUARD:${guardPath}`,
        "the unit child receives PI_CONTRACT_GUARD_FILE",
      );
    } finally {
      if (prev === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prev;
    }
  });
});
