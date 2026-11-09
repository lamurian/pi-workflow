// T8: minimal /commit command plus the bash git-commit guardrail.
//
// /commit stages everything and steers a follow-up telling the agent to
// read the staged diff, author ONE single-line conventional message and
// call commit_changes. With nothing staged it only notifies; in the
// gated discussing/finalizing phases it refuses and stages nothing.
//
// The tool_call guard blocks bash commands that run `git commit`
// (including `git -c k=v commit`) so commits only land through the
// commit_changes tool, which runs the project's hook gate.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadState } from "./state.ts";

/** Shape of the tool_call event fields the bash guard reads. */
interface ToolCallLike {
  toolName?: unknown;
  input?: unknown;
}

/** Block reason for a bash `git commit` — must name commit_changes. */
const GIT_COMMIT_BLOCK_REASON =
  "Blocked: git commit from bash bypasses the workflow commit gate. " +
  "Read the staged diff, author one single-line conventional message that " +
  "describes it, and call the commit_changes tool instead.";

/** The steer follow-up sent when changes were staged by /commit. */
const COMMIT_FOLLOW_UP =
  "Changes are staged. Read the staged diff with `git diff --cached`, then " +
  "author ONE single-line conventional commit message (type(scope): " +
  "description, <=75 chars) that describes the diff and call the " +
  "commit_changes tool with it. Do not run git commit from bash.";

/**
 * Tokenize a bash command into whitespace-separated tokens, honoring
 * single and double quotes (a quoted run becomes one token).
 *
 * @param command - Raw bash command string.
 * @returns The token list.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasCurrent = false;
  const push = () => {
    if (hasCurrent) {
      tokens.push(current);
      current = "";
      hasCurrent = false;
    }
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else {
        current += ch;
        hasCurrent = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  push();
  return tokens;
}

/**
 * Detect a `git commit` invocation in a bash command string.
 *
 * Scans tokens for a `git` word, skips git global options (including
 * value-taking `-c`/`-C`/`--git-dir`-style pairs) and reports whether the
 * first subcommand is `commit`. Works for `git commit` and
 * `git -c k=v commit`, and for a commit chained behind other commands
 * (`npm test && git commit`). Quoted text (e.g. `echo "git commit"`) is
 * a single token and never matches.
 *
 * @param command - Raw bash command string.
 * @returns True when the command runs `git commit`.
 */
export function isGitCommitCommand(command: string): boolean {
  const tokens = tokenize(command);
  const VALUE_TAKING_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "git") continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j]!.startsWith("-")) {
      const option = tokens[j]!;
      const takesValue = option.includes("=") || !option.startsWith("--");
      if (VALUE_TAKING_OPTIONS.has(option) && j + 1 < tokens.length) {
        j += 2;
      } else if (takesValue && option.startsWith("--") === false && !VALUE_TAKING_OPTIONS.has(option) && option.length === 2) {
        // Short boolean options (e.g. --no-pager equivalents) skip one token.
        j += 1;
      } else {
        j += 1;
      }
    }
    if (j < tokens.length && tokens[j] === "commit") return true;
  }
  return false;
}

/**
 * tool_call guard: block a bash call that runs `git commit`.
 *
 * @param event - The tool_call event (toolName + input).
 * @returns `{ block: true, reason }` naming commit_changes when the bash
 *          command runs git commit; undefined for everything else.
 */
export function guardBashGitCommit(
  event: ToolCallLike,
): { block: true; reason: string } | undefined {
  if (event.toolName !== "bash") return undefined;
  const input =
    typeof event.input === "object" && event.input !== null
      ? (event.input as Record<string, unknown>)
      : {};
  const command = typeof input.command === "string" ? input.command : "";
  if (!command || !isGitCommitCommand(command)) return undefined;
  return { block: true, reason: GIT_COMMIT_BLOCK_REASON };
}

/**
 * Register the `/commit` slash command.
 *
 * Refuses with a notify (and stages nothing) during the discussing and
 * finalizing phases. Otherwise stages all changes (`git add --all`); when
 * the staged set is empty it only notifies, and when changes are staged it
 * steers a follow-up telling the agent to read the staged diff, author one
 * single-line conventional message describing it, and call commit_changes.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerCommitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("commit", {
    description:
      "Stage all changes and ask the agent to commit via commit_changes. " +
      "Usage: /commit",
    handler: async (_args, ctx) => {
      const state = loadState(ctx);
      const phase = state?.phase;
      if (phase === "discussing" || phase === "finalizing") {
        ctx.ui.notify(
          `/commit is unavailable during the ${phase} phase — the phase is ` +
            "read-only; wait until implementation is active.",
          "warning",
        );
        return;
      }

      try {
        await pi.exec("git", ["add", "--all"], { cwd: ctx.cwd });
      } catch {
        // Best-effort staging: the staged-set check below is authoritative.
      }
      const staged = await pi.exec("git", ["diff", "--cached", "--name-only"], {
        cwd: ctx.cwd,
      });
      const paths = (staged.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (paths.length === 0) {
        ctx.ui.notify(
          "Nothing staged: the working tree has no changes to commit.",
          "warning",
        );
        return;
      }
      pi.sendUserMessage(COMMIT_FOLLOW_UP, { deliverAs: "steer" });
    },
  });
}
