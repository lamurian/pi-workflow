import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  RETRY_BUDGET,
  buildFixTask,
  buildInvestigation,
  classifyCommit,
  detectFailingStage,
  type GateInput,
} from "../extensions/commit-gate.ts";
import type { Behavior, TaskContract } from "../extensions/state.ts";

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
  files: ["src/a.ts"],
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
