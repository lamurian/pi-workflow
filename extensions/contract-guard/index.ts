/**
 * Child contract-guard extension (T3): loaded inside implementer units via
 * `--no-extensions -e <this file>` (never via package.json `pi.extensions`).
 *
 * It enforces the contract's file allowlist in-turn:
 *
 * - lets `read`, `grep`, `find` and `ls` through untouched;
 * - checks `write`, `edit` and `delete_file` against the pure allowlist
 *   core (`extensions/contract-guard-core.ts`) using the payload written
 *   by the orchestrator to the file named by `PI_CONTRACT_GUARD_FILE`;
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
  /** The contract's declared allowlist entries. */
  files: DeclaredFile[];
}

/** Shape of the `tool_call` event fields this guard reads. */
interface ToolCallLike {
  toolName?: unknown;
  input?: unknown;
}

/** Tools that never touch files and always pass the guard. */
const PASSTHROUGH_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Tools checked against the contract's file allowlist. */
const MUTATING_TOOLS = new Set(["write", "edit", "delete_file"]);
/** Fail-closed reason: must mention "missing or invalid" per contract. */
const FAIL_CLOSED_REASON =
  "Blocked: contract guard file missing or invalid (PI_CONTRACT_GUARD_FILE) — " +
  "the file allowlist cannot be verified, so all file-mutating tools are " +
  "disabled for this unit. The orchestrator must re-run /implement.";

/**
 * Read and validate the guard payload file named by the env var.
 *
 * Anything that is not a well-formed payload — missing file, broken JSON,
 * missing/empty `repoRoot`, entries with a non-string path or a status
 * outside A|M|D, wrong optional field types — is rejected as a whole so
 * the hook fails closed instead of enforcing a partial allowlist.
 *
 * @param env - Environment map (normally `process.env`).
 * @returns The validated payload, or undefined when missing or invalid.
 */
function readGuardPayload(
  env: Record<string, string | undefined>,
): GuardPayload | undefined {
  const file = env.PI_CONTRACT_GUARD_FILE;
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
  if (!Array.isArray(candidate.files)) return undefined;
  const files: DeclaredFile[] = [];
  for (const entry of candidate.files) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const fileEntry = entry as Record<string, unknown>;
    if (typeof fileEntry.path !== "string" || !fileEntry.path) return undefined;
    const status = fileEntry.status;
    if (status !== "A" && status !== "M" && status !== "D") return undefined;
    files.push({ path: fileEntry.path, status });
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
  return { repoRoot: candidate.repoRoot, files };
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
        "file coders with read, grep, find, ls, write, edit and delete_file only.",
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
    });
    if (check.allowed) return undefined;
    return { block: true, reason: check.reason };
  }
  return {
    block: true,
    reason:
      `Blocked: tool "${toolName || "(unknown)"}" is not available to this ` +
      "unit — only read, grep, find, ls and the declared-file mutations " +
      "write, edit and delete_file are granted.",
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
      return { content: [{ type: "text" as const, text: `Deleted ${params.path}` }] };
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      return {
        content: [{ type: "text" as const, text: `delete_file failed: ${detail}` }],
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
