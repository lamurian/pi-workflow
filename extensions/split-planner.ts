import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, Behavior, TaskContract } from "./state.ts";
import { renderFindingsSection } from "./findings-ledger.ts";
import { runSaveTask } from "./save-task-core.ts";
import { setTaskStatus } from "./task-status.ts";

/** Veto window for a runtime split proposal, in milliseconds. */
export const SPLIT_VETO_MS = 60_000;

/** Tools available to the read-only planner child. */
export const PLANNER_TOOLS = ["read", "grep", "find", "ls"];

/** Why a runtime split was triggered. */
export type SplitTrigger = "timeout" | "too-large";

/** Planner function: returns the raw planner output (JSON proposal text). */
export type SplitPlanner = (taskText: string) => Promise<string>;

/** Inputs for one runtime split attempt. */
export interface RuntimeSplitOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: WorkflowState;
  behaviorId: string;
  trigger: SplitTrigger;
  /** Injected planner; defaults to a read-only pi child. */
  planner?: SplitPlanner;
  /** Veto window override (tests). */
  vetoMs?: number;
  /** Injected save_task pipeline (tests); defaults to runSaveTask. */
  save?: typeof runSaveTask;
}

/** Callbacks for splitOrHalt. */
export interface SplitOrHaltHooks<R> {
  /** Run one split child to completion; returns a halt result or undefined. */
  runChild: (childId: string) => Promise<R | undefined>;
  /** Halt with the given text. */
  halt: (text: string) => Promise<R>;
}

/**
 * Try a runtime split; on success run every child in order, otherwise halt
 * with the existing unit-too-large text plus a final line naming the
 * runRuntimeSplit reason (`Runtime split not applied: <reason>`). Split
 * children halt without splitting.
 *
 * @param opts     - Runtime split options.
 * @param haltText - The existing halt text used on veto/rejection.
 * @param hooks    - Child runner and halt callback.
 * @returns A halt result, or undefined when every child completed.
 */
export async function splitOrHalt<R>(opts: RuntimeSplitOptions, haltText: string, hooks: SplitOrHaltHooks<R>): Promise<R | undefined> {
  if (isSplitChild(opts.behaviorId)) return hooks.halt(haltText);
  const split = await runRuntimeSplit(opts);
  if (!split.applied) return hooks.halt(`${haltText}\nRuntime split not applied: ${split.reason ?? "unknown"}`);
  for (const id of split.childIds) {
    const res = await hooks.runChild(id);
    if (res !== undefined) return res;
  }
  return undefined;
}

/**
 * Run one split child against the CURRENT state.task (runSaveTask replaces it, so pre-split
 * snapshots are stale). Skips children already done, marks the child done and persists on success.
 *
 * @param state   - Workflow state (state.task is read at call time).
 * @param childId - Child behavior id.
 * @param run     - Runs the child behavior with the current task contract.
 * @param persist - Persists state after the child completes.
 * @returns A halt result, or undefined when the child completed or was skipped.
 */
export async function runSplitChild<R>(
  state: WorkflowState,
  childId: string,
  run: (child: Behavior, task: TaskContract) => Promise<R | undefined>,
  persist: () => void,
): Promise<R | undefined> {
  const task = state.task;
  const child = task?.behaviors.find((b) => b.id === childId);
  if (!task || !child || child.status === "done") return undefined;
  const res = await run(child, task);
  if (res !== undefined) return res;
  child.status = "done";
  setTaskStatus(state, childId, "done");
  persist();
  return undefined;
}

/** Outcome of a runtime split attempt. */
export interface RuntimeSplitResult {
  applied: boolean;
  childIds: string[];
  reason?: string;
}

/**
 * True when the behavior id names a split child (e.g. "T3.1"); children never split again.
 *
 * @param behaviorId - Behavior id.
 * @returns Whether the id is a split child id.
 */
export function isSplitChild(behaviorId: string): boolean {
  return /\.\d+$/.test(behaviorId);
}

/**
 * Extract the split proposal tasks from planner output (last JSON block or raw JSON).
 *
 * @param text - Raw planner output.
 * @returns The tasks array, or undefined when unparseable.
 */
export function parseSplitProposal(text: string): unknown[] | undefined {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = blocks.length ? [blocks[blocks.length - 1]] : [text];
  for (const raw of candidates) {
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { tasks?: unknown }).tasks)) {
        return (parsed as { tasks: unknown[] }).tasks;
      }
    } catch { /* unparseable */ }
  }
  return undefined;
}

/**
 * Build the planner child's task text for one parent task.
 *
 * Lists the parent's expectedOutput assertions numbered from 0 (children
 * reference them by integer index) and appends the behavior's findings
 * ledger section (own + global entries, scoped like unit task texts).
 *
 * @param state      - Workflow state holding the contract and findings.
 * @param behaviorId - Parent task id.
 * @param trigger    - Why the split was triggered.
 * @returns The task text.
 */
export function buildPlannerTask(state: WorkflowState, behaviorId: string, trigger: SplitTrigger): string {
  const task = state.contractV2?.tasks.find((t) => t.id === behaviorId);
  const why = trigger === "timeout" ? "hit the timeout halt threshold" : "reported blocked (too-large)";
  const assertions = task?.expectedOutput ?? [];
  // expectedOutput is dropped from the JSON parent: it renders as the numbered list below.
  const parentJson = JSON.stringify(task ? { ...task, expectedOutput: undefined } : { id: behaviorId }, null, 2);
  const numbered = assertions.map((assertion, i) => `${i}: ${assertion}`);
  const sections = [
    `Task ${behaviorId} ${why}. Propose a split.`,
    `Parent task:\n${parentJson}`,
    numbered.length > 0
      ? "Parent expectedOutput assertions, numbered from 0 — children reference them by " +
        "integer index in expectedOutput and never restate the assertion text:\n" +
        numbered.join("\n")
      : "",
    renderFindingsSection(state.findings, behaviorId),
  ];
  return sections.filter((section) => section.length > 0).join("\n\n");
}

/** Default planner: a read-only pi child limited to PLANNER_TOOLS. */
async function defaultPlanner(pi: ExtensionAPI, cwd: string, taskText: string): Promise<string> {
  const promptPath = fileURLToPath(new URL("../content/split-planner.md", import.meta.url));
  const prompt = await readFile(promptPath, "utf8");
  const res = await pi.exec("pi", ["-p", "--no-session", "--tools", PLANNER_TOOLS.join(","), "--system-prompt", prompt, taskText], { cwd, timeout: 300_000 });
  return res.stdout ?? "";
}

/**
 * Plan, dry-run, offer a timed veto, then apply a runtime split of one task.
 * The veto window is non-blocking: a throwing confirm counts as no veto and a
 * confirm that resolves after its timeout without an answer proceeds.
 * T6/fix D: a missing proposal, an invalid index or a dry-run save_task
 * rejection re-runs the planner exactly once with the reason appended to the
 * task text; the second outcome is final.
 *
 * @param opts - State, ids, trigger and optional injected planner.
 * @returns Whether the split was applied, with the child ids and, on failure,
 *          the reason the split was not applied.
 */
export async function runRuntimeSplit(opts: RuntimeSplitOptions): Promise<RuntimeSplitResult> {
  const { pi, ctx, state, behaviorId, trigger } = opts;
  if (isSplitChild(behaviorId)) return { applied: false, childIds: [], reason: "split child" };
  const baseText = buildPlannerTask(state, behaviorId, trigger);
  const planner = opts.planner ?? ((t: string) => defaultPlanner(pi, ctx.cwd, t));
  const save = opts.save ?? runSaveTask;
  // T6/fix D: one repair round — a missing proposal, an invalid index or a
  // dry-run rejection re-runs the planner once with the reason appended; the
  // second outcome is final (round 1's `continue` falls out of the loop).
  let reason: string | undefined;
  for (let round = 0; round < 2; round++) {
    const taskText =
      reason === undefined
        ? baseText
        : `${baseText}\n\nPrevious attempt failed: ${reason}\nPropose a new split; this second proposal is final.`;
    let output: string;
    try {
      output = await planner(taskText);
    } catch (err) {
      return { applied: false, childIds: [], reason: `planner failed: ${String(err)}` };
    }
    const tasks = parseSplitProposal(output);
    if (!tasks) {
      reason = "planner returned no proposal";
      continue;
    }
    // T5/fix D: children carry 0-based indices into the parent's assertions;
    // map them to the exact strings before any save_task call, rejecting a
    // non-integer or out-of-range index without submitting the proposal.
    const assertions = state.contractV2?.tasks.find((t) => t.id === behaviorId)?.expectedOutput ?? [];
    const resolved: unknown[] = [];
    let invalid: string | undefined;
    for (let i = 0; i < tasks.length && invalid === undefined; i++) {
      const child = tasks[i];
      if (!child || typeof child !== "object") {
        resolved.push(child);
        continue;
      }
      const record = child as Record<string, unknown>;
      const indices = record.expectedOutput;
      if (!Array.isArray(indices)) {
        resolved.push(record); // save_task rejects the shape with its own reason.
        continue;
      }
      const mapped: string[] = [];
      for (const entry of indices) {
        if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry >= assertions.length) {
          invalid = `invalid expectedOutput index ${JSON.stringify(entry)} in child ${i + 1}`;
          break;
        }
        mapped.push(assertions[entry]);
      }
      if (invalid === undefined) resolved.push({ ...record, expectedOutput: mapped });
    }
    if (invalid !== undefined) {
      reason = invalid;
      continue;
    }
    const payload = { operation: "split", parentId: behaviorId, tasks: resolved };
    const dry = await save(structuredClone(state), payload, { pi, ctx, caller: "orchestrator" });
    if (!dry.ok) {
      reason = dry.text;
      continue;
    }
    const vetoMs = opts.vetoMs ?? SPLIT_VETO_MS;
    const notice = `Split ${behaviorId} into ${tasks.length} tasks; applying in ${Math.round(vetoMs / 1000)}s unless vetoed.`;
    let vetoed = false;
    try {
      vetoed = Boolean(await ctx.ui.confirm("Veto split?", notice, { timeout: vetoMs }));
    } catch {
      vetoed = false; // UI failure or timeout without an answer: proceed with the split.
    }
    if (vetoed) return { applied: false, childIds: [], reason: "vetoed" };
    const applied = await save(state, payload, { pi, ctx, caller: "orchestrator" });
    if (!applied.ok) return { applied: false, childIds: [], reason: applied.text };
    const childIds = (state.task?.behaviors ?? []).map((b) => b.id).filter((id) => id.startsWith(`${behaviorId}.`));
    return { applied: true, childIds };
  }
  return { applied: false, childIds: [], reason: reason ?? "unknown" };
}
