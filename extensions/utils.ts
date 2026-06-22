import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Cached absolute path of the package root directory. */
let _packageRoot: string | undefined;

/**
 * Get the absolute path to the package root (parent of src/, content/, skills/).
 * Resolved once from the current module location.
 */
export function getPackageRoot(): string {
  if (!_packageRoot) {
    _packageRoot = resolve(
      fileURLToPath(new URL("..", import.meta.url)),
    );
  }
  return _packageRoot;
}

/**
 * Load a content file from the content/ directory.
 *
 * @param filename - Relative path within content/ (e.g. "adr-template.md").
 * @returns The file contents as a string.
 */
export async function loadContent(filename: string): Promise<string> {
  const filePath = resolve(getPackageRoot(), "content", filename);
  return readFile(filePath, "utf-8");
}

/**
 * Render a template by replacing {{placeholder}} variables.
 *
 * @param template - Template string with {{key}} placeholders.
 * @param vars    - Key-value pairs to substitute.
 * @returns The rendered string.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Extract @file references from a command argument string.
 *
 * Returns the matched file paths (with @ prefix stripped).
 * The remainder of the string (non-@ tokens) is the free-form topic.
 *
 * @param text - Raw argument text.
 * @returns Array of referenced file paths.
 */
export function extractFileRefs(text: string): string[] {
  const refs: string[] = [];
  const regex = /@(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/**
 * Strip @file references from text, returning only the free-form tokens.
 *
 * @param text - Raw argument text.
 * @returns Text with @references removed.
 */
export function stripFileRefs(text: string): string {
  return text.replace(/@\S+/g, "").trim();
}

/**
 * Parse command arguments, resolving @file references to their contents.
 *
 * Supports:
 *   ""                              → topic: "", files: []
 *   "some topic"                    → topic: "some topic", files: []
 *   "@path/to/file.md"              → topic: "", files: [content]
 *   "@a.md @b.md topic text"        → topic: "topic text", files: [a, b]
 *
 * @param args - Raw text after the command name.
 * @param cwd  - Working directory for resolving relative paths.
 * @returns Parsed topic and resolved file contents.
 */
export async function parseArgs(
  args: string,
  cwd: string,
): Promise<{ topic: string; fileContents: string[] }> {
  const trimmed = args.trim();
  if (!trimmed) {
    return { topic: "", fileContents: [] };
  }

  const refs = extractFileRefs(trimmed);
  const topic = stripFileRefs(trimmed);

  const fileContents: string[] = [];
  for (const ref of refs) {
    try {
      const absPath = isAbsolute(ref) ? ref : resolve(cwd, ref);
      const content = await readFile(absPath, "utf-8");
      fileContents.push(content);
    } catch {
      // File not found — skip silently; the LLM can handle missing refs
      fileContents.push(`[File not found: ${ref}]`);
    }
  }

  return { topic, fileContents };
}

/**
 * Resolve a skills directory path within the package.
 *
 * @returns Absolute path to the skills/ directory.
 */
export function getSkillsDir(): string {
  return resolve(getPackageRoot(), "skills");
}

/**
 * Format a date string as YYYY-MM-DD.
 *
 * @param date - Date object (defaults to now).
 * @returns Formatted date string.
 */
export function formatDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Generate a short slug from a title.
 *
 * Used for uniform file naming: xxx-short-slug.md
 * Throws when the slug exceeds maxLen so the caller (LLM) re-prompts
 * with a shorter title instead of silently truncating.
 *
 * @param title  - The title to slugify.
 * @param maxLen - Maximum length of the slug (default 60).
 * @returns Slug suitable for filenames.
 * @throws {Error} If the slug exceeds maxLen characters.
 */
export function shortSlug(title: string, maxLen = 60): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  if (slug.length > maxLen) {
    throw new Error(
      `Title too long: slug "${slug}" exceeds ${maxLen} characters. ` +
      "Use a shorter title (fewer words).",
    );
  }

  return slug;
}

/**
 * Determine if a file path references an ADR, spec, or plan document
 * by checking its directory path.
 *
 * @param filePath - Absolute file path.
 * @returns "adr" | "spec" | "plan" | null if unrecognized.
 */
export function detectDocType(
  filePath: string,
): "adr" | "spec" | "plan" | null {
  const normal = filePath.replace(/\\/g, "/").toLowerCase();
  if (/\/docs\/adr\//.test(normal)) return "adr";
  if (/\/docs\/specs\//.test(normal)) return "spec";
  if (/\/docs\/plans\//.test(normal)) return "plan";
  return null;
}
