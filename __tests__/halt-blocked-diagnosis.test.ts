import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { renderHaltReport, type AttemptRecord } from "../extensions/halt-report.ts";
import { blockedHaltText } from "../extensions/blocked-unit.ts";

const rec = (outcome: AttemptRecord["outcome"]): AttemptRecord => ({ attempt: 1, outcome, durationSec: 3, progress: false, lastText: "x" });

describe("blocked halt diagnosis", () => {
  it("unit-blocked names the blockedReason without sandbox wording", () => {
    const error = blockedHaltText("R3", { status: "blocked", blockedReason: "capability", summary: "no tool" })!;
    const report = renderHaltReport({ haltedOn: "R3", error, commits: [], attempts: [rec("unit-blocked")] });
    assert.match(report, /Diagnosis: .*blockedReason: capability/);
    assert.doesNotMatch(report, /sandbox-blocked command must run outside/);
    assert.doesNotMatch(report, /Action required/);
    assert.match(report, /\/discuss -> \/finalize/);
  });

  it("sandbox mustRunNow keeps the sandbox diagnosis", () => {
    const report = renderHaltReport({ haltedOn: "R3", error: "must run now", commits: [], attempts: [rec("blocked")], pendingCommand: { command: "npm i" } });
    assert.match(report, /Diagnosis: a sandbox-blocked command must run outside the sandbox/);
    assert.match(report, /Action required/);
  });
});
