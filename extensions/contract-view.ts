// Readable contract view for save_task: rendered with zero model tokens —
// returned in the tool result details, drawn by the save_task renderCall /
// renderResult slots, and pushed through ctx.ui.notify in RPC mode.

import type { ContractV2, FileStatus, PathEntry, TaskUnit } from "./contract-types.ts";
import type { Component } from "@earendil-works/pi-tui";

/**
 * Component rendering text lines verbatim — unlike pi-tui's Text, it adds
 * no padding, margins or width-based wrapping, so the view lines stay
 * exactly as rendered.
 */
class RawLines implements Component {
  private readonly lines: string[];

  /**
   * @param text - Multi-line text to display.
   */
  constructor(text: string) {
    this.lines = text.split("\n");
  }

  /**
   * @param _width - Viewport width (unused: lines are shown as-is).
   * @returns The text lines, unpadded.
   */
  render(_width: number): string[] {
    return [...this.lines];
  }

  /** No cached state to drop. */
  invalidate(): void {}
}

/** Details payload of a successful save_task result. */
export interface SaveTaskViewDetails {
  /** The rendered contract view. */
  contractView?: string;
}

/** Structural shape of a tool result as the renderResult slot sees it. */
export interface ToolResultLike {
  details?: unknown;
  content?: ReadonlyArray<{ type: string; text?: string }>;
}

const FILE_STATUSES: readonly FileStatus[] = ["A", "M", "D"];
const TASK_STATUSES = ["active", "done", "removed"] as const;
const NO_COMMIT_NOTE = "none — the commit gate falls back to";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function sanitizePaths(value: unknown): PathEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PathEntry[] = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    const path = asString(entry.path);
    if (path === undefined || path === "") continue;
    const status = asString(entry.status);
    const clean: PathEntry = { path, tasks: asStringArray(entry.tasks) };
    if (status !== undefined && (FILE_STATUSES as readonly string[]).includes(status)) {
      clean.status = status as FileStatus;
    }
    out.push(clean);
  }
  return out;
}

function sanitizeTasks(value: unknown): TaskUnit[] {
  if (!Array.isArray(value)) return [];
  const out: TaskUnit[] = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    const id = asString(entry.id);
    if (id === undefined || id === "") continue;
    const status = asString(entry.status);
    const task: TaskUnit = {
      id,
      description: asString(entry.description) ?? "",
      expectedOutput: asStringArray(entry.expectedOutput),
      status: (TASK_STATUSES as readonly string[]).includes(status ?? "")
        ? (status as TaskUnit["status"])
        : "active",
    };
    const commit = asString(entry.commit);
    if (commit !== undefined) task.commit = commit;
    out.push(task);
  }
  return out;
}

/**
 * Render the saved contract as a readable per-task view.
 *
 * Every non-removed task renders as `# Task <id>`, its commit in backticks
 * (or a fallback note naming the gate's derived subject when missing), an
 * `Assertions:` bullet list, and `Sources:`/`Tests:` bullet lists of the
 * paths the task owns, with D entries marked `(D)`.
 *
 * @param contract - The saved contract v2.
 * @returns The multi-section view text; empty only for a contract with no
 *          non-removed tasks.
 */
export function renderContractView(contract: ContractV2): string {
  const sections = contract.tasks
    .filter((task) => task.status !== "removed")
    .map((task) => {
      const lines = [`# Task ${task.id}`];
      lines.push(
        task.commit !== undefined
          ? `Commit: \`${task.commit}\``
          : `Commit: ${NO_COMMIT_NOTE} "feat: implement ${task.description}"`,
      );
      lines.push("Assertions:");
      for (const assertion of task.expectedOutput) lines.push(`- ${assertion}`);
      lines.push("Sources:");
      for (const entry of contract.sources) {
        if (entry.tasks.includes(task.id)) lines.push(`- ${entry.path}${mark(entry)}`);
      }
      lines.push("Tests:");
      for (const entry of contract.tests) {
        if (entry.tasks.includes(task.id)) lines.push(`- ${entry.path}${mark(entry)}`);
      }
      return lines.join("\n");
    });
  return sections.join("\n\n");
}

function mark(entry: PathEntry): string {
  return entry.status === "D" ? " (D)" : "";
}

/**
 * Best-effort contract view for raw save_task call arguments, for the
 * renderCall slot (the contract is not saved yet when the call renders).
 *
 * @param args - Raw tool call arguments.
 * @returns The view built from the sanitized payload, or a short note when
 *          the payload carries no renderable tasks.
 */
export function contractViewFromCallArgs(args: unknown): string {
  const record = asRecord(args);
  const view = renderContractView({
    title: asString(record.title) ?? "",
    instruction: asString(record.instruction) ?? "",
    done: asString(record.done) ?? "",
    sources: sanitizePaths(record.sources),
    tests: sanitizePaths(record.tests),
    tasks: sanitizeTasks(record.tasks),
  });
  return view === "" ? "save_task: (no renderable contract payload)" : view;
}

/**
 * Extract the display text for the renderResult slot: the view carried in
 * the result details, falling back to the model-facing text (error results
 * carry no view).
 *
 * @param result - The tool result as renderResult receives it.
 * @returns The text the result row must display.
 */
export function contractViewFromResult(result: ToolResultLike): string {
  const details = asRecord(result.details);
  if (typeof details.contractView === "string") return details.contractView;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  return typeof first?.text === "string" ? first.text : "";
}

/**
 * Render slot for save_task tool calls: shows the contract view derived
 * from the call arguments instead of the raw JSON payload.
 *
 * @param args - Raw tool call arguments.
 * @returns A component carrying the view.
 */
export function renderSaveTaskCall(args: unknown): Component {
  return new RawLines(contractViewFromCallArgs(args));
}

/**
 * Render slot for save_task tool results: shows the view from the result
 * details instead of the raw JSON payload.
 *
 * @param result - The tool result.
 * @returns A component carrying the view.
 */
export function renderSaveTaskResult(result: ToolResultLike): Component {
  return new RawLines(contractViewFromResult(result));
}
