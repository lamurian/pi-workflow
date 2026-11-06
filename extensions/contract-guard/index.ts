/**
 * Child contract-guard extension (T3): loaded inside implementer units via
 * `--no-extensions -e <this file>` (never via package.json `pi.extensions`).
 *
 * It enforces the contract's file allowlist in-turn:
 *
 * - lets `read`, `grep`, `find`, `ls` and the generated `test` tool through
 *   untouched;
 * - checks `write`, `edit` and `delete_file` against the pure allowlist
 *   core (`extensions/contract-guard-core.ts`) using the payload written
 *   by the orchestrator to the file named by `PI_UNIT_FILE` (T5;
 *   `PI_CONTRACT_GUARD_FILE` is the read-fallback for one release);
 * - blocks every other tool, including `bash`, even when the unit was
 *   granted it via `PI_IMPLEMENTER_TOOLS`;
 * - fails closed (all mutating tools blocked) when the guard file is
 *   missing or invalid.
 *
 * It also registers the `delete_file` tool: unlink a declared-D file from
 * disk; missing files surface as isError results.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkToolAction, type DeclaredFile } from "../contract-guard-core.ts";

/** Validated guard payload (subset of the JSON file's fields). */
interface GuardPayload {
  /** Absolute repository root the allowlist paths resolve against. */
  repoRoot: string;
  /** The derived allowlist entries (v2 `allowlist` / legacy `files`). */
  files: DeclaredFile[];
  /** The unit's task id: enables strict per-task ownership checks. */
  taskId?: string;
  /** T7: FULL-GATE fix unit — skip per-task ownership (allowlist still enforced). */
  ownsAll?: boolean;
}

/** Shape of the `tool_call` event fields this guard reads. */
interface ToolCallLike {
  toolName?: unknown;
  input?: unknown;
}

/** Tools that never touch files and always pass the guard (`test` is the
 * generated local test extension — allowed so bash-free units can verify). */
const PASSTHROUGH_TOOLS = new Set(["read", "grep", "find", "ls", "test"]);
/** Tools checked against the contract's file allowlist. */
const MUTATING_TOOLS = new Set(["write", "edit", "delete_file"]);
/** Fail-closed reason: must mention "missing or invalid" per contract. */
const FAIL_CLOSED_REASON =
  "Blocked: contract guard file missing or invalid (PI_UNIT_FILE / PI_CONTRACT_GUARD_FILE) — " +
  "the file allowlist cannot be verified, so all file-mutating tools are " +
  "disabled for this unit. The orchestrator must re-run /implement.";

/**
 * Read and validate the payload file named by the env var (T5: PI_UNIT_FILE,
 * falling back to the legacy PI_CONTRACT_GUARD_FILE for one release).
 *
 * Anything that is not a well-formed payload — missing file, broken JSON,
 * missing/empty `repoRoot`, entries with a non-string path or a status
 * outside A|M|D, malformed ownership refs, a malformed unit slice, wrong
 * optional field types — is rejected as a whole so the hook fails closed
 * instead of enforcing a partial allowlist. v2 payloads carry the derived
 * `allowlist` (refs, optional status) and `unit.id`; legacy payloads carry
 * `files` (tasks) and `taskId`.
 *
 * @param env - Environment map (normally `process.env`).
 * @returns The validated payload, or undefined when missing or invalid.
 */
function readGuardPayload(
  env: Record<string, string | undefined>,
): GuardPayload | undefined {
  const file = env.PI_UNIT_FILE ?? env.PI_CONTRACT_GUARD_FILE;
  if (!file) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.repoRoot !== "string" || !candidate.repoRoot) {
    return undefined;
  }
  // v2 payloads carry the derived `allowlist`; legacy payloads carry `files`.
  const rawEntries = candidate.allowlist ?? candidate.files;
  if (!Array.isArray(rawEntries)) return undefined;
  const files: DeclaredFile[] = [];
  for (const entry of rawEntries) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const fileEntry = entry as Record<string, unknown>;
    if (typeof fileEntry.path !== "string" || !fileEntry.path) return undefined;
    const status = fileEntry.status;
    // Absent status is legal in v2 (write-authorized); A/M/D are the only
    // valid values when present.
    if (status !== undefined && status !== "A" && status !== "M" && status !== "D") {
      return undefined;
    }
    // Ownership refs (T4/T5): PathEntry-style `tasks` or derived-allowlist-
    // style `refs`. A malformed refs array invalidates the whole payload
    // (fail closed).
    const rawRefs = fileEntry.tasks ?? fileEntry.refs;
    let tasks: string[] | undefined;
    if (rawRefs !== undefined) {
      if (
        !Array.isArray(rawRefs) ||
        !rawRefs.every((t) => typeof t === "string" && t.trim() !== "")
      ) {
        return undefined;
      }
      tasks = [...(rawRefs as string[])];
    }
    files.push({
      path: fileEntry.path,
      ...(status !== undefined ? { status: status as "A" | "M" | "D" } : {}),
      ...(tasks ? { tasks } : {}),
    });
  }
  if (candidate.baselineHead !== undefined && typeof candidate.baselineHead !== "string") {
    return undefined;
  }
  if (candidate.baselineExisting !== undefined) {
    const list = candidate.baselineExisting;
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
      return undefined;
    }
  }
  // T5: the unit slice — `unit.id` is the task id for per-task ownership.
  let taskId: string | undefined;
  if (candidate.unit !== undefined) {
    const unit = candidate.unit;
    if (typeof unit !== "object" || unit === null || Array.isArray(unit)) return undefined;
    const id = (unit as Record<string, unknown>).id;
    if (typeof id !== "string" || id === "") return undefined;
    taskId = id;
  }
  if (candidate.taskId !== undefined) {
    if (typeof candidate.taskId !== "string" || candidate.taskId === "") return undefined;
    taskId ??= candidate.taskId;
  }
  // T7: ownsAll (FULL-GATE fix unit) — validated as a boolean; when set the
  // ownership check is skipped below (the allowlist itself still applies).
  const ownsAll = candidate.ownsAll === true;
  if (candidate.ownsAll !== undefined && typeof candidate.ownsAll !== "boolean") return undefined;
  return {
    repoRoot: candidate.repoRoot,
    files,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(ownsAll ? { ownsAll: true } : {}),
  };
}

/**
 * The guard's `tool_call` hook: pass, check, or block one tool call.
 *
 * @param env   - Environment map carrying PI_CONTRACT_GUARD_FILE.
 * @param event - The `tool_call` event (toolName + input).
 * @returns Undefined when the call may proceed, otherwise `{ block, reason }`.
 */
export async function guardToolCall(
  env: Record<string, string | undefined>,
  event: ToolCallLike,
): Promise<{ block: true; reason: string } | undefined> {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  if (toolName && PASSTHROUGH_TOOLS.has(toolName)) return undefined;
  if (toolName === "bash") {
    return {
      block: true,
      reason:
        "Blocked: bash is not available to this unit — implementer units are " +
        "file coders with read, grep, find, ls, the test tool, write, edit and " +
        "delete_file only.",
    };
  }
  if (toolName && MUTATING_TOOLS.has(toolName)) {
    const payload = readGuardPayload(env);
    if (!payload) return { block: true, reason: FAIL_CLOSED_REASON };
    const input =
      typeof event.input === "object" && event.input !== null
        ? (event.input as Record<string, unknown>)
        : {};
    const path = typeof input.path === "string" ? input.path : "";
    if (!path) {
      return {
        block: true,
        reason: `Blocked: ${toolName} requires a file path in its input.`,
      };
    }
    const check = checkToolAction({
      action: toolName,
      path,
      cwd: payload.repoRoot,
      files: payload.files,
      // T7: ownsAll skips per-task ownership; the allowlist still applies.
      ...(payload.taskId !== undefined && !payload.ownsAll ? { taskId: payload.taskId } : {}),
    });
    if (check.allowed) return undefined;
    return { block: true, reason: check.reason };
  }
  return {
    block: true,
    reason:
      `Blocked: tool "${toolName || "(unknown)"}" is not available to this ` +
      "unit — only read, grep, find, ls, the test tool, and the declared-file " +
      "mutations write, edit and delete_file are granted.",
  };
}

/** The `delete_file` tool: unlink a declared-D file from disk. */
const deleteFileTool = {
  name: "delete_file",
  label: "Delete File",
  description:
    "Delete a file from disk. Allowed only for paths the contract declares " +
    "with status D — the contract guard enforces the allowlist.",
  parameters: Type.Object({
    path: Type.String({ description: "Path of the file to delete, relative to the working directory" }),
  }),
  async execute(
    _toolCallId: string,
    params: { path: string },
    _signal: unknown,
    _onUpdate: unknown,
    ctx: { cwd: string },
  ) {
    try {
      unlinkSync(resolve(ctx.cwd, params.path));
      return { content: [{ type: "text" as const, text: `Deleted ${params.path}` }], details: {} };
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      return {
        content: [{ type: "text" as const, text: `delete_file failed: ${detail}` }],
        details: {},
        isError: true,
      };
    }
  },
};

/**
 * Build the contract-guard extension function for one unit process.
 *
 * Registers the `tool_call` hook and the `delete_file` tool on the
 * given extension API. The env argument is read at hook time, so a
 * missing guard file fails closed per call rather than at load time.
 *
 * @param env - Environment carrying PI_CONTRACT_GUARD_FILE (defaults to process.env).
 * @returns The extension function to invoke with the extension API.
 */
export function createContractGuardExtension(
  env: Record<string, string | undefined> = process.env,
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event) => guardToolCall(env, event as ToolCallLike));
    pi.registerTool(deleteFileTool);
  };
}

/**
 * Default extension entry point for `pi -e <this file>`.
 *
 * Uses the process environment, so the orchestrator-provided
 * PI_CONTRACT_GUARD_FILE is visible without any extra wiring.
 *
 * @param pi - ExtensionAPI reference.
 */
export default function contractGuardExtension(pi: ExtensionAPI): void {
  createContractGuardExtension(process.env)(pi);
}
