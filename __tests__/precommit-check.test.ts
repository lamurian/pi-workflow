import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRECOMMIT_OUTPUT_TAIL,
  formatPrecommitResult,
  isPrecommitHookPresent,
  registerPrecommitCheckTool,
  runPrecommitCheck,
} from "../extensions/precommit-check.ts";
import { getCommitTimeoutMs } from "../extensions/git-ops.ts";
import { DISCUSS_BLOCKED_TOOLS } from "../extensions/tools.ts";
import { loadContent } from "../extensions/utils.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "../extensions/state.ts";

interface ExecCall {
  cmd: string;
  args: string[];
  options?: { cwd?: string; timeout?: number };
}

function mockPi(
  execImpl: (cmd: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>,
): ExtensionAPI & { execLog: ExecCall[]; tools: Array<{ name: string; execute: Function }> } {
  const execLog: ExecCall[] = [];
  const tools: Array<{ name: string; execute: Function }> = [];
  return {
    exec: async (cmd: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      execLog.push({ cmd, args, options });
      return execImpl(cmd, args, options);
    },
    registerTool: (def: { name: string; execute: Function }) => {
      tools.push(def);
    },
    execLog,
    tools,
  } as unknown as ExtensionAPI & {
    execLog: ExecCall[];
    tools: Array<{ name: string; execute: Function }>;
  };
}

function ctxWithState(state: WorkflowState | null, cwd = "/tmp/test"): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getBranch: () =>
        state ? [{ type: "custom", customType: "workflow-state", data: state }] : [],
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setTitle: () => {}, theme: { fg: (_c: string, t: string) => t } },
  } as unknown as ExtensionContext;
}

function implementingState(): WorkflowState {
  return { phase: "implementing", specText: "t" };
}

// ─── hook presence ────────────────────────────────────────────────────────────

describe("isPrecommitHookPresent", () => {
  it("true when the hooks/pre-commit path exists and is executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-hook-"));
    try {
      const hook = join(dir, ".git", "hooks", "pre-commit");
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      writeFileSync(hook, "#!/bin/sh\n");
      chmodSync(hook, 0o755);
      const pi = mockPi(async () => ({
        stdout: join(dir, ".git", "hooks", "pre-commit") + "\n",
        stderr: "",
        code: 0,
        killed: false,
      }));
      assert.equal(await isPrecommitHookPresent(pi, dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false when the hook path is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-nohook-"));
    try {
      const pi = mockPi(async () => ({
        stdout: join(dir, ".git", "hooks", "pre-commit") + "\n",
        stderr: "",
        code: 0,
        killed: false,
      }));
      assert.equal(await isPrecommitHookPresent(pi, dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false when the hook exists but is not executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-noexec-"));
    try {
      const hook = join(dir, ".git", "hooks", "pre-commit");
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      writeFileSync(hook, "#!/bin/sh\n");
      chmodSync(hook, 0o644);
      const pi = mockPi(async () => ({
        stdout: join(dir, ".git", "hooks", "pre-commit") + "\n",
        stderr: "",
        code: 0,
        killed: false,
      }));
      assert.equal(await isPrecommitHookPresent(pi, dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false when git rev-parse fails", async () => {
    const pi = mockPi(async () => ({ stdout: "", stderr: "not a git repo", code: 128, killed: false }));
    assert.equal(await isPrecommitHookPresent(pi, "/tmp"), false);
  });
});

// ─── runPrecommitCheck ────────────────────────────────────────────────────────

describe("runPrecommitCheck", () => {
  it("runs git add --all then git hook run --ignore-missing pre-commit via pi.exec with PI_COMMIT_TIMEOUT_MS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-run-"));
    try {
      const hook = join(dir, ".git", "hooks", "pre-commit");
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      writeFileSync(hook, "#!/bin/sh\n");
      chmodSync(hook, 0o755);
      const timeoutMs = 123_456;
      const env = { PI_COMMIT_TIMEOUT_MS: String(timeoutMs) };
      const pi = mockPi(async (cmd, args) => {
        if (cmd === "git" && args[0] === "rev-parse") {
          return { stdout: join(dir, ".git", "hooks", "pre-commit") + "\n", stderr: "", code: 0, killed: false };
        }
        return { stdout: "hooks passed", stderr: "", code: 0, killed: false };
      });
      const result = await runPrecommitCheck(pi, dir, env);

      const gitCalls = pi.execLog.filter((c) => c.cmd === "git");
      const addCall = gitCalls.find((c) => c.args[0] === "add");
      const hookCall = gitCalls.find((c) => c.args[0] === "hook");
      assert.ok(addCall, "git add should be invoked");
      assert.deepEqual(addCall!.args, ["add", "--all"]);
      assert.ok(hookCall, "git hook run should be invoked");
      assert.deepEqual(hookCall!.args, ["hook", "run", "--ignore-missing", "pre-commit"]);
      assert.equal(hookCall!.options?.timeout, timeoutMs);
      assert.equal(hookCall!.options?.timeout, getCommitTimeoutMs(env));
      // add --all runs before the hook.
      assert.ok(pi.execLog.indexOf(addCall!) < pi.execLog.indexOf(hookCall!));

      assert.equal(result.hookPresent, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.match(result.output, /hooks passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults the timeout budget to PI_COMMIT_TIMEOUT_MS / 300000", async () => {
    const pi = mockPi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
    await runPrecommitCheck(pi, "/tmp", {});
    const hookCall = pi.execLog.find((c) => c.args[0] === "hook");
    assert.equal(hookCall!.options?.timeout, 300_000);
  });

  it("caps the output tail at PRECOMMIT_OUTPUT_TAIL (4000) chars, keeping the tail", async () => {
    const long = "x".repeat(5000) + "TAIL-MARKER";
    const pi = mockPi(async (cmd, args) => {
      if (args[0] === "rev-parse") return { stdout: "", stderr: "", code: 1, killed: false };
      if (args[0] === "hook") return { stdout: long, stderr: "", code: 1, killed: false };
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    const result = await runPrecommitCheck(pi, "/tmp", {});
    assert.equal(PRECOMMIT_OUTPUT_TAIL, 4000);
    assert.equal(result.output.length, PRECOMMIT_OUTPUT_TAIL);
    assert.ok(result.output.endsWith("TAIL-MARKER"));
    assert.equal(result.exitCode, 1);
  });

  it("reports hookPresent false and keeps exit code and output when the hook file is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-absent-"));
    try {
      const pi = mockPi(async (cmd, args) => {
        if (args[0] === "rev-parse") {
          return { stdout: join(dir, ".git", "hooks", "pre-commit") + "\n", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "hook") {
          return { stdout: "", stderr: "no such hook", code: 1, killed: false };
        }
        return { stdout: "", stderr: "", code: 0, killed: false };
      });
      const result = await runPrecommitCheck(pi, dir, {});
      assert.equal(result.hookPresent, false);
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /no such hook/);
      assert.equal(result.timedOut, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports timedOut true when the hook run exceeds the budget (killed)", async () => {
    const pi = mockPi(async (cmd, args) => {
      if (args[0] === "rev-parse") return { stdout: "", stderr: "", code: 1, killed: false };
      if (args[0] === "hook") return { stdout: "", stderr: "Terminated", code: 1, killed: true };
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    const result = await runPrecommitCheck(pi, "/tmp", {});
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 1);
  });

  it("returns exit code 1 and a timedOut flag when pi.exec throws a timeout error", async () => {
    const pi = mockPi(async (cmd, args) => {
      if (args[0] === "hook") throw new Error("Command timed out after 123456ms");
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    const result = await runPrecommitCheck(pi, "/tmp", {});
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, true);
    assert.match(result.output, /timed out/i);
  });

  it("still runs the hook when git add --all throws (best-effort staging)", async () => {
    const pi = mockPi(async (cmd, args) => {
      if (args[0] === "add") throw new Error("sandbox refused");
      if (args[0] === "hook") return { stdout: "ok", stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "", code: 1, killed: false };
    });
    const result = await runPrecommitCheck(pi, "/tmp", {});
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /ok/);
  });
});

// ─── formatPrecommitResult ────────────────────────────────────────────────────

describe("formatPrecommitResult", () => {
  it("renders hook presence, exit code, timed-out flag and output", () => {
    const text = formatPrecommitResult({
      hookPresent: true,
      exitCode: 1,
      output: "lint failed",
      timedOut: false,
    });
    assert.match(text, /hook present: true/);
    assert.match(text, /exit code: 1/);
    assert.match(text, /timed out: false/);
    assert.match(text, /lint failed/);
  });

  it("renders (no output) for an empty tail", () => {
    const text = formatPrecommitResult({ hookPresent: false, exitCode: 0, output: "", timedOut: false });
    assert.match(text, /\(no output\)/);
  });
});

// ─── run_precommit_check tool ─────────────────────────────────────────────────

describe("run_precommit_check tool", () => {
  it("is registered by the extension factory", async () => {
    const pi = mockPi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
    const factory = (await import("../extensions/index.ts")).default;
    (pi as unknown as Record<string, unknown>)["on"] = () => {};
    (pi as unknown as Record<string, unknown>)["registerCommand"] = () => {};
    (pi as unknown as Record<string, unknown>)["appendEntry"] = () => {};
    (pi as unknown as Record<string, unknown>)["sendUserMessage"] = () => {};
    (pi as unknown as Record<string, unknown>)["getActiveTools"] = () => ["read"];
    (pi as unknown as Record<string, unknown>)["setActiveTools"] = () => {};
    factory(pi as unknown as ExtensionAPI);
    const names = (pi as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok(names.includes("run_precommit_check"));
  });

  it("is listed in DISCUSS_BLOCKED_TOOLS", () => {
    assert.ok(DISCUSS_BLOCKED_TOOLS.includes("run_precommit_check"));
  });

  it("errors outside the implementing phase", async () => {
    const pi = mockPi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
    registerPrecommitCheckTool(pi);
    const tool = pi.tools.find((t) => t.name === "run_precommit_check")!;

    for (const phase of ["discussing", "finalizing", "idle"] as const) {
      const res = await tool.execute("c1", {}, undefined, undefined, ctxWithState({ phase, specText: "t" }));
      assert.equal(res.isError, true, `phase ${phase} should error`);
      assert.match(res.content[0].text, /implementing phase/);
    }
    const noState = await tool.execute("c1", {}, undefined, undefined, ctxWithState(null));
    assert.equal(noState.isError, true);
  });

  it("runs the check and returns the formatted result in the implementing phase", async () => {
    const pi = mockPi(async (cmd, args) => {
      if (args[0] === "rev-parse") return { stdout: "", stderr: "", code: 1, killed: false };
      if (args[0] === "hook") return { stdout: "all hooks passed", stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    registerPrecommitCheckTool(pi);
    const tool = pi.tools.find((t) => t.name === "run_precommit_check")!;

    const res = await tool.execute("c1", {}, undefined, undefined, ctxWithState(implementingState(), "/repo"));
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /hook present: false/);
    assert.match(res.content[0].text, /exit code: 0/);
    assert.match(res.content[0].text, /all hooks passed/);
    // It staged and ran the hook via pi.exec, never a shell tool.
    const cmds = pi.execLog.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    assert.ok(cmds.includes("git add --all"));
    assert.ok(cmds.some((s) => s.startsWith("git hook run --ignore-missing pre-commit")));
    assert.ok(!cmds.some((s) => s.startsWith("bash")), "must not use a shell");
  });
});

// ─── tdd-prompt solo direction ────────────────────────────────────────────────

describe("tdd-prompt.md solo hook verification (T4)", () => {
  it("directs solo-mode hook verification to run_precommit_check", async () => {
    const content = await loadContent("tdd-prompt.md");
    assert.match(content, /run_precommit_check/);
    assert.match(content, /pre-commit hook/i);
  });
});
