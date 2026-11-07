// save_task pipeline core: one rule table (phase x operation x caller) and
// the validate -> preserve -> breadth -> persist -> derive -> scan pipeline.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { transitionTo, updateUi } from "./state.ts";
import type { WorkflowState } from "./state-types.ts";
import { validateContract, preserveContractDoneStatuses } from "./contract-v2-validate.ts";
import { checkTaskBreadth } from "./contract-breadth.ts";
import { collectBehaviorWarnings, deriveTaskContract } from "./contract-v1-view.ts";
import { loadWorkflowConfig, resolveMaxPathsPerTask } from "./paths.ts";
import { detectTestSuites, projectFacts } from "./test-tool-detect.ts";
import { ensureTestTool } from "./test-tool-ensure.ts";
import { dirtyTreeSaveWarnings } from "./dirty-tree-check.ts";
import { runContractScan } from "./contract-scan.ts";
import { renderEvidence } from "./test-scan-render.ts";
import { buildRunPlan, renderRunPlan } from "./run-plan.ts";
import { diffScanDigest, renderScanDiff, scanDigest, writeScanReport } from "./scan-report.ts";

/** Supported save_task operations. */
export type SaveTaskOperation = "replace";
/** Who invoked the pipeline. */
export type SaveTaskCaller = "agent" | "orchestrator";

/** Options for runSaveTask. */
export interface SaveTaskOptions {
  caller: SaveTaskCaller;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}

/** Pipeline result consumed by adapters. */
export interface SaveTaskResult {
  ok: boolean;
  text: string;
}

/** Rule table: phase -> operation -> callers allowed. */
export const SAVE_TASK_RULES: Record<string, Partial<Record<SaveTaskOperation, SaveTaskCaller[]>>> = {
  discussing: { replace: ["agent", "orchestrator"] },
  finalizing: { replace: ["agent", "orchestrator"] },
};

const TRACKED_BUDGET_MS = 5000;
const LEGACY_PAYLOAD_REJECTION =
  "save_task rejected: the legacy files/behaviors payload is not " +
  "accepted — call save_task with the contract v2 payload " +
  "{ title, instruction, done, sources, tests, tasks } where each " +
  "sources/tests entry is { path, status?, tasks } and each tasks " +
  "entry is { id, description, expectedOutput[], status? } (see content/finalize-prompt.md).";

function describeRules(): string {
  return Object.entries(SAVE_TASK_RULES)
    .map(([phase, ops]) => `${phase}: ${Object.keys(ops).join(", ")}`)
    .join("; ");
}

/**
 * Check the rule table for a phase/operation/caller triple.
 *
 * @returns null when allowed, otherwise the rejection text.
 */
export function checkSaveTaskRule(
  phase: string | undefined,
  operation: string,
  caller: SaveTaskCaller,
): string | null {
  const callers = phase ? SAVE_TASK_RULES[phase]?.[operation as SaveTaskOperation] : undefined;
  if (callers && callers.includes(caller)) return null;
  return (
    `save_task requires the discussing or finalizing phase: operation '${operation}' ` +
    `by ${caller} is not allowed in phase '${phase ?? "none"}'. ` +
    `Allowed phases and operations: ${describeRules()}.`
  );
}

async function readTrackedPaths(pi: ExtensionAPI, cwd: string): Promise<Set<string>> {
  try {
    const res = await pi.exec("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd,
      timeout: TRACKED_BUDGET_MS,
    });
    if (res.code !== 0) return new Set();
    return new Set(
      (res.stdout ?? "").split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

const fail = (text: string): SaveTaskResult => ({ ok: false, text });

/**
 * Run the save_task pipeline against a workflow state.
 *
 * @param state   - Workflow state (null when no workflow is active).
 * @param payload - Raw save_task payload; `operation` defaults to 'replace'.
 * @param opts    - Caller identity plus pi/ctx handles.
 * @returns ok flag and the tool-facing text.
 */
export async function runSaveTask(
  state: WorkflowState | null,
  payload: Record<string, unknown>,
  opts: SaveTaskOptions,
): Promise<SaveTaskResult> {
  const { pi, ctx, caller } = opts;
  const operation = typeof payload.operation === "string" ? payload.operation : "replace";
  const ruleError = checkSaveTaskRule(state?.phase, operation, caller);
  if (ruleError !== null || !state) return fail(ruleError ?? "save_task: no workflow state.");
  const raw = { ...payload };
  delete raw.operation;
  const legacy = raw.files !== undefined || raw.behaviors !== undefined;
  if (legacy || raw.sources === undefined || raw.tests === undefined || raw.tasks === undefined) {
    return fail(LEGACY_PAYLOAD_REJECTION);
  }
  const result = validateContract(raw);
  if (!result.ok) return fail(`save_task rejected: ${result.reason}`);
  const preserved = preserveContractDoneStatuses(state.contractV2, result.contract);
  const workflow = await loadWorkflowConfig(ctx.cwd);
  const declared = workflow?.implement?.commands ?? {};
  for (const t of preserved.contract.tasks) {
    for (const name of t.commands ?? []) {
      if (!Object.prototype.hasOwnProperty.call(declared, name)) {
        return fail(
          `save_task rejected: task ${t.id} lists command '${name}' which is not declared ` +
            `in .pi/workflow.json implement.commands — declare it via update_workflow_config first.`,
        );
      }
    }
  }
  const tooBroad = checkTaskBreadth(preserved.contract, resolveMaxPathsPerTask(workflow));
  if (tooBroad !== null) return fail(`save_task rejected: ${tooBroad}`);
  state.contractV2 = preserved.contract;
  const tracked = await readTrackedPaths(pi, ctx.cwd);
  state.task = deriveTaskContract(preserved.contract, tracked);
  const behaviorWarnings = state.task.behaviors.flatMap(collectBehaviorWarnings);
  const detection = await detectTestSuites(projectFacts(ctx.cwd), workflow);
  const ensured = await ensureTestTool(pi, ctx.cwd, detection);
  const { source, suites, fullSuites } = ensured;
  state.testTool = { source, suites, fullSuites };
  state.runPlan = await buildRunPlan(ctx.cwd, suites, fullSuites, workflow?.implement?.commands);
  const planText = "\n\n" + renderRunPlan(state.runPlan);
  const scan = await runContractScan(pi, ctx.cwd, state.task.files);
  const allWarnings = [
    ...behaviorWarnings,
    ...(detection.warnings ?? []),
    ...(scan?.warnings ?? []),
    ...(await dirtyTreeSaveWarnings(pi, ctx.cwd, preserved.contract)),
  ];
  state.contractHistory = [
    ...(state.contractHistory ?? []),
    { operation, caller, at: new Date().toISOString() },
  ];
  const entering = state.phase === "discussing";
  transitionTo(pi, state, "finalizing");
  updateUi(state, ctx);
  if (entering) {
    ctx.ui.notify(
      `Contract saved. Phase: finalizing — review the contract, run /implement when ready. ` +
        `(warnings: ${allWarnings.length})`,
      "info",
    );
  }
  const prevDigest = state.scanDigest;
  const digest = scanDigest(scan?.evidence ?? [], allWarnings);
  state.scanDigest = digest;
  const reportPath = await writeScanReport(ctx.cwd, scan?.evidence ?? [], allWarnings);
  let text =
    "Task saved. Phase: finalizing (read-only). " +
    "Wait for the user to run /implement once the contract is approved.";
  if (reportPath !== null) text += `\nFull scan report (uncapped): ${reportPath}`;
  if (prevDigest !== undefined) {
    if (scan === null) text += "\n\nNote: scan unavailable — apply judgment from the discussion.";
    text += `\n${ensured.message}`;
    if (preserved.preserved.length > 0) {
      text += `\n\nPreserved done behaviors: ${preserved.preserved.join(", ")}`;
    }
    text += "\n\n" + renderScanDiff(diffScanDigest(prevDigest, digest));
    text += planText;
    return { ok: true, text };
  }
  if (scan === null) {
    text += "\n\nNote: scan unavailable — apply judgment from the discussion.";
  } else if (scan.evidence.length > 0) {
    const evidence = renderEvidence(scan.evidence).split("\n").map((l) => `- ${l}`).join("\n");
    text += "\n\n## Test scan evidence (advisory)\n" + evidence;
  }
  text += `\n${ensured.message}`;
  if (preserved.preserved.length > 0) {
    text += `\n\nPreserved done behaviors: ${preserved.preserved.join(", ")}`;
  }
  if (allWarnings.length > 0) {
    text +=
      "\n\nWarnings (advisory — the contract was saved):\n" +
      allWarnings.map((w) => `warning: ${w}`).join("\n");
  }
  text += planText;
  return { ok: true, text };
}
