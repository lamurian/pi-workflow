// Source text of the helper functions embedded in the generated
// `.pi/extensions/test.ts` (suiteTimeoutMs, tail, readUnitPayload,
// validScopeEntry, suiteArgv). The text must stay byte-identical across
// refactors: any change regenerates the file in every user repo.

import { DEFAULT_SUITE_TIMEOUT_MS, OUTPUT_TAIL_CHARS } from "./test-extension-constants.ts";

/**
 * Render the generated extension's runtime helper block.
 *
 * Emits plain JS-compatible source for the per-suite timeout budget, the
 * output tail cap, the unit-payload reader (default package scope), the
 * scope-entry validator and the per-suite filtered argv builder. The block
 * ends with a blank line so the tool registration follows directly.
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
 * PI_CONTRACT_GUARD_FILE fallback) for the default package scope.
 *
 * @returns The payload's unit slice, or null when absent or invalid.
 */
async function readUnitPayload() {
  try {
    const file = process.env.PI_UNIT_FILE || process.env.PI_CONTRACT_GUARD_FILE;
    if (!file) return null;
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const unit = parsed && parsed.unit;
    if (!unit || !Array.isArray(unit.packages)) return null;
    return unit;
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

/** The argv one suite runs with under the resolved filter (T7). */
function suiteArgv(suite, packages, run) {
  if (!suite.filterable) return suite.argv;
  const extra = suite.argv.slice(2).filter((arg) => arg !== "./...");
  const patterns =
    packages && packages.length > 0
      ? packages.map((p) => (p === "." ? "./..." : "./" + p + "/..."))
      : ["./..."];
  return ["go", "test"]
    .concat(run ? ["-run", run] : [])
    .concat(patterns)
    .concat(extra);
}

`;
}
