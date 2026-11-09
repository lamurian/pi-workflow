// T7.1/T7.2: workflow-owned `commit_changes` tool.
//
// Message mode stages everything; taskId mode stages only the contract
// task's owned changed paths (never `git add --all`). Both commit through
// the shared commit core (always --signoff, never --no-verify) and report
// the landed short sha and subject. Hook rejections come back as isError
// with the hook output tail.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCommit } from "./commit-core.ts";
import { deriveAllowlist } from "./contract-derive.ts";
import { readChangedPaths } from "./git-ops.ts";
import { loadState } from "./state.ts";
import { PRECOMMIT_OUTPUT_TAIL } from "./precommit-check.ts";

/** Tool result text when nothing is staged: a report, never an error. */
const NOTHING_TO_COMMIT = "nothing to commit: no staged changes.";

/**
 * Build the isError result for a rejected commit: a short hook-flavored
 * header plus the tail of the hook output (stdout+stderr), capped at
 * PRECOMMIT_OUTPUT_TAIL characters.
 *
 * @param output - Combined stdout/stderr of the failed `git commit`.
 * @returns Tool result with isError set.
 */
function hookRejectionResult(output: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
  isError: true;
} {
  const tail = output.slice(-PRECOMMIT_OUTPUT_TAIL);
  return {
    content: [
      {
        type: "text",
        text: `commit failed; pre-commit hook output (tail):\n${tail || "(no output)"}`,
      },
    ],
    details: {},
    isError: true,
  };
}

/** Successful tool result carrying the report text. */
function ok(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
} {
  return { content: [{ type: "text", text }], details: {} };
}

/** isError tool result carrying a plain-text reason. */
function fail(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
  isError: true;
} {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}

/**
 * Commit through the shared commit core and build the tool report.
 *
 * On success the output reports the landed short sha and subject; a hook
 * rejection returns isError with the hook output tail (capped at
 * PRECOMMIT_OUTPUT_TAIL chars). Never passes --no-verify.
 *
 * @param pi      - ExtensionAPI reference.
 * @param cwd     - Repository working directory.
 * @param message - Commit subject.
 * @param paths   - Optional path limit (`--only -- <paths>`) for a scoped commit.
 * @returns The tool result (report, or isError on hook rejection).
 */
async function commitAndReport(
  pi: ExtensionAPI,
  cwd: string,
  message: string,
  paths?: readonly string[],
): Promise<
  | { content: Array<{ type: "text"; text: string }>; details: Record<string, never> }
  | { content: Array<{ type: "text"; text: string }>; details: Record<string, never>; isError: true }
> {
  let res: Awaited<ReturnType<typeof runCommit>>;
  try {
    res = await runCommit(pi, cwd, message, undefined, paths);
  } catch (err) {
    return hookRejectionResult(String((err as Error)?.message ?? err));
  }
  if (res.code !== 0) {
    return hookRejectionResult(
      [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n"),
    );
  }

  const sha = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd });
  const subject = await pi.exec("git", ["log", "-1", "--pretty=%s"], { cwd });
  return ok(
    `committed ${(sha.stdout ?? "").trim()}: ${(subject.stdout ?? "").trim()}`,
  );
}

/**
 * Contract-driven taskId mode: stage only the task's owned changed paths
 * (never `git add --all`) and commit with the contract task's commit
 * message, path-limited via the shared commit core.
 *
 * @param pi     - ExtensionAPI reference.
 * @param ctx    - Tool call context (cwd + workflow state session).
 * @param taskId - Contract task id to commit for.
 * @returns The tool result (report, error, or hook rejection).
 */
async function runTaskIdMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  taskId: string,
) {
  const contract = loadState(ctx)?.contractV2;
  const task = contract?.tasks.find((t) => t.id === taskId);
  if (!contract || !task) {
    return fail(
      `commit_changes: no task ${taskId} in the workflow contract.`,
    );
  }
  const message =
    task.commit?.trim() || `feat: implement ${task.description}`;

  // Owned changed paths: the task's slice of the contract allowlist,
  // intersected with the current dirty set (status covers staged,
  // unstaged and untracked work).
  const changed = new Set(await readChangedPaths(pi, ctx.cwd));
  const ownedChanged = deriveAllowlist(contract)
    .filter((entry) => entry.refs.includes(taskId))
    .map((entry) => entry.path)
    .filter((path) => changed.has(path));
  if (ownedChanged.length === 0) {
    return ok(NOTHING_TO_COMMIT);
  }

  // Path-scoped staging: only the task's owned paths enter the index.
  try {
    await pi.exec("git", ["add", "--", ...ownedChanged], { cwd: ctx.cwd });
  } catch {
    // Best-effort staging: the path-limited commit below is authoritative.
  }
  return await commitAndReport(pi, ctx.cwd, message, ownedChanged);
}

/**
 * Register the `commit_changes` AI tool.
 *
 * Message mode: `git add --all`, then a staged-set check (reports
 * "nothing to commit" without invoking `git commit` when empty), then the
 * signed-off commit through runCommit under the project's commit timeout
 * budget. taskId mode: stages only the contract task's owned changed paths
 * (`git add -- <paths>`, never `--all`) and commits with that task's
 * contract commit message, path-limited via `--only -- <paths>`. On success
 * the output reports the landed short sha and subject; a hook rejection
 * returns isError with the hook output tail (capped at 4000 chars). Never
 * passes --no-verify.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerCommitTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "commit_changes",
    label: "Commit Changes",
    description:
      "Create a signed-off commit (never --no-verify, so the pre-commit hooks " +
      "always run). With taskId: stage only that contract task's owned changed " +
      "paths (never git add --all) and commit with the task's contract commit " +
      "message. Without taskId: stage all changes (git add --all) and commit the " +
      "given message. Returns the landed short sha and commit subject. Reports " +
      "'nothing to commit' when no changes are staged.",
    parameters: Type.Object({
      message: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskId =
        typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (taskId) {
        return await runTaskIdMode(pi, ctx, taskId);
      }
      const message =
        typeof params.message === "string" ? params.message.trim() : "";
      if (!message) {
        return fail("commit_changes requires a non-empty message.");
      }

      // Stage everything first so the staged-set check below reflects the
      // full working tree, and so staging always precedes the commit.
      try {
        await pi.exec("git", ["add", "--all"], { cwd: ctx.cwd });
      } catch {
        // Best-effort staging: the staged-set check below is authoritative.
      }

      const staged = await pi.exec("git", ["diff", "--cached", "--name-only"], {
        cwd: ctx.cwd,
      });
      const stagedPaths = (staged.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (stagedPaths.length === 0) {
        return ok(NOTHING_TO_COMMIT);
      }

      return await commitAndReport(pi, ctx.cwd, message);
    },
  });
}
