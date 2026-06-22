import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

/** Brainstorming behavior configuration. */
export interface BrainstormConfig {
  /**
   * Skip the questionnaire about pre-commit, pre-push, and env management.
   * When true, the brainstorming prompt omits the questionnaire section and
   * auto-detection of existing hooks is skipped.
   * @default false
   */
  skipQuestionnaire?: boolean;
  /**
   * Topics to skip during the questionnaire.
   * Only meaningful when `skipQuestionnaire` is false.
   * Supported values: "pre-commit", "pre-push", "env-management".
   * @default []
   */
  skipTopics?: string[];
  /**
   * Skip the full ADR → Spec → Plan ceremony for small changes.
   * When true, brainstorming goes straight to implementation.
   * @default false
   */
  skipCeremony?: boolean;
}

/** Implementation (TDD) behavior configuration. */
export interface ImplementConfig {
  /**
   * Enforce test-driven development: require a failing test before implementation.
   * @default true
   */
  enforceTdd?: boolean;
  /**
   * Custom test command override. If set, overrides auto-detection.
   * @example "npm run test:ci"
   */
  testCommand?: string;
}

/** Top-level workflow configuration from workflow.json. */
export interface WorkflowConfig {
  brainstorm?: BrainstormConfig;
  implement?: ImplementConfig;
}

const DEFAULT_WORKFLOW: WorkflowConfig = {
  brainstorm: {
    skipQuestionnaire: false,
    skipTopics: [],
    skipCeremony: false,
  },
  implement: {
    enforceTdd: true,
  },
};

// ── JSON config loading (same pattern as sandbox.json) ────────────────────────

/**
 * Merge semantics: defaults ← global JSON ← project-local JSON.
 * Each level deep-merges its values, so a project can override a
 * single field (e.g. `adr.path`) without repeating the rest.
 */
function deepMerge<T extends Record<string, unknown>>(
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
