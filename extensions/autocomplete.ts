import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Cache of project file paths for the current session. */
let fileCache: string[] = [];

/** Directories to exclude from file scanning. */
const IGNORE_DIRS = new Set([
  "node_modules", "dist", ".git", "build", ".next", "coverage", ".cache",
]);

/** File extensions considered relevant for @-autocomplete. */
const SCAN_EXTENSIONS = new Set([
  ".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".mdx", ".txt",
  ".env", ".conf", ".config",
  ".sh", ".bash", ".zsh",
]);

/** Specific filenames always included. */
const SCAN_FILENAMES = new Set(["Dockerfile", "Makefile", ".env.example"]);

/**
 * Recursively scan a directory for relevant files.
 * Falls back to this if fast-glob is unavailable.
 */
async function scanDir(dir: string, baseDir: string, results: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    let entryStat: { isDirectory(): boolean; isFile(): boolean };
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      await scanDir(fullPath, baseDir, results);
    } else if (entryStat.isFile()) {
      const ext = entry.slice(entry.lastIndexOf("."));
      if (SCAN_EXTENSIONS.has(ext) || SCAN_FILENAMES.has(entry)) {
        results.push(relative(baseDir, fullPath));
      }
    }
  }
}

/**
 * Scan the project directory for relevant files.
 *
 * Tries fast-glob first (faster, respects .gitignore).
 * Falls back to a recursive fs.readdir scan.
 *
 * @param cwd - Project root directory.
 * @returns Array of relative file paths.
 */
export async function refreshFileCache(cwd: string): Promise<string[]> {
  try {
    // Try fast-glob if available (npm dependency)
    const { glob } = await import("fast-glob");
    const files = await glob(
      [
        "**/*.{ts,js,tsx,jsx,mjs,cjs}",
        "**/*.{json,yaml,yml,toml}",
        "**/*.{md,mdx,txt}",
        "**/*.{env*,conf,config}",
        "**/Dockerfile",
        "**/*.{sh,bash,zsh}",
      ],
      {
        cwd,
        ignore: [
          "**/node_modules/**", "**/dist/**", "**/.git/**",
          "**/build/**", "**/.next/**", "**/coverage/**", "**/.cache/**",
        ],
        dot: false,
        absolute: false,
      },
    );
    fileCache = files.sort();
    return fileCache;
  } catch {
    // Fallback: native recursive scan
    const results: string[] = [];
    await scanDir(resolve(cwd), resolve(cwd), results);
    fileCache = results.sort();
    return fileCache;
  }
}

/**
 * Set up @-file-reference autocomplete.
 *
 * Registers a custom autocomplete provider that triggers on "@"
 * and fuzzy-matches against the cached project file list.
 *
 * File cache is populated lazily on first setup.
 *
 * @param ctx - Extension context for UI provider registration.
 * @param cwd - Project root directory.
 */
export function setupAutocomplete(ctx: ExtensionContext, cwd: string): void {
  // Populate cache in background
  refreshFileCache(cwd).catch(() => {});

  ctx.ui.addAutocompleteProvider((current) => ({
    triggerCharacters: ["@"],

    async getSuggestions(lines, line, col, options) {
      const currentLine = lines[line] ?? "";
      const beforeCursor = currentLine.slice(0, col);
      const match = beforeCursor.match(/(?:^|[ \t])@([^\s@]*)$/);

      if (!match) {
        return current.getSuggestions(lines, line, col, options);
      }

      const prefix = match[1] ?? "";
      const lowerPrefix = prefix.toLowerCase();

      const matches = fileCache
        .filter((f) => f.toLowerCase().includes(lowerPrefix))
        .slice(0, 20)
        .map((f) => ({
          value: f,
          label: f,
          description: undefined as string | undefined,
        }));

      return {
        prefix: `@${prefix}`,
        items: matches,
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  }));
}
