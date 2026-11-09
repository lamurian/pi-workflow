import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCommitArgs } from "../extensions/commit-core.ts";
import { getCommitTimeoutMs } from "../extensions/git-ops.ts";
import type { WorkflowState } from "../extensions/state.ts";

// ═══ T7: workflow-owned commit_changes tool ═══

interface ExecCall {
  cmd: string;
  args: string[];
  options?: { cwd?: string; timeout?: number };
}

/** Controllable git state backing the pi.exec mock. */
interface GitSim {
  /** Staged set returned by `git diff --cached --name-only`. */
  staged?: string;
  /** Changed paths returned by `git status --short --untracked-files=all`. */
  changed?: string;
  /** Exit code of `git commit` (0/undefined = success). */
  commitCode?: number;
  /** stdout of a failed `git commit` (hook output). */
  commitOut?: string;
  /** Output of `git rev-parse --short HEAD`. */
  shortSha?: string;
  /** Output of `git log -1 --pretty=%s`. */
  landedSubject?: string;
}

interface MockPi extends ExtensionAPI {
  execLog: ExecCall[];
  tools: Array<{ name: string; execute: Function }>;
}

function mockPi(sim: GitSim): MockPi {
  const execLog: ExecCall[] = [];
  const tools: Array<{ name: string; execute: Function }> = [];
  let head = "HEAD-BEFORE";
  const exec = async (
    _cmd: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ) => {
    execLog.push({ cmd: "git", args, options });
    const out = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
    if (args[0] === "add") return out("");
    if (args[0] === "diff") return out(sim.staged ?? "");
    if (args[0] === "status") return out(sim.changed ?? "");
    if (args[0] === "commit") {
      if (sim.commitCode === undefined || sim.commitCode === 0) {
        head = "HEAD-AFTER";
        return out("");
      }
      return { stdout: sim.commitOut ?? "", stderr: "", code: sim.commitCode, killed: false };
    }
    if (args[0] === "rev-parse") {
      if (args[1] === "--short") return out(`${sim.shortSha ?? head.slice(0, 7)}\n`);
      return out(`${head}\n`);
    }
    if (args[0] === "log") return out(`${sim.landedSubject ?? ""}\n`);
    return out("");
  };
  const noop = () => {};
  return {
    exec,
    registerTool: (def: { name: string; execute: Function }) => {
      tools.push(def);
    },
    on: noop as ExtensionAPI["on"],
    registerCommand: noop as ExtensionAPI["registerCommand"],
    appendEntry: noop as ExtensionAPI["appendEntry"],
    sendUserMessage: noop as ExtensionAPI["sendUserMessage"],
    getActiveTools: () => ["read"],
    setActiveTools: noop as ExtensionAPI["setActiveTools"],
    execLog,
    tools,
  } as unknown as MockPi;
}

function ctxWithState(state: WorkflowState | null, cwd = "/repo"): ExtensionContext {
  return {
    cwd,
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
    },
  } as unknown as ExtensionContext;
}

function implementingState(): WorkflowState {
  return { phase: "implementing", specText: "t" };
}

async function getTool(pi: MockPi) {
  const factory = (await import("../extensions/index.ts")).default;
  factory(pi);
  const tool = pi.tools.find((t) => t.name === "commit_changes");
  assert.ok(tool, "commit_changes must be registered by the extension factory");
  return tool;
}

// ─── Assertion 1: message mode stages all, commits via the core ─────────────

describe("commit_changes tool (T7)", () => {
  it("stages all changes, commits through the core with --signoff, returns the landed short sha and subject", async () => {
    const pi = mockPi({
      staged: "extensions/commit-tool.ts",
      commitCode: 0,
      shortSha: "abc1234",
      landedSubject: "feat: commit tool",
    });
    const tool = await getTool(pi);

    const res = await tool.execute(
      "c1",
      { message: "feat: commit tool" },
      undefined,
      undefined,
      ctxWithState(implementingState()),
    );

    assert.notEqual(res.isError, true);
    const text = res.content[0].text as string;
    assert.match(text, /abc1234/, "reports the landed short sha");
    assert.match(text, /feat: commit tool/, "reports the landed subject");

    const add = pi.execLog.find((c) => c.args[0] === "add");
    assert.ok(add, "git add must run");
    assert.deepEqual(add!.args, ["add", "--all"], "message mode stages all changes");

    const commit = pi.execLog.find((c) => c.args[0] === "commit");
    assert.ok(commit, "git commit must run");
    assert.deepEqual(
      commit!.args,
      buildCommitArgs("feat: commit tool"),
      "commit argv comes from the core (normalized subject + --signoff)",
    );
    assert.ok(commit!.args.includes("--signoff"));
    assert.equal(commit!.options?.timeout, getCommitTimeoutMs());
    assert.ok(
      pi.execLog.indexOf(add!) < pi.execLog.indexOf(commit!),
      "staging happens before the commit",
    );
    assert.ok(
      !pi.execLog.some((c) => c.args.includes("--no-verify")),
      "never bypasses the hooks",
    );
  });

  // ─── Assertion 2a: hook rejection ──────────────────────────────────────

  it("returns isError with the hook output tail when the pre-commit hook rejects the commit", async () => {
    const hookOut = "h".repeat(4500) + "TAILMARK";
    const pi = mockPi({
      staged: "extensions/commit-tool.ts",
      commitCode: 1,
      commitOut: hookOut,
    });
    const tool = await getTool(pi);

    const res = await tool.execute(
      "c1",
      { message: "feat: broken" },
      undefined,
      undefined,
      ctxWithState(implementingState()),
    );

    assert.equal(res.isError, true, "a hook rejection is an error");
    const text = res.content[0].text as string;
    assert.ok(text.endsWith("TAILMARK"), "the hook output tail is included");
    assert.ok(
      text.length <= 4300,
      `output tail is capped at 4000 chars (got ${text.length})`,
    );
    assert.match(text, /hook/i);
  });

  // ─── Assertion 2b: nothing staged ──────────────────────────────────────

  it("reports nothing-to-commit without invoking git commit when nothing is staged", async () => {
    const pi = mockPi({ staged: "" });
    const tool = await getTool(pi);

    const res = await tool.execute(
      "c1",
      { message: "feat: nothing" },
      undefined,
      undefined,
      ctxWithState(implementingState()),
    );

    assert.notEqual(res.isError, true, "nothing to commit is a report, not an error");
    const text = res.content[0].text as string;
    assert.match(text, /nothing to commit/i);
    assert.ok(
      !pi.execLog.some((c) => c.args[0] === "commit"),
      "git commit must not be invoked when nothing is staged",
    );
  });
});
