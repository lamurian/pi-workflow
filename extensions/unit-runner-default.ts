// ─── Default unit runner ─────────────────────────────────────────────────────
// The built-in UnitRunner for one /implement run: writes the per-spawn
// payload, then spawns the unit with PI_UNIT_FILE pointing at it so the
// child contract-guard extension can enforce the allowlist in-turn.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskContract, WorkflowState } from "./state.ts";
import type { UnitRunner } from "./implement-loop.ts";
import { writeContractGuardFile } from "./contract-guard-file.ts";
import { runImplementerUnit } from "./implementer-runner.ts";
import { loadUnitPrompt } from "./unit-task-text.ts";

/**
 * Build the default unit runner for one /implement run: writes the
 * per-spawn payload to `.git/pi-workflow/contract-guard.json` before
 * every spawn (base attempt, retry, fix, continuation) and runs the unit
 * with `PI_UNIT_FILE` pointing at it so the child contract-guard
 * extension can enforce the allowlist in-turn (`PI_CONTRACT_GUARD_FILE`
 * stays set as the legacy read-fallback for one release). v2 sessions
 * (state.contractV2) get the derived allowlist plus the unit's slice
 * (`unit { id, sources, tests, packages, testSuites }`); v1 sessions keep
 * the plain `files` payload.
 *
 * @param pi      - ExtensionAPI (used for the baseline `git ls-tree` query).
 * @param state   - Current workflow state (supplies baselineHead, contractV2).
 * @param task    - The task contract (supplies the declared files).
 * @param modelRef - Optional canonical `provider/id` session-model reference
 *                  passed to the child as `--model <ref>` (formatModelRef).
 * @returns A UnitRunner that writes the payload file, then spawns the unit.
 */
export function createDefaultUnitRunner(
  pi: ExtensionAPI,
  state: WorkflowState,
  task: TaskContract,
  modelRef?: string,
): UnitRunner {
  return async (unit, cwd, signal, onEvent) => {
    // T5: v2 sessions write the derived allowlist + the unit's slice; the
    // taskId keys the slice (ignored by the writer in v1 mode, where the
    // plain `files` payload is kept — no ownership refs exist there).
    const guardPath = await writeContractGuardFile(
      pi, cwd, task.files, state.baselineHead ?? "HEAD",
      {
        contract: state.contractV2,
        taskId: unit.behaviorId,
        testSuites: state.testTool?.suites ?? [],
      },
    );
    // T5: keep the child alive after every report — test-kind children absorb
    // hook-rejected/no-changes fixes as warm steers; the behavior loop shuts
    // them down on landing, halt, cancel and completion paths.
    return runImplementerUnit(
      loadUnitPrompt(), unit.taskText, cwd, signal, undefined,
      onEvent, true,
      {
        PI_UNIT_FILE: guardPath,
        // Legacy read-fallback for one release (T5).
        PI_CONTRACT_GUARD_FILE: guardPath,
      },
      modelRef,
    );
  };
}
