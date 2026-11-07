import type { SlopConfig } from "./slop-config.ts";

/** Brainstorming behavior configuration. */
export interface BrainstormConfig {
  /** Skip the pre-commit/pre-push/env questionnaire. @default false */
  skipQuestionnaire?: boolean;
  /** Questionnaire topics to skip ("pre-commit", "pre-push", "env-management"). */
  skipTopics?: string[];
  /** Skip the ADR -> Spec -> Plan ceremony for small changes. @default false */
  skipCeremony?: boolean;
}

/** Scoped suite entry: argv or {argv, scope?, cwd?}. */
export type ScopedTestEntry =
  | string[]
  | { argv: string[]; scope?: "files" | "packages" | "full"; cwd?: string };

/** Full suite entry: argv or {argv, cwd?}. */
export type FullTestEntry = string[] | { argv: string[]; cwd?: string };

/** Implementation (TDD) behavior configuration. */
export interface ImplementConfig {
  /** Require a failing test before implementation. @default true */
  enforceTdd?: boolean;
  /** Custom test command override. */
  testCommand?: string;
  /** Test command overrides as argv arrays; skips manifest detection. */
  testCommands?: string[][];
  /** Suite config; cwd is repo-relative. */
  tests?: {
    scoped?: ScopedTestEntry[];
    full?: FullTestEntry[];
  };
  /** Named commands: name -> non-empty argv array. */
  commands?: Record<string, string[]>;
  /** Slop gate configuration (partial, defaults via resolveSlopConfig). */
  slop?: Partial<SlopConfig>;
}

/** Finalize behavior configuration (positive integers only). */
export interface FinalizeConfig {
  /** Per-task path cap. @default 10 */
  maxPathsPerTask?: number;
  /** Per-task assertion cap. */
  maxAssertionsPerTask?: number;
  /** Cap on manual assertions. */
  maxManualAssertions?: number;
  /** Per-task size cap in bytes. */
  maxTaskBytes?: number;
}

/** Top-level workflow configuration from workflow.json. */
export interface WorkflowConfig {
  brainstorm?: BrainstormConfig;
  implement?: ImplementConfig;
  finalize?: FinalizeConfig;
}

/** Finalize keys that must be positive integers. */
export const FINALIZE_LIMIT_KEYS = [
  "maxPathsPerTask",
  "maxAssertionsPerTask",
  "maxManualAssertions",
  "maxTaskBytes",
] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isArgv(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string");
}

function checkEntry(v: unknown, path: string, scoped: boolean, errors: string[]): void {
  if (isArgv(v)) return;
  if (!isObj(v)) {
    errors.push(`${path}: expected argv string array or { argv, ${scoped ? "scope?, " : ""}cwd? } object`);
    return;
  }
  const allowed = scoped ? ["argv", "scope", "cwd"] : ["argv", "cwd"];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) errors.push(`${path}.${k}: unknown key`);
  }
  if (!isArgv(v.argv)) errors.push(`${path}.argv: expected non-empty string array`);
  if (v.cwd !== undefined && typeof v.cwd !== "string") errors.push(`${path}.cwd: expected string`);
  if (scoped && v.scope !== undefined && !["files", "packages", "full"].includes(v.scope as string)) {
    errors.push(`${path}.scope: expected "files", "packages" or "full"`);
  }
}

/**
 * Validate a workflow config's implement.tests, implement.commands and finalize limits.
 *
 * @param config - Parsed workflow.json content.
 * @returns List of error strings, each naming the JSON path; empty when valid.
 */
export function validateWorkflowConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(config)) return ["$: expected object"];
  const impl = config.implement;
  if (impl !== undefined) {
    if (!isObj(impl)) errors.push("implement: expected object");
    else {
      const tests = impl.tests;
      if (tests !== undefined) {
        if (!isObj(tests)) errors.push("implement.tests: expected object");
        else {
          for (const kind of ["scoped", "full"] as const) {
            const list = tests[kind];
            if (list === undefined) continue;
            if (!Array.isArray(list)) {
              errors.push(`implement.tests.${kind}: expected array`);
              continue;
            }
            list.forEach((e, i) => checkEntry(e, `implement.tests.${kind}[${i}]`, kind === "scoped", errors));
          }
        }
      }
      const cmds = impl.commands;
      if (cmds !== undefined) {
        if (!isObj(cmds)) errors.push("implement.commands: expected object map");
        else {
          for (const [name, argv] of Object.entries(cmds)) {
            if (!isArgv(argv)) errors.push(`implement.commands.${name}: expected non-empty argv string array`);
          }
        }
      }
    }
  }
  const fin = config.finalize;
  if (fin !== undefined) {
    if (!isObj(fin)) errors.push("finalize: expected object");
    else {
      for (const k of FINALIZE_LIMIT_KEYS) {
        const v = fin[k];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
          errors.push(`finalize.${k}: expected positive integer`);
        }
      }
    }
  }
  return errors;
}
