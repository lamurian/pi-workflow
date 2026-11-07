import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WorkflowConfig } from "./workflow-config-schema.ts";

export type {
  BrainstormConfig,
  ImplementConfig,
  FinalizeConfig,
  WorkflowConfig,
} from "./workflow-config-schema.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single directory/file entry with metadata. */
export interface DirectoryEntry {
  /** Relative path from project root (e.g. "docs/ADR"). */
  path: string;
  /** Human-readable description of what lives here. */
  description: string;
  /** Additional locations to search if the primary path doesn't exist. */
  fallbacks?: string[];
}

/** All configurable directory/file locations used by the extension. */
export interface DirectoriesConfig {
  adr: DirectoryEntry & { fallbacks: string[] };
  specs: DirectoryEntry;
  plans: DirectoryEntry;
  architecture: DirectoryEntry & { fallbacks: string[] };
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_DIRECTORIES: DirectoriesConfig = {
  adr: {
    path: "docs/ADR",
    description: "Primary directory for Architecture Decision Records",
    fallbacks: ["docs/adr", "ADR"],
  },
  specs: {
    path: "docs/specs",
    description: "Directory for specification files",
  },
  plans: {
    path: "docs/plans",
    description: "Directory for plan files",
  },
  architecture: {
    path: "ARCHITECTURE.md",
    description:
      "Architecture document tracking ADR lifecycle status",
    fallbacks: ["docs/agents/ARCHITECTURE.md"],
  },
};

/**
 * Name of the archive subdirectory inside specs/plans directories.
 *
 * This is a fixed internal convention, not user-configurable.
 */
export const ARCHIVE_SUBDIR = ".archive";

// ── Workflow Configuration ────────────────────────────────────────────────────

/** Default per-task path cap at finalize when workflow.json sets none. */
export const DEFAULT_MAX_PATHS_PER_TASK = 10;

const DEFAULT_WORKFLOW: WorkflowConfig = {
  brainstorm: {
    skipQuestionnaire: false,
    skipTopics: [],
    skipCeremony: false,
  },
  implement: {
    enforceTdd: true,
  },
  finalize: {
    maxPathsPerTask: DEFAULT_MAX_PATHS_PER_TASK,
  },
};

/**
 * Resolve the per-task path cap from a workflow config.
 *
 * @param config - The merged workflow configuration.
 * @returns `config.finalize.maxPathsPerTask` when it is a positive integer;
 *          otherwise DEFAULT_MAX_PATHS_PER_TASK (10) — non-positive and
 *          non-integer values fall back to the default.
 */
export function resolveMaxPathsPerTask(config: WorkflowConfig): number {
  const max = config.finalize?.maxPathsPerTask;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    return DEFAULT_MAX_PATHS_PER_TASK;
  }
  return max;
}

// ── JSON config loading ────────────────────────────────────────────────────

/**
 * Merge semantics: defaults ← global JSON ← project-local JSON.
 * Each level deep-merges its values, so a project can override a
 * single field (e.g. `adr.path`) without repeating the rest.
 */
function deepMerge<T extends object>(
  ...sources: Partial<T>[]
): T {
  const result = {} as T;
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(source) as (keyof T)[]) {
      const val = source[key];
      const existing = result[key];
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        result[key] = deepMerge(
          existing as Record<string, unknown>,
          val as Record<string, unknown>,
        ) as T[keyof T];
      } else {
        result[key] = val as T[keyof T];
      }
    }
  }
  return result;
}

async function tryReadJson(
  path: string,
): Promise<Partial<DirectoriesConfig> | null> {
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Simple module-level cache so we don't re-read files on every call.
let _cachedConfig: DirectoriesConfig | null = null;
let _cacheKey: string | null = null;

/**
 * Load and merge directories configuration.
 *
 * Checks (in priority order, highest wins):
 * 1. Hardcoded defaults
 * 2. Global config at `~/.pi/agent/extensions/directories.json`
 * 3. Project-local config at `<cwd>/.pi/directories.json`
 *
 * Result is cached per `cwd` value.
 *
 * @param cwd - Project working directory.
 * @returns The merged configuration.
 */
export async function loadDirectoriesConfig(
  cwd: string,
): Promise<DirectoriesConfig> {
  if (_cachedConfig && _cacheKey === cwd) return _cachedConfig;

  const globalPath = join(getAgentDir(), "extensions", "directories.json");
  const projectPath = join(cwd, ".pi", "directories.json");

  const globalConfig = await tryReadJson(globalPath);
  const projectConfig = await tryReadJson(projectPath);

  _cachedConfig = deepMerge(
    DEFAULT_DIRECTORIES,
    globalConfig ?? {},
    projectConfig ?? {},
  );
  _cacheKey = cwd;

  return _cachedConfig;
}

/**
 * Clear the cached configuration (useful in tests).
 */
export function resetConfigCache(): void {
  _cachedConfig = null;
  _cacheKey = null;
}

// ── Workflow JSON loading ────────────────────────────────────────────────────

// Separate cache from the directories config cache.
let _cachedWorkflow: WorkflowConfig | null = null;
let _workflowCacheKey: string | null = null;

async function tryReadWorkflowJson(
  path: string,
): Promise<Partial<WorkflowConfig> | null> {
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Load and merge workflow configuration.
 *
 * Checks (in priority order, highest wins):
 * 1. Hardcoded defaults
 * 2. Global config at `~/.pi/agent/workflow.json`
 * 3. Project-local config at `<cwd>/.pi/workflow.json`
 *
 * Result is cached per `cwd` value.
 *
 * @param cwd - Project working directory.
 * @returns The merged workflow configuration.
 */
export async function loadWorkflowConfig(
  cwd: string,
): Promise<WorkflowConfig> {
  if (_cachedWorkflow && _workflowCacheKey === cwd) return _cachedWorkflow;

  const globalPath = join(getAgentDir(), "workflow.json");
  const projectPath = join(cwd, ".pi", "workflow.json");

  const globalConfig = await tryReadWorkflowJson(globalPath);
  const projectConfig = await tryReadWorkflowJson(projectPath);

  _cachedWorkflow = deepMerge(
    DEFAULT_WORKFLOW,
    globalConfig ?? {},
    projectConfig ?? {},
  );
  _workflowCacheKey = cwd;

  return _cachedWorkflow;
}

/**
 * Clear the cached workflow configuration (useful in tests).
 */
export function resetWorkflowConfigCache(): void {
  _cachedWorkflow = null;
  _workflowCacheKey = null;
}
