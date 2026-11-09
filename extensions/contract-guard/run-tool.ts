/**
 * The `run` tool owned by the contract guard: executes the pinned argv of a
 * command name listed for the unit's task (payload.unit.commands) from
 * payload.commands, with cwd payload.repoRoot.
 */

import { readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SUITE_TIMEOUT_MS, OUTPUT_TAIL_CHARS } from "../test-extension-constants.ts";

/** Tool result shape returned by the run tool. */
interface RunResult {
  content: { type: "text"; text: string }[];
  details: Record<string, never>;
  isError?: boolean;
}

function readPayload(env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  const file = env.PI_UNIT_FILE ?? env.PI_CONTRACT_GUARD_FILE;
  if (!file) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function say(text: string, isError: boolean): RunResult {
  return { content: [{ type: "text", text }], details: {}, ...(isError ? { isError: true } : {}) };
}

/**
 * Build the `run` tool definition bound to an env map and extension API.
 *
 * @param pi  - Extension API used for `pi.exec`.
 * @param env - Environment carrying PI_UNIT_FILE / PI_CONTRACT_GUARD_FILE.
 * @returns The tool definition to pass to `pi.registerTool`.
 */
export function createRunTool(
  pi: Pick<ExtensionAPI, "exec">,
  env: Record<string, string | undefined> = process.env,
) {
  return {
    name: "run",
    label: "Run command",
    description:
      "Run a pinned project command by name. Only the command names listed " +
      "for this unit's task are allowed; the argv is fixed in the unit payload.",
    parameters: Type.Object({
      name: Type.String({ description: "Command name listed for this task." }),
    }),
    async execute(
      _toolCallId: string,
      params: { name: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<RunResult> {
      const name = typeof params?.name === "string" ? params.name : "";
      const payload = readPayload(env) ?? {};
      const unit = (payload.unit ?? {}) as Record<string, unknown>;
      const allowed = Array.isArray(unit.commands)
        ? unit.commands.filter((c): c is string => typeof c === "string")
        : [];
      const table = (payload.commands ?? {}) as Record<string, unknown>;
      const argv = Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
      const valid =
        Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === "string");
      if (!allowed.includes(name) || !valid) {
        return say(
          `command ${JSON.stringify(name)} is not listed for this task (allowed: ` +
            `${allowed.join(", ") || "none"}). Nothing was run.`,
          true,
        );
      }
      const args = argv as string[];
      const cwd = typeof payload.repoRoot === "string" && payload.repoRoot ? payload.repoRoot : ctx.cwd;
      // Same budget rule as the test tool: PI_TEST_TIMEOUT_MS wins when it is
      // a positive number, otherwise DEFAULT_SUITE_TIMEOUT_MS.
      const timeoutRaw = Number(env.PI_TEST_TIMEOUT_MS);
      const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? timeoutRaw
        : DEFAULT_SUITE_TIMEOUT_MS;
      let result: { stdout: string; stderr: string; code: number; killed?: boolean };
      try {
        result = await pi.exec(args[0] as string, args.slice(1), { cwd, timeout });
      } catch (err) {
        return say(`## ${name}\nspawn failed: ${String((err as Error)?.message ?? err)}`, true);
      }
      const joined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const capped =
        joined.length > OUTPUT_TAIL_CHARS
          ? "\u2026" + joined.slice(-OUTPUT_TAIL_CHARS)
          : joined;
      const out = capped || "(no output)";
      const ok = result.code === 0 && !result.killed;
      return say(`## ${name}\nexit ${result.code}${result.killed ? " (killed)" : ""}\n${out}`, !ok);
    },
  };
}
