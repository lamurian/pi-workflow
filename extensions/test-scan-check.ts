// ─── Deterministic test-scan cross-check classifier ────────────────────────
// Pure module, split from test-scan.ts to stay under the 300-line rule.

import type { DeriveResult, MatchMethod } from "./test-scan-derive.ts";

// ─── Cross-check classifier ────────────────────────────────────────────────────

/** Advisory warnings produced by crossCheck. */
export type ScanWarningKind = "undeclared-referencing" | "declared-not-found" | "no-evidence";

/** Evidence + warnings for one contract. */
export interface CrossCheckResult {
  /** Per-entry evidence lines naming method + confidence, or "unverified". */
  evidence: string[];
  /** Advisory warning lines; never blocking. */
  warnings: string[];
}

/**
 * Cross-check scan findings against the contract's declared files.
 *
 * Pure: takes findings already derived per entry. Renders evidence with
 * confidence tags; zero-hit entries render "unverified", never "clean".
 *
 * @param files - The contract's declared files entries.
 * @param findings - Per-entry deriveMatches results, keyed by files entry.
 * @param onDisk - Paths known to exist (for declared-not-found detection).
 * @returns Evidence lines and advisory warnings.
 */
export function crossCheck(
  files: readonly string[],
  findings: ReadonlyMap<string, DeriveResult>,
  onDisk: ReadonlySet<string>,
): CrossCheckResult {
  const evidence: string[] = [];
  const warnings: string[] = [];
  const declared = new Set(files);
  let totalMatches = 0;

  for (const entry of files) {
    const found = findings.get(entry);
    const matches = found?.matches ?? [];
    totalMatches += matches.length;
    if (found?.note) evidence.push(`${entry}: ${found.note}`);
    if (matches.length === 0) {
      evidence.push(
        `${entry}: unverified — no derivation hit (default export, indirect reference, or no affected tests); confirm by reading the tests or declare known paths in files`,
      );
    } else {
      for (const m of matches) {
        evidence.push(`${entry} -> ${m.path} [${m.method}, ${m.confidence}]`);
      }
    }
    if (!onDisk.has(entry)) {
      warnings.push(
        `declared-not-found: ${entry} matches nothing on disk — likely a typo or a not-yet-created path; verify before /implement`,
      );
    }
  }

  // Undeclared referencing test files (referenced but not in files).
  // Aggregated per distinct test path: one warning per path naming the
  // matched method(s) and how many declared entries matched it.
  const undeclared = new Map<string, { methods: Set<MatchMethod>; entries: number }>();
  for (const [, found] of findings) {
    for (const m of found.matches) {
      if (!declared.has(m.path)) {
        let agg = undeclared.get(m.path);
        if (!agg) {
          agg = { methods: new Set(), entries: 0 };
          undeclared.set(m.path, agg);
        }
        agg.methods.add(m.method);
        agg.entries++;
      }
    }
  }
  for (const [path, agg] of undeclared) {
    const methods = [...agg.methods].join(", ");
    warnings.push(
      `undeclared-referencing: ${path} references affected code via ${methods} (matched by ${agg.entries} declared entr${agg.entries === 1 ? "y" : "ies"}) but is not in files — classify preserved/superseded/obsolete; declare it in files if the contract changes it`,
    );
  }

  if (files.length > 0 && totalMatches === 0) {
    warnings.push(
      `no-evidence: no derivation hits for any declared entry (additive contract?) — verify by reading tests or declare known paths in files`,
    );
  }

  return { evidence, warnings };
}
