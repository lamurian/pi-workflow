import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadState } from "./state.ts";
import { validateWorkflowConfig } from "./workflow-config-schema.ts";
import { resetWorkflowConfigCache } from "./paths.ts";

/** Inputs for a workflow config update. */
export interface WorkflowConfigUpdateInput {
  cwd: string;
  phase: string | undefined;
  patch: unknown;
  confirm: (title: string, message: string) => Promise<boolean>;
}

/** Outcome of a workflow config update. */
export interface WorkflowConfigUpdateResult {
  ok: boolean;
  text: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Apply an RFC 7386 JSON merge patch.
 *
 * @param target - Original value.
 * @param patch  - Merge patch (null deletes keys).
 * @returns The merged value (inputs not mutated).
 */
export function jsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return patch;
  const out: Record<string, unknown> = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = jsonMergePatch(out[k], v);
  }
  return out;
}

function entryArgv(e: unknown): unknown {
  return isObj(e) ? e.argv : e;
}

/**
 * List every argv the merged config would run (scoped, full, commands).
 *
 * @param config - Merged workflow config.
 * @returns Human-readable lines, one per argv.
 */
export function listConfigArgvs(config: unknown): string[] {
  const lines: string[] = [];
  const impl = isObj(config) && isObj(config.implement) ? config.implement : {};
  const tests = isObj(impl.tests) ? impl.tests : {};
  for (const kind of ["scoped", "full"] as const) {
    const list = Array.isArray(tests[kind]) ? (tests[kind] as unknown[]) : [];
    for (const e of list) lines.push(`${kind}: ${JSON.stringify(entryArgv(e))}`);
  }
  const cmds = isObj(impl.commands) ? impl.commands : {};
  for (const [name, argv] of Object.entries(cmds)) lines.push(`commands.${name}: ${JSON.stringify(argv)}`);
  return lines;
}

function simpleDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  for (const l of a) if (!b.includes(l)) out.push(`- ${l}`);
  for (const l of b) if (!a.includes(l)) out.push(`+ ${l}`);
  return out.length ? out.join("\n") : "(no changes)";
}

/**
 * Merge a patch into <cwd>/.pi/workflow.json after validation and confirmation.
 *
 * @param input - cwd, current phase, patch and a confirm callback.
 * @returns ok flag and a message for the model.
 */
export async function updateWorkflowConfig(
  input: WorkflowConfigUpdateInput,
): Promise<WorkflowConfigUpdateResult> {
  if (input.phase !== "discussing") {
    return { ok: false, text: "update_workflow_config is only allowed in the discussing phase; ask the user to run /discuss." };
  }
  const path = join(input.cwd, ".pi", "workflow.json");
  let current: unknown = {};
  let before = "{}";
  if (existsSync(path)) {
    before = readFileSync(path, "utf8");
    try {
      current = JSON.parse(before);
    } catch (e) {
      return { ok: false, text: `Existing ${path} is not valid JSON: ${String(e)}` };
    }
  }
  const merged = jsonMergePatch(current, input.patch);
  const errors = validateWorkflowConfig(merged);
  if (errors.length) {
    return { ok: false, text: `Merged config is invalid; nothing written:\n${errors.join("\n")}` };
  }
  const after = `${JSON.stringify(merged, null, 2)}\n`;
  const argvs = listConfigArgvs(merged);
  const message = [
    "Diff:",
    simpleDiff(JSON.stringify(current, null, 2), after.trimEnd()),
    "",
    "Commands that would run:",
    argvs.length ? argvs.join("\n") : "(none)",
  ].join("\n");
  const approved = await input.confirm("Update .pi/workflow.json?", message);
  if (!approved) return { ok: false, text: "User declined; workflow.json unchanged." };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after, "utf8");
  resetWorkflowConfigCache();
  return { ok: true, text: `Updated ${path}.` };
}

/**
 * Register the `update_workflow_config` tool.
 *
 * @param pi - ExtensionAPI reference.
 */
export function registerWorkflowConfigTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "update_workflow_config",
    label: "Update Workflow Config",
    description:
      "Apply a JSON merge patch to the project .pi/workflow.json. The merged result is " +
      "validated and must be confirmed by the user. Only valid during the discussing phase.",
    parameters: Type.Object({ patch: Type.Record(Type.String(), Type.Unknown()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      const res = await updateWorkflowConfig({
        cwd: ctx.cwd,
        phase: state?.phase,
        patch: (params as { patch: unknown }).patch,
        confirm: (t, m) => (ctx.hasUI ? ctx.ui.confirm(t, m) : Promise.resolve(false)),
      });
      return { content: [{ type: "text", text: res.text }], details: {}, isError: !res.ok };
    },
  });
}
