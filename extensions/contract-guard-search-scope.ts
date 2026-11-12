/**
 * Project-directory restriction for the unit's read-only search tools.
 *
 * Implementer units are offline file coders: they have no web access and
 * `grep`/`find` must stay inside the repository root so a unit cannot burn
 * its time budget scanning sibling repos or `$HOME` for syntax the contract
 * should have pinned instead.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/** Tools the project-directory restriction applies to. */
const SEARCH_TOOLS = new Set(["grep", "find"]);

/**
 * Check whether one search call stays inside the project directory.
 *
 * Only `grep` and `find` are checked; every other tool returns `undefined`
 * (unrestricted — mutating tools are handled by the allowlist core). For a
 * search tool, a missing/empty path or `.` means the tool's default (the
 * working directory) and passes; a leading `~` expands to the home
 * directory before resolution. A path resolving outside `repoRoot` is
 * blocked with a reason naming the restriction.
 *
 * @param toolName - The tool being called.
 * @param input    - The tool input; `path` is read when present.
 * @param repoRoot - Absolute repository root the search must stay within.
 * @returns A block reason when the search escapes the root, otherwise undefined.
 */
export function checkSearchScope(
  toolName: string,
  input: { path?: unknown },
  repoRoot: string,
): string | undefined {
  if (!SEARCH_TOOLS.has(toolName)) return undefined;
  const raw = input.path;
  if (typeof raw !== "string" || raw.trim() === "" || raw.trim() === ".") return undefined;
  const root = resolve(repoRoot);
  const expanded = expandHome(raw.trim());
  const target = resolve(root, expanded);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return undefined;
  return (
    `Blocked: grep/find are limited to the project directory (${root}); ` +
    `${raw} is outside it. Search inside the project or report ` +
    `blockedReason "missing-context" with the exact question.`
  );
}

/**
 * Expand a leading `~` in a path to the home directory.
 *
 * Only `~` alone and `~/...` are expanded; `~user` forms pass through
 * unresolved (they resolve against the repo root and are blocked as outside).
 *
 * @param rawPath - A trimmed tool-provided path.
 * @returns The path with a leading `~` replaced by the home directory.
 */
function expandHome(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return resolve(homedir(), rawPath.slice(2));
  }
  return rawPath;
}
