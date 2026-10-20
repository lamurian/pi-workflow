import { isTestPath, LANG_PROFILES } from "./test-scan-profiles.ts";

// ─── Staged-diff tamper guard (T4) ──────────────────────────────────────────

/** Everything the staged-diff classifier needs for one commit attempt. */
export interface StagedDiffInput {
  /** Raw `git diff --cached --name-status` output. */
  nameStatus: string;
  /** The contract's declared files (the allowlist). */
  declaredFiles: readonly string[];
  /** sourceFile of every test-kind behavior (protected even when declared). */
  testKindSourceFiles: readonly string[];
  /** 1 = first attempt; >= 2 = fix retry (stricter: any undeclared M/D). */
  attempt: number;
  /** Raw `git diff --cached` output for skip markers + assertion deltas. */
  unifiedDiff?: string;
}

/** Result of the staged-diff tamper classification. */
export interface StagedDiffResult {
  kind: "clean" | "test-guard";
  /** Offending paths / rule breaches; empty when clean. */
  violations: string[];
  /** Name-status test lines + assertion-delta context (never gating). */
  investigation: string;
}

/** Assertion-like line detector for investigation context only. */
const ASSERTION_LINE = /\b(expect|assert|it|test|should|TestCase|@Test)\b/;

/** Skip/only markers: union across all profiles — the guard protects broadly. */
const SKIP_MARKERS: RegExp[] = LANG_PROFILES.flatMap((p) =>
  p.skipPatterns.map((re) => new RegExp(re.source, re.flags.replace(/g/g, ""))),
);

/** One parsed `git diff --cached --name-status` entry. */
interface NameStatusEntry {
  status: string;
  path: string;
}

/** Parse name-status lines; renames/copies split into D(old) + A(new). */
function parseNameStatus(nameStatus: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split("\t");
    const status = fields[0]?.[0] ?? "";
    if ((status === "R" || status === "C") && fields[1] && fields[2]) {
      entries.push({ status: "D", path: fields[1] });
      entries.push({ status: "A", path: fields[2] });
    } else if (fields[1]) {
      entries.push({ status, path: fields[1] });
    }
  }
  return entries;
}

/** Split a unified diff into per-file sections keyed by b-path (fallback a-path). */
function diffSections(unifiedDiff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const chunks = unifiedDiff.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git ")) continue;
    const header = chunk.split("\n", 1)[0] ?? "";
    const match = header.match(/diff --git a\/(.+) b\/(.+)/);
    const key = match ? (match[2] ?? match[1]!) : header;
    sections.set(key, chunk);
  }
  return sections;
}

/** True when the file's added diff lines introduce skip/only markers. */
function addsSkipMarkers(section: string | undefined): boolean {
  if (!section) return false;
  const added = section
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  return added.some((line) => SKIP_MARKERS.some((re) => re.test(line)));
}

/**
 * Deterministically classify one staged diff against the tamper-guard rules.
 *
 * Attempt 1: A on any test path never violates; M on a declared test path is
 * allowed; M on an undeclared test path is non-blocking unless skip/only
 * markers were added; D on an undeclared test path violates; D on a
 * test-kind behavior's sourceFile violates even when declared. Fix retries
 * (attempt >= 2) are stricter: any M/D on an undeclared test path violates.
 * Assertion deltas from the unified diff are investigation context only.
 *
 * @param input - Parsed staged diff + contract declarations + attempt number.
 * @returns Clean or test-guard with violations and investigation text.
 */
export function classifyStagedDiff(input: StagedDiffInput): StagedDiffResult {
  const entries = parseNameStatus(input.nameStatus);
  const sections = diffSections(input.unifiedDiff ?? "");
  const violations: string[] = [];
  const testLines: string[] = [];

  for (const line of input.nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const path = trimmed.split("\t")[1];
    if (path && isTestPath(path)) testLines.push(trimmed);
  }

  for (const { status, path } of entries) {
    if (!isTestPath(path)) continue;
    const declared = input.declaredFiles.includes(path);
    const isSource = input.testKindSourceFiles.includes(path);

    if (status === "A") continue; // new tests are the norm

    if (status === "D") {
      if (isSource) {
        violations.push(
          `test-kind sourceFile deletion: ${path} — the file that surfaces this behavior's verification was deleted`,
        );
      } else if (!declared) {
        violations.push(
          `undeclared test deletion: ${path} — tests are the specification; declare it in files if the contract removes it`,
        );
      }
      continue;
    }

    // Modification (M or anything else treated as a change).
    if (declared) continue;
    if (input.attempt >= 2) {
      violations.push(
        `fix retry touched undeclared test path: ${path} — only implementation code may change on retries`,
      );
      continue;
    }
    if (addsSkipMarkers(sections.get(path))) {
      violations.push(
        `skip/only markers added to undeclared test path: ${path} — skipping a test is not a fix`,
      );
    }
  }

  // Assertion-delta context: per-file +/- assertion-like line counts.
  const deltaLines: string[] = [];
  for (const [path, section] of sections) {
    if (!isTestPath(path)) continue;
    let added = 0;
    let removed = 0;
    for (const line of section.split("\n")) {
      if (!ASSERTION_LINE.test(line)) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    if (added > 0 || removed > 0) {
      deltaLines.push(`  ${path}: +${added} -${removed} assertion-like lines`);
    }
  }

  const parts = [
    `## Staged-diff guard: ${violations.length > 0 ? "violations detected" : "clean"}`,
    "",
    "Name-status (test paths):",
    testLines.length > 0 ? testLines.map((l) => `  ${l}`).join("\n") : "  (none)",
    "",
    "Assertion deltas (context only, never a violation):",
    deltaLines.length > 0 ? deltaLines.join("\n") : "  (none)",
  ];
  if (violations.length > 0) {
    parts.push("", "Violations:", ...violations.map((v) => `  - ${v}`));
  }

  return { kind: violations.length > 0 ? "test-guard" : "clean", violations, investigation: parts.join("\n") };
}
