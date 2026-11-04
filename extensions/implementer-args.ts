// ─── Implementer subprocess argv builder ───────────────────────────────────────

import { fileURLToPath } from "node:url";
import { resolveChildThinking } from "./process-utils.ts";

/** Bash-free tools granted to an implementer subprocess by default. */
const DEFAULT_IMPLEMENTER_TOOLS = "read,write,edit,grep,find,ls,delete_file";

/**
 * Absolute path of the child contract-guard extension.
 *
 * Resolved from this module's location so the unit spawn can load it
 * explicitly via `--no-extensions -e <path>` regardless of the cwd the
 * subprocess is spawned in.
 *
 * @returns Absolute filesystem path of extensions/contract-guard/index.ts.
 */
export function contractGuardExtensionPath(): string {
  return fileURLToPath(new URL("./contract-guard/index.ts", import.meta.url));
}

/**
 * Resolve the tool allowlist for implementer subprocesses.
 *
 * Defaults to `read,write,edit,grep,find,ls,delete_file`; the
 * `PI_IMPLEMENTER_TOOLS` env var
 * overrides the full list for environments where tool names differ (e.g.
 * a renamed shell tool) or a tighter grant is wanted.
 *
 * @param env - Environment map (defaults to `process.env`); injectable for tests.
 * @returns Comma-separated tool names for `--tools`.
 */
export function getImplementerTools(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.PI_IMPLEMENTER_TOOLS?.trim();
  return raw ? raw : DEFAULT_IMPLEMENTER_TOOLS;
}

/**
 * Build the argv array for an implementer subprocess.
 *
 * Spawns a long-lived `pi --mode rpc` child: the task text travels over
 * stdin as a JSONL `prompt` command (never in argv), keeping stdin open
 * for later steering. Lean flags skip session/skill loading for fast
 * startup and determinism; `--no-extensions` disables extension
 * discovery while `-e` loads exactly one extension: the child
 * contract-guard that enforces the contract's file allowlist in-turn.
 * Units are bash-free: the tools are restricted to the implementer
 * allowlist (default `read,write,edit,grep,find,ls,delete_file`) — no
 * shell, no commit, no workflow state; the orchestrator owns all three.
 * A canonical `provider/id` model ref (formatModelRef) rides `--model` so
 * the child runs on the session's model; without one no --model flag
 * appears and the child uses the settings default model. The thinking
 * level comes from `resolveChildThinking` (default low; `PI_IMPLEMENTER_THINKING`
 * overrides), superseding the old hardcoded `--thinking minimal` pin that
 * broke providers whose upstream rejects that request shape.
 *
 * @param systemPrompt - Literal unit prompt text (from content/unit-prompt.md).
 * @param testExtPath  - Optional absolute path of the generated test extension
 *                       (resolveTestExtensionPath(cwd)). When set, a second
 *                       `-e <path>` flag loads it and `test` is appended to the
 *                       default tools (a `PI_IMPLEMENTER_TOOLS` override that
 *                       already lists `test` is not duplicated). Without it,
 *                       neither the flag nor the tool appears.
 * @param modelRef     - Optional canonical `provider/id` model reference passed
 *                       as `--model <ref>`; omitted when absent.
 * @param thinkingFloor - Optional escalation floor for `--thinking`; the
 *                       effective level is max(env base, floor).
 * @returns Array of CLI arguments for the implementer subprocess.
 */
export function buildImplementerArgs(
  systemPrompt: string,
  testExtPath?: string,
  modelRef?: string,
  thinkingFloor?: string,
): string[] {
  const tools = getImplementerTools();
  const granted =
    testExtPath && !tools.split(",").some((name) => name.trim() === "test")
      ? `${tools},test`
      : tools;
  const args: string[] = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "-e", contractGuardExtensionPath(),
  ];
  if (testExtPath) {
    args.push("-e", testExtPath);
  }
  args.push(
    "--no-skills",
    "--offline",
    "--thinking", resolveChildThinking("implementer", thinkingFloor),
    "--tools", granted,
  );
  // Session model: one canonical provider/id reference resolves exactly.
  if (modelRef) {
    args.push("--model", modelRef);
  }
  if (systemPrompt.trim()) {
    args.push("--append-system-prompt", systemPrompt);
  }
  return args;
}
