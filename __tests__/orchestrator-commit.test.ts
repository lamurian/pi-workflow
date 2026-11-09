import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitAndGate, pickCommitSubject } from "../extensions/git-commit-gate.ts";
import { FULL_GATE_FIX_SUBJECT } from "../extensions/full-gate-fix.ts";
import type { Behavior, ContractV2, TaskContract } from "../extensions/state.ts";
import type { ImplementerReport } from "../extensions/implementer-report.ts";

// ═══ T3: orchestrator commits through the core; contract task commit wins ═══

/** One active test behavior for the subject picker. */
const BEHAVIOR: Behavior = {
  id: "T1",
  description: "the gate runs the orchestrator commit through the core",
  expectedOutput: "argv carries --signoff",
  kind: "test",
  status: "active",
};

/** v1 task contract (plain files list) used by commitAndGate. */
const TASK: TaskContract = {
  title: "T3 Task",
  instruction: "wire commits through the core",
  files: [{ path: "src/a.ts", status: "M" }],
  done: "tests pass",
  behaviors: [BEHAVIOR],
};

/** Minimal report carrying only a suggested commit. */
function report(suggestedCommit?: string): ImplementerReport {
  return { summary: "done", ...(suggestedCommit ? { suggestedCommit } : {}) };
}

/** v2 contract whose T1 unit declares a commit message. */
function contractWithCommit(commit?: string): ContractV2 {
  return {
    title: "T3 Task",
    instruction: "wire commits through the core",
    done: "tests pass",
    sources: [{ path: "src/a.ts", tasks: ["T1"] }],
    tests: [],
    tasks: [
      {
        id: "T1",
        description: BEHAVIOR.description,
        expectedOutput: ["argv carries --signoff"],
        status: "active",
        ...(commit !== undefined ? { commit } : {}),
      },
    ],
  };
}

/**
 * Mock ExtensionAPI: `git rev-parse` answers head0/head1, `git commit` advances
 * HEAD so the gate classifies the attempt as landed; every diff read is empty.
 * @param log - Array collecting each `[cmd, args]` invocation.
 * @returns The mock ExtensionAPI.
 */
function piLanding(log: Array<{ cmd: string; args: string[] }>): ExtensionAPI {
  let head = 0;
  return {
    exec: (async (cmd: string, args: string[]) => {
      log.push({ cmd, args });
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `head${head}\n`, stderr: "", code: 0, killed: false };
      }
      if (cmd === "git" && args[0] === "commit") {
        head++;
        return { stdout: "[main abc] committed", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }),
  } as unknown as ExtensionAPI;
}

describe("commitAndGate runs the orchestrator commit through the core (T3)", () => {
  it("invokes git with argv `commit -m <subject> --signoff`", async () => {
    const log: Array<{ cmd: string; args: string[] }> = [];
    const pi = piLanding(log);

    const attempt = await commitAndGate(
      pi,
      "/tmp/test",
      "feat(core): land T1",
      BEHAVIOR,
      TASK,
      1,
      "base123",
    );

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    const commits = log.filter((e) => e.cmd === "git" && e.args[0] === "commit");
    assert.equal(commits.length, 1, "exactly one commit invocation");
    assert.deepEqual(
      commits[0]!.args,
      ["commit", "-m", "feat(core): land T1", "--signoff"],
      "the commit argv is built by the core: commit -m <subject> --signoff",
    );
  });

  it("normalizes the subject through the core (first non-empty line, 75 cap)", async () => {
    const log: Array<{ cmd: string; args: string[] }> = [];
    const pi = piLanding(log);
    const long = `feat(core): ${"x".repeat(90)}\nbody line never committed`;

    const attempt = await commitAndGate(pi, "/tmp/test", long, BEHAVIOR, TASK, 1, "base123");

    assert.equal(attempt.outcome, null, JSON.stringify(attempt.outcome));
    const commit = log.find((e) => e.cmd === "git" && e.args[0] === "commit")!;
    assert.equal(commit.args[2], `feat(core): ${"x".repeat(63)}`.slice(0, 75));
    assert.equal(commit.args[2]!.length, 75, "the subject is capped at 75 characters");
    assert.ok(!commit.args[2]!.includes("\n"), "the subject is one line");
    assert.equal(commit.args[3], "--signoff");
  });
});

describe("pickCommitSubject (T3)", () => {
  it("returns the contract task's commit when present, even if the unit suggested one", () => {
    const subject = pickCommitSubject(
      report("feat(unit): ignore me"),
      BEHAVIOR,
      contractWithCommit("feat(contract): declared subject"),
    );
    assert.equal(subject, "feat(contract): declared subject");
  });

  it("falls back to the unit's legacy suggestedCommit when the task declares no commit", () => {
    const withCommitTask = contractWithCommit(undefined);
    assert.equal(
      pickCommitSubject(report("fix(unit): legacy suggestion"), BEHAVIOR, withCommitTask),
      "fix(unit): legacy suggestion",
      "a task without a commit keeps the unit's suggestion",
    );
    assert.equal(
      pickCommitSubject(report("fix(unit): legacy suggestion"), BEHAVIOR),
      "fix(unit): legacy suggestion",
      "no contract keeps the unit's suggestion",
    );
  });

  it("falls back to `feat: implement <description>` when neither exists", () => {
    assert.equal(
      pickCommitSubject(report(), BEHAVIOR),
      "feat: implement the gate runs the orchestrator commit through the core",
    );
    assert.equal(
      pickCommitSubject(report(undefined), BEHAVIOR, contractWithCommit(undefined)),
      "feat: implement the gate runs the orchestrator commit through the core",
    );
  });

  it("normalizes every branch to one line of at most 75 characters", () => {
    const longDesc: Behavior = { ...BEHAVIOR, description: "d".repeat(120) };
    const generic = pickCommitSubject(report(undefined), longDesc);
    assert.equal(generic, `feat: implement ${"d".repeat(120)}`.slice(0, 75));
    assert.equal(generic.length, 75);

    const multiline = pickCommitSubject(
      { summary: "done", suggestedCommit: "\n  feat: first line  \nsecond line" },
      BEHAVIOR,
    );
    assert.equal(multiline, "feat: first line", "blank leading lines collapse away");

    const contractMultiline = pickCommitSubject(report(), BEHAVIOR, {
      ...contractWithCommit(undefined),
      tasks: [{ ...contractWithCommit(undefined).tasks[0]!, commit: "fix: a\nextra body" }],
    });
    assert.equal(contractMultiline, "fix: a", "the contract commit is single-line too");
  });
});

describe("FULL-GATE fix subject (T3)", () => {
  it("uses the fixed subject `fix: restore green test suite`", () => {
    assert.equal(FULL_GATE_FIX_SUBJECT, "fix: restore green test suite");
    assert.ok(!FULL_GATE_FIX_SUBJECT.includes("\n"), "the fixed subject is one line");
    assert.ok(FULL_GATE_FIX_SUBJECT.length <= 75, "the fixed subject fits the 75 cap");
  });
});
