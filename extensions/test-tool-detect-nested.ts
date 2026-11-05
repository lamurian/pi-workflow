// Nested project walk over injected facts: finds go.mod modules below the root
// and JS workspace packages declared by pnpm-workspace.yaml or package.json.

import type { DetectionFacts } from "./test-tool-detect.ts";

/** Directory names the nested walk never enters. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  "vendor",
  ".pixi",
  ".venv",
  "renv",
  ".git",
  "dist",
]);

/** Maximum directory depth (root = 0) the walk visits. */
export const MAX_DEPTH = 4;

/**
 * List every non-ignored subdirectory up to MAX_DEPTH, repo-relative.
 *
 * @param facts - Injected facts; without listDir the walk yields nothing.
 * @returns Relative dir paths in sorted, deterministic order.
 */
export function walkDirs(facts: DetectionFacts): string[] {
  const out: string[] = [];
  const visit = (rel: string, depth: number): void => {
    if (depth >= MAX_DEPTH || !facts.listDir) return;
    const entries = facts.listDir(rel === "" ? "." : rel)
      .filter((e) => e.dir && !IGNORED_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
    for (const name of entries) {
      const child = rel === "" ? name : `${rel}/${name}`;
      out.push(child);
      visit(child, depth + 1);
    }
  };
  visit("", 0);
  return out;
}

/**
 * Directories (excluding root) that contain a go.mod.
 *
 * @param facts - Injected filesystem facts.
 * @param dirs  - Walked directories.
 * @returns Module directories.
 */
export function nestedGoModules(facts: DetectionFacts, dirs: string[]): string[] {
  return dirs.filter((d) => facts.hasFile(`${d}/go.mod`));
}

/** Read workspace globs from pnpm-workspace.yaml and package.json workspaces. */
function workspaceGlobs(facts: DetectionFacts): string[] {
  const globs: string[] = [];
  const yaml = facts.readFile("pnpm-workspace.yaml");
  if (yaml !== null) {
    let inside = false;
    for (const line of yaml.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) {
        inside = true;
        continue;
      }
      if (inside && /^\S/.test(line)) inside = false;
      const m = inside ? /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line) : null;
      if (m) globs.push(m[1]!);
    }
  }
  const raw = facts.readFile("package.json");
  if (raw !== null) {
    try {
      const pkg = JSON.parse(raw) as { workspaces?: unknown };
      const ws = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : (pkg.workspaces as { packages?: unknown } | undefined)?.packages;
      if (Array.isArray(ws)) {
        for (const g of ws) if (typeof g === "string") globs.push(g);
      }
    } catch {
      // Broken manifest: no workspaces.
    }
  }
  return globs.filter((g) => !g.startsWith("!"));
}

/** Convert a workspace glob to an anchored regex. */
function globRegex(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  const body = clean
    .split("/")
    .map((seg) =>
      seg === "**" ? "\u0000" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/")
    .replace(/\/\u0000/g, "(?:/[^/]+)*")
    .replace(/\u0000\//g, "(?:[^/]+/)*")
    .replace(/\u0000/g, "[^/]+(?:/[^/]+)*");
  return new RegExp(`^${body}$`);
}

/**
 * Workspace package directories matched by the declared globs.
 *
 * @param facts - Injected filesystem facts.
 * @param dirs  - Walked directories.
 * @returns Matching directories that contain a package.json.
 */
export function workspacePackages(facts: DetectionFacts, dirs: string[]): string[] {
  const res = workspaceGlobs(facts).map(globRegex);
  if (res.length === 0) return [];
  return dirs.filter((d) => res.some((re) => re.test(d)) && facts.hasFile(`${d}/package.json`));
}
