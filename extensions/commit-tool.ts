// T7.1: workflow-owned `commit_changes` tool (message mode).
//
// Stages everything, commits through the shared commit core (always
// --signoff, never --no-verify) and reports the landed short sha and
// subject. Hook rejections come back as isError with the hook output tail.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCommit } from "./commit-core.ts";
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

/**
 * Register the `commit_changes` AI tool.
 *
 * Message mode: `git add --all`, then a staged-set check (reports
 * "nothing to commit" without invoking `git commit` when empty), then the
 * signed-off commit through runCommit under the project's commit timeout
 * budget. On success the output reports the landed short sha and subject;
 * a hook rejection returns isError with the hook output tail (capped at
 * 4000 chars). Never passes --no-verify.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerCommitTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "commit_changes",
    label: "Commit Changes",
    description:
      "Stage all changes (git add --all) and create a signed-off commit " +
      "(never --no-verify, so the pre-commit hooks always run). Returns the " +
      "landed short sha and commit subject. Reports 'nothing to commit' when " +
      "no changes are staged.",
    parameters: Type.Object({ message: Type.Optional(Type.String()) }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const message =
        typeof params.message === "string" ? params.message.trim() : "";
      if (!message) {
        return {
          content: [
            { type: "text", text: "commit_changes requires a non-empty message." },
          ],
          details: {},
          isError: true,
        };
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

      let res: Awaited<ReturnType<typeof runCommit>>;
      try {
        res = await runCommit(pi, ctx.cwd, message);
      } catch (err) {
        return hookRejectionResult(String((err as Error)?.message ?? err));
      }
      if (res.code !== 0) {
        return hookRejectionResult(
          [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n"),
        );
      }

      const sha = await pi.exec("git", ["rev-parse", "--short", "HEAD"], {
        cwd: ctx.cwd,
      });
      const subject = await pi.exec("git", ["log", "-1", "--pretty=%s"], {
        cwd: ctx.cwd,
      });
      return ok(
        `committed ${(sha.stdout ?? "").trim()}: ${(subject.stdout ?? "").trim()}`,
      );
    },
  });
}
