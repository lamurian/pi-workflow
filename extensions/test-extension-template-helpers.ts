// Source text of the helper functions embedded in the generated
// `.pi/extensions/test.ts` (suiteTimeoutMs, tail, readUnitPayload,
// validScopeEntry). The text must stay byte-identical across
// refactors: any change regenerates the file in every user repo.

import { DEFAULT_SUITE_TIMEOUT_MS, OUTPUT_TAIL_CHARS } from "./test-extension-constants.ts";

/**
 * Render the generated extension's runtime helper block.
 *
 * Emits plain JS-compatible source for the per-suite timeout budget, the
 * output tail cap, the unit-payload reader (default test scope: the payload's
 * owned test files) and the scope-entry validator. The block ends with a
 * blank line so the routing block follows directly.
 *
 * @returns The helper block source text.
 */
export function generatedHelpersSource(): string {
  return `/** Per-suite wall clock budget: PI_TEST_TIMEOUT_MS, ${DEFAULT_SUITE_TIMEOUT_MS}ms default. */
function suiteTimeoutMs() {
  const raw = Number(process.env.PI_TEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ${DEFAULT_SUITE_TIMEOUT_MS};
}

/** Cap a suite's combined output to its last ${OUTPUT_TAIL_CHARS} characters. */
function tail(text) {
  return text.length > ${OUTPUT_TAIL_CHARS} ? "\\u2026" + text.slice(-${OUTPUT_TAIL_CHARS}) : text;
}

/**
 * Read the orchestrator-written unit payload (PI_UNIT_FILE, with the legacy
 * PI_CONTRACT_GUARD_FILE fallback): repoRoot drives the per-suite cwd and
 * unit.testFiles is the default routing scope.
 *
 * @returns The parsed payload ({ repoRoot, unit }), or null when absent/invalid.
 */
async function readUnitPayload() {
  try {
    const file = process.env.PI_UNIT_FILE || process.env.PI_CONTRACT_GUARD_FILE;
    if (!file) return null;
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.unit || typeof parsed.unit !== "object") return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

/** True when a scope entry is a safe repo-relative path (T7). */
function validScopeEntry(entry) {
  return (
    typeof entry === "string" &&
    /^[a-zA-Z0-9._/-]+$/.test(entry) &&
    !entry.startsWith("-") &&
    entry.indexOf("..") === -1
  );
}

`;
}
