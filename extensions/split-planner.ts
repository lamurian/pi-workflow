import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, Behavior, TaskContract } from "./state.ts";
import { runSaveTask } from "./save-task-core.ts";

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
 * with the existing unit-too-large text. Split children halt without splitting.
 *
 * @param opts     - Runtime split options.
 * @param haltText - The existing halt text used on veto/rejection.
 * @param hooks    - Child runner and halt callback.
 * @returns A halt result, or undefined when every child completed.
 */
export async function splitOrHalt<R>(opts: RuntimeSplitOptions, haltText: string, hooks: SplitOrHaltHooks<R>): Promise<R | undefined> {
  if (isSplitChild(opts.behaviorId)) return hooks.halt(haltText);
  const split = await runRuntimeSplit(opts);
  if (!split.applied) return hooks.halt(haltText);
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
  const current = state.task?.behaviors.find((b) => b.id === childId);
  child.status = "done";
  if (current) current.status = "done";
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
 * @param state      - Workflow state holding the contract.
 * @param behaviorId - Parent task id.
 * @param trigger    - Why the split was triggered.
 * @returns The task text.
 */
export function buildPlannerTask(state: WorkflowState, behaviorId: string, trigger: SplitTrigger): string {
  const task = state.contractV2?.tasks.find((t) => t.id === behaviorId);
  const why = trigger === "timeout" ? "hit the timeout halt threshold" : "reported blocked (too-large)";
  return `Task ${behaviorId} ${why}. Propose a split.\n\nParent task:\n${JSON.stringify(task ?? { id: behaviorId }, null, 2)}`;
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
 *
 * @param opts - State, ids, trigger and optional injected planner.
 * @returns Whether the split was applied, with the child ids.
 */
export async function runRuntimeSplit(opts: RuntimeSplitOptions): Promise<RuntimeSplitResult> {
  const { pi, ctx, state, behaviorId, trigger } = opts;
  if (isSplitChild(behaviorId)) return { applied: false, childIds: [], reason: "split child" };
  const taskText = buildPlannerTask(state, behaviorId, trigger);
  let output: string;
  try {
    output = await (opts.planner ?? ((t) => defaultPlanner(pi, ctx.cwd, t)))(taskText);
  } catch (err) {
    return { applied: false, childIds: [], reason: `planner failed: ${String(err)}` };
  }
  const tasks = parseSplitProposal(output);
  if (!tasks) return { applied: false, childIds: [], reason: "planner returned no proposal" };
  const payload = { operation: "split", parentId: behaviorId, tasks };
  const save = opts.save ?? runSaveTask;
  const dry = await save(structuredClone(state), payload, { pi, ctx, caller: "orchestrator" });
  if (!dry.ok) return { applied: false, childIds: [], reason: dry.text };
  const vetoMs = opts.vetoMs ?? SPLIT_VETO_MS;
  const notice = `Split ${behaviorId} into ${tasks.length} tasks; applying in ${Math.round(vetoMs / 1000)}s unless vetoed.`;
  const vetoed = await ctx.ui.confirm("Veto split?", notice, { timeout: vetoMs });
  if (vetoed) return { applied: false, childIds: [], reason: "vetoed" };
  const applied = await save(state, payload, { pi, ctx, caller: "orchestrator" });
  if (!applied.ok) return { applied: false, childIds: [], reason: applied.text };
  const childIds = (state.task?.behaviors ?? []).map((b) => b.id).filter((id) => id.startsWith(`${behaviorId}.`));
  return { applied: true, childIds };
}
