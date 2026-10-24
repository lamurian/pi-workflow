import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { migrateV1 } from "../extensions/task-migrate.ts";
import {
  loadState,
  type TaskContract,
  type WorkflowState,
} from "../extensions/state.ts";
import { validateContract } from "../extensions/task-contract.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * A representative persisted v1 contract: two behaviors (test + manual),
 * their declared files, one unowned doc file and one unowned test file.
 */
function v1Contract(): TaskContract {
  return {
    title: "Normalize the handler",
    instruction: "refactor the handler module",
    files: [
      { path: "src/handler.ts", status: "M" },
      { path: "src/manual.ts", status: "M" },
      { path: "tests/handler.test.ts", status: "A" },
      { path: "docs/notes.md", status: "M" },
      { path: "tests/orphan.test.ts", status: "M" },
    ],
    done: "suite green",
    behaviors: [
      {
        id: "T1",
        description: "handler returns list",
        expectedOutput: "returns 200 with the list; persists the row",
        kind: "test",
        status: "active",
        sourceFile: "src/handler.ts",
      },
      {
        id: "T2",
        description: "manual smoke check",
        expectedOutput: "manual check passes",
        kind: "manual",
        status: "done",
        sourceFile: "src/manual.ts",
      },
    ],
  };
}

/** Deterministic scan-evidence lines (crossCheck format: `entry -> test [method, confidence]`). */
const EVIDENCE = [
  "src/handler.ts -> tests/handler.test.ts [symbol, high]",
  "src/handler.ts: unverified — no derivation hit (default export)",
  "src/manual.ts -> tests/orphan.test.ts [basename, low]",
];

describe("migrateV1SplitsAssertionsAndSeedsRefs", () => {
  it("maps behaviors to tasks with split assertions and seeded path refs", () => {
    const result = migrateV1(v1Contract(), EVIDENCE);
    const c = result.contract;

    const v = validateContract(c);
    assert.equal(v.ok, true, v.ok ? "" : v.reason);

    // id and status preserved; expectedOutput string split into assertions on "; ".
    assert.deepEqual(
      c.tasks.map((t) => ({
        id: t.id,
        status: t.status,
        expectedOutput: t.expectedOutput,
      })),
      [
        {
          id: "T1",
          status: "active",
          expectedOutput: ["returns 200 with the list", "persists the row"],
        },
        {
          id: "T2",
          status: "done",
          expectedOutput: ["manual check passes"],
        },
      ],
    );
    assert.equal(c.tasks[0]!.description, "handler returns list");

    // sourceFile seeds a sources entry with taskRef [behavior id].
    const handler = c.sources.find((e) => e.path === "src/handler.ts");
    assert.deepEqual(handler?.tasks, ["T1"]);
    assert.equal(handler?.status, "M", "declared v1 status carries over");
    const manual = c.sources.find((e) => e.path === "src/manual.ts");
    assert.deepEqual(manual?.tasks, ["T2"]);

    // kind: test — tests refs seeded from the evidence argument.
    const seeded = c.tests.find((e) => e.path === "tests/handler.test.ts");
    assert.deepEqual(seeded?.tasks, ["T1"]);
    assert.equal(seeded?.status, "A");

    // kind: manual — no tests refs, even though evidence names its sourceFile.
    assert.equal(
      c.tests.some((e) => e.tasks.includes("T2")),
      false,
      "manual tasks get no tests refs",
    );

    // Unowned v1 files become shared refs listed in the migration summary.
    const sharedDoc = c.sources.find((e) => e.path === "docs/notes.md");
    assert.deepEqual(sharedDoc?.tasks, [], "unowned file carries an empty tasks ref");
    assert.deepEqual(result.sharedPaths, ["docs/notes.md", "tests/orphan.test.ts"]);
    for (const p of result.sharedPaths) {
      assert.ok(
        result.summary.some((line) => line.includes(p)),
        `migration summary lists shared path ${p}`,
      );
    }
  });

  it("seeds no tests refs when the evidence argument is omitted", () => {
    const c = migrateV1(v1Contract()).contract;
    assert.equal(
      c.tests.every((e) => e.tasks.length === 0),
      true,
      "kind: test with no evidence gets empty tests refs",
    );
    assert.deepEqual(
      c.tests.map((e) => e.path),
      ["tests/handler.test.ts", "tests/orphan.test.ts"],
      "unowned test files are still classified into tests",
    );
  });
});

describe("migrateV1FailsLoudlyOnInvalidMigration", () => {
  it("throws with the failing invariant named (unowned D entry)", () => {
    const v1: TaskContract = {
      title: "Legacy cleanup",
      instruction: "remove the legacy path",
      files: [{ path: "legacy/old.ts", status: "D" }],
      done: "legacy gone",
      behaviors: [
        {
          id: "T1",
          description: "manual cleanup",
          expectedOutput: "legacy path removed",
          kind: "manual",
          status: "active",
        },
      ],
    };
    assert.throws(() => migrateV1(v1), /D entry with empty tasks/);
  });

  it("throws with the failing invariant named (duplicate task id)", () => {
    const v1 = v1Contract();
    v1.behaviors.push({ ...v1.behaviors[0]! });
    assert.throws(() => migrateV1(v1), /duplicate task id/);
  });
});

describe("resumeMigratesV1Contract", () => {
  /** Minimal extension context whose session branch holds one persisted state. */
  function ctxWithState(state: unknown): ExtensionContext {
    return {
      cwd: "/tmp/test",
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "workflow-state", data: state },
        ],
      },
    } as unknown as ExtensionContext;
  }

  it("yields a valid ContractV2 when resuming a persisted v1 contract", () => {
    const persisted: WorkflowState = {
      phase: "implementing",
      specText: "normalize the handler",
      task: v1Contract(),
      baselineHead: "abc123",
    };
    const loaded = loadState(ctxWithState(persisted));
    assert.ok(loaded);
    assert.ok(loaded!.contractV2, "resume attaches the migrated v2 contract");

    const v = validateContract(loaded!.contractV2);
    assert.equal(v.ok, true, v.ok ? "" : v.reason);
    assert.deepEqual(
      loaded!.contractV2!.tasks.map((t) => t.id),
      ["T1", "T2"],
      "behavior ids and order survive the resume migration",
    );
    assert.deepEqual(loaded!.contractV2!.tasks[0]!.expectedOutput, [
      "returns 200 with the list",
      "persists the row",
    ]);

    // The v1 contract stays available for v1 consumers, untouched.
    assert.equal(loaded!.task, persisted.task);
    // Attachment happens in place: loadState keeps returning the very object
    // the session branch holds — callers (and the orchestrator tests) mutate
    // the loaded state afterwards and expect those writes to be visible on
    // the persisted in-memory entry.
    assert.equal(
      loaded,
      persisted,
      "resume attaches contractV2 to the restored state object in place",
    );
  });

  it("keeps resuming on the v1 path when the migrated contract fails validation", () => {
    const persisted = {
      phase: "finalizing",
      specText: "broken contract",
      task: {
        title: "Broken",
        instruction: "x",
        files: [{ path: "legacy/old.ts", status: "D" }],
        done: "y",
        behaviors: [
          {
            id: "T1",
            description: "manual cleanup",
            expectedOutput: "gone",
            kind: "manual",
            status: "active",
          },
        ],
      },
    };
    const loaded = loadState(ctxWithState(persisted));
    assert.ok(loaded);
    assert.equal(loaded!.contractV2, undefined, "no invalid v2 contract is attached");
    assert.ok(loaded!.task, "resume still returns the persisted v1 contract");
  });
});
