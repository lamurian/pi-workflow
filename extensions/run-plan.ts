// Run plan: pins the exact commands save_task resolved so the user approves
// them together with the contract.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestSuite } from "./test-tool-detect.ts";

/** The resolved commands that will execute during /implement. */
export interface RunPlan {
  /** Scoped suites (per-task test tool and scope gate). */
  scoped: TestSuite[];
  /** Full-gate suites. */
  full: TestSuite[];
  /** Declared named commands from implement.commands. */
  commands: Record<string, string[]>;
  /** sha256 of the project .pi/workflow.json content ("none" when absent). */
  configHash: string;
}

/**
 * Hash the project-local .pi/workflow.json content.
 *
 * @param cwd - Project root.
 * @returns sha256 hex digest, or "none" when the file is missing.
 */
export async function hashProjectConfig(cwd: string): Promise<string> {
  try {
    const content = await readFile(join(cwd, ".pi", "workflow.json"), "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "none";
  }
}

/**
 * Build the run plan from resolved suites and declared commands.
 *
 * @param cwd      - Project root (for the config hash).
 * @param scoped   - Scoped suites.
 * @param full     - Full-gate suites.
 * @param commands - Declared named commands (may be undefined).
 * @returns The pinned run plan.
 */
export async function buildRunPlan(
  cwd: string,
  scoped: TestSuite[],
  full: TestSuite[] | undefined,
  commands: Record<string, string[]> | undefined,
): Promise<RunPlan> {
  const clone = (s: TestSuite): TestSuite => ({ ...s, argv: [...s.argv] });
  const cmds: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(commands ?? {})) {
    if (Array.isArray(v)) cmds[k] = [...v];
  }
  return {
    scoped: scoped.map(clone),
    full: (full ?? []).map(clone),
    commands: cmds,
    configHash: await hashProjectConfig(cwd),
  };
}

/**
 * Render every argv in the run plan for the save_task result.
 *
 * @param plan - The run plan.
 * @returns Markdown section listing each command.
 */
export function renderRunPlan(plan: RunPlan): string {
  const fmt = (argv: string[]): string => JSON.stringify(argv);
  const lines = ["## Run plan (approve with the contract)"];
  for (const s of plan.scoped) lines.push(`- scoped: ${fmt(s.argv)}${s.cwd ? ` @ ${s.cwd}` : ""}`);
  for (const s of plan.full) lines.push(`- full: ${fmt(s.argv)}${s.cwd ? ` @ ${s.cwd}` : ""}`);
  for (const [name, argv] of Object.entries(plan.commands)) {
    lines.push(`- command ${name}: ${fmt(argv)}`);
  }
  lines.push(`- configHash: ${plan.configHash}`);
  return lines.join("\n");
}
