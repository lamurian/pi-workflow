import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadState } from "./state.ts";
import { getCommitTimeoutMs } from "./git-ops.ts";

/** Maximum characters of hook output kept in the result tail. */
export const PRECOMMIT_OUTPUT_TAIL = 4000;

/** Result of a main-process pre-commit hook run. */
export interface PrecommitCheckResult {
  /** False when the hooks/pre-commit path is missing or not executable. */
  hookPresent: boolean;
  /** Exit code of `git hook run --ignore-missing pre-commit` (1 on error/timeout). */
  exitCode: number;
  /** Combined output tail, at most PRECOMMIT_OUTPUT_TAIL characters. */
  output: string;
  /** True when the hook run hit the PI_COMMIT_TIMEOUT_MS budget. */
  timedOut: boolean;
}

/**
 * Resolve whether the project's pre-commit hook is present and executable.
 *
 * Runs `git rev-parse --git-path hooks/pre-commit` and checks the resolved
 * path (relative paths resolve against cwd) for existence and the execute
 * bit. Best-effort: any git or filesystem error yields false.
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory of the repository.
 * @returns True when the hook file exists and is executable.
 */
export async function isPrecommitHookPresent(
  pi: ExtensionAPI,
  cwd: string,
): Promise<boolean> {
  try {
    const res = await pi.exec("git", ["rev-parse", "--git-path", "hooks/pre-commit"], { cwd });
    if (res.code !== 0) return false;
    const raw = (res.stdout ?? "").trim();
    if (!raw) return false;
    const hookPath = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (!existsSync(hookPath)) return false;
    accessSync(hookPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage everything and run the project's pre-commit hook in the main process.
 *
 * Runs via pi.exec — not the sandboxed bash tool — so git writes are not
 * subject to the unit sandbox's restrictions: `git add --all`, then
 * `git hook run --ignore-missing pre-commit` under the PI_COMMIT_TIMEOUT_MS
 * budget. The hook presence is resolved separately via
 * `git rev-parse --git-path hooks/pre-commit` (must exist and be executable).
 *
 * @param pi  - ExtensionAPI reference (for exec access).
 * @param cwd - Working directory of the repository.
 * @param env - Environment map for the timeout budget (defaults to process.env).
 * @returns Hook presence, hook exit code, an output tail (≤ 4000 chars) and
 *          the timed-out flag.
 */
export async function runPrecommitCheck(
  pi: ExtensionAPI,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<PrecommitCheckResult> {
  const timeoutMs = getCommitTimeoutMs(env);
  const hookPresent = await isPrecommitHookPresent(pi, cwd);
  try {
    await pi.exec("git", ["add", "--all"], { cwd });
  } catch {
    // Best-effort staging: the hook run below is the authoritative verdict.
  }
  try {
    const res = await pi.exec(
      "git",
      ["hook", "run", "--ignore-missing", "pre-commit"],
      { cwd, timeout: timeoutMs },
    );
    const output = [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n").trim();
    return {
      hookPresent,
      exitCode: res.code,
      output: output.slice(-PRECOMMIT_OUTPUT_TAIL),
      timedOut: res.killed === true,
    };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    return {
      hookPresent,
      exitCode: 1,
      output: message.slice(-PRECOMMIT_OUTPUT_TAIL),
      timedOut: /timed out/i.test(message),
    };
  }
}

/**
 * Render a pre-commit check result as tool output text.
 *
 * @param result - The check result to format.
 * @returns Multi-line human-readable summary.
 */
export function formatPrecommitResult(result: PrecommitCheckResult): string {
  return [
    `hook present: ${result.hookPresent}`,
    `exit code: ${result.exitCode}`,
    `timed out: ${result.timedOut}`,
    "",
    result.output || "(no output)",
  ].join("\n");
}

/**
 * Register the `run_precommit_check` AI tool.
 *
 * Stages all changes and runs the project's pre-commit hook from the main
 * process, bypassing the unit sandbox's git-write restrictions. Errors
 * outside the implementing phase; also listed in DISCUSS_BLOCKED_TOOLS so
 * the phase gate blocks it during /discuss and /finalize.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerPrecommitCheckTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "run_precommit_check",
    label: "Run Pre-commit Check",
    description:
      "Stage all changes (git add --all) and run the project's pre-commit hook " +
      "via the main process (git hook run --ignore-missing pre-commit), outside " +
      "the sandbox. Returns hook presence, exit code, an output tail and whether " +
      "the run timed out. Only valid during the implementing phase.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      if (!state || state.phase !== "implementing") {
        return {
          content: [
            { type: "text", text: "run_precommit_check requires the implementing phase." },
          ],
          details: {},
          isError: true,
        };
      }
      const result = await runPrecommitCheck(pi, ctx.cwd);
      return {
        content: [{ type: "text", text: formatPrecommitResult(result) }],
        details: {},
      };
    },
  });
}
