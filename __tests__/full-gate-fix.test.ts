import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  BLOCKED_PATH_PREFIX,
  FULL_GATE_UNIT_ID,
  buildFullGateFixTask,
  extractBlockedPaths,
  renderBlockedPathsHalt,
} from "../extensions/full-gate-fix.ts";
import type { FinalGateResult } from "../extensions/state-types.ts";
import type { FullGateTriage } from "../extensions/full-gate-triage.ts";

/** One red final-gate result with a failing suite tail. */
function redGate(): FinalGateResult {
  return {
    passed: false,
    at: "2024-01-01T00:00:00.000Z",
    suites: [
      {
        label: "javascript (npm run test)",
        passed: false,
        tail: "FAIL  __tests__/a.test.ts > suite > test",
      },
    ],
  };
}

/** Triage marking one failing test declared with its owning task. */
function declaredTriage(): FullGateTriage {
  return {
    failing: [{ path: "__tests__/a.test.ts", declared: true, owners: ["T1"] }],
    unparseableSuites: [],
  };
}

// ═══ Assertion 6: the fix unit's task text ═══
describe("buildFullGateFixTask (T7)", () => {
  it("carries the failing tests with owning tasks, the landed commit subjects and the suite tails", () => {
    const text = buildFullGateFixTask(redGate(), declaredTriage(), [
      "feat(core): add first behavior",
    ]);

    assert.match(text, /Implement ONE behavior: FULL-GATE/, "the well-known behavior id");
    assert.match(
      text,
      /__tests__\/a\.test\.ts — declared \(owners: T1\)/,
      "failing tests are mapped to their owning tasks",
    );
    assert.match(
      text,
      /feat\(core\): add first behavior/,
      "landed commit subjects are carried into the task text",
    );
    assert.match(
      text,
      /FAIL  __tests__\/a\.test\.ts > suite > test/,
      "the red suite output tail is carried",
    );
    assert.match(text, /javascript \(npm run test\) \(FAIL\)/, "the failing suite is named");
    assert.match(text, /Do NOT delete, skip or/, "the no-test-weakening rule is stated");
    assert.match(
      text,
      new RegExp(BLOCKED_PATH_PREFIX.trim()),
      "the blocked-path reporting channel is spelled out",
    );
  });

  it("renders (none) when no commit landed before the fix round", () => {
    const text = buildFullGateFixTask(redGate(), declaredTriage(), []);
    assert.match(text, /## Landed commits\n- \(none\)/);
  });
});

// ═══ Assertion 11: blocked-path channel ═══
describe("extractBlockedPaths (T7)", () => {
  it("extracts deduplicated paths reported with the BLOCKED PATH prefix", () => {
    assert.deepEqual(
      extractBlockedPaths([
        "regular finding",
        `${BLOCKED_PATH_PREFIX}secrets/env.ts`,
        `prefix noise ${BLOCKED_PATH_PREFIX}secrets/env.ts`,
        `${BLOCKED_PATH_PREFIX}other.ts`,
      ]),
      ["secrets/env.ts", "other.ts"],
      "duplicate blocked paths collapse in first-seen order",
    );
  });

  it("returns nothing for undefined or prefix-free findings", () => {
    assert.deepEqual(extractBlockedPaths(undefined), []);
    assert.deepEqual(extractBlockedPaths(["nothing blocked here"]), []);
  });
});

describe("renderBlockedPathsHalt (T7)", () => {
  it("lists the requested paths and steers to /discuss -> /finalize -> /implement", () => {
    const text = renderBlockedPathsHalt(["secrets/env.ts"]);

    assert.match(text, /## FULL-GATE fix round blocked on undeclared paths/);
    assert.match(text, /- secrets\/env\.ts — undeclared/);
    assert.match(
      text,
      /\/discuss -> \/finalize -> \/implement/,
      "the contract-change steer is present",
    );
    assert.match(text, /No further fix round runs/, "exactly one fix round is allowed");
  });
});

// ═══ Assertion 7 marker: the well-known fix-unit id ═══
describe("FULL_GATE_UNIT_ID (T7)", () => {
  it("is the well-known FULL-GATE marker used by the runner payload", () => {
    assert.equal(FULL_GATE_UNIT_ID, "FULL-GATE");
  });
});
