import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { supersededTestWarnings } from "../extensions/superseded-tests.ts";
import type { ContractV2, FileStatus } from "../extensions/state.ts";

const TEST_PATH = "tests/quarto-syntax.test.ts";
const BASENAME = "quarto-syntax.test.ts";
const TRACKED = new Set([TEST_PATH]);

interface Patch {
  entryStatus?: FileStatus;
  description?: string;
  taskStatus?: "active" | "done";
}

/**
 * Contract factory: T1 owns one tests entry; the patch adjusts the entry
 * status, the owning description or the task status per case.
 *
 * @param patch - Per-case overrides; defaults describe an active task that
 *                never names the test file.
 * @returns A minimal valid ContractV2.
 */
function makeContract(patch: Patch = {}): ContractV2 {
  return {
    title: "T",
    instruction: "i",
    done: "d",
    sources: [],
    tests: [
      {
        path: TEST_PATH,
        ...(patch.entryStatus !== undefined ? { status: patch.entryStatus } : {}),
        tasks: ["T1"],
      },
    ],
    tasks: [
      {
        id: "T1",
        description: patch.description ?? "rewrite quarto parsing",
        expectedOutput: ["y"],
        status: patch.taskStatus ?? "active",
      },
    ],
  };
}

describe("supersededTestWarnings (T7)", () => {
  it("warns with the path and task id for a tracked test no description names", () => {
    const warnings = supersededTestWarnings(makeContract(), TRACKED);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^superseded-unnamed:/, "carries the warning kind");
    assert.match(warnings[0]!, /tests\/quarto-syntax\.test\.ts/, "names the path");
    assert.match(warnings[0]!, /T1/, "names the owning task id");
  });

  it("no warning when the owning task description names the basename", () => {
    const warnings = supersededTestWarnings(
      makeContract({ description: `update ${BASENAME} for the new syntax` }),
      TRACKED,
    );
    assert.deepEqual(warnings, []);
  });

  it("the basename match is case-sensitive", () => {
    const warnings = supersededTestWarnings(
      makeContract({ description: "update Quarto-Syntax.Test.ts for the new syntax" }),
      TRACKED,
    );
    assert.equal(warnings.length, 1, "a differently-cased mention does not name the file");
  });

  it("no warning when the path is not tracked at HEAD", () => {
    assert.deepEqual(supersededTestWarnings(makeContract(), new Set<string>()), []);
  });

  it("no warning when the tests entry has status D", () => {
    assert.deepEqual(supersededTestWarnings(makeContract({ entryStatus: "D" }), TRACKED), []);
  });

  it("no warning when the owning task is done", () => {
    assert.deepEqual(supersededTestWarnings(makeContract({ taskStatus: "done" }), TRACKED), []);
  });
});
