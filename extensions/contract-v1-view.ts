// ─── Contract v1 view (T10) ──────────────────────────────────────────────────
// The TaskContract view older consumers read from a saved v2 contract: the
// derivation, the v1 behavior warnings save_task surfaces over that view, and
// the v1 done-status preservation for legacy drafts.

import type { Behavior, ContractV2, FileEntry, TaskContract } from "./state.ts";

/** Test-artifact phrasing: expectedOutput talks about test files/cases only. */
const TEST_ARTIFACT_PATTERN = /test (file|files|cases?|scenarios?)\b/i;

/** Observable-behavior markers that make a test-kind expectedOutput valid. */
const OBSERVABLE_MARKER_PATTERN = /\b(returns?|raises?|emits?|rejects?|persists?|validates?)\b/i;

/**
 * Deterministically collect contract-quality warnings for one behavior.
 *
 * Two advisory rules, both test-kind only:
 * 1. Test-artifact-only expectedOutput (mentions test files/cases/scenarios
 *    with no observable-behavior marker) — such a commit is red by
 *    construction: a test without its implementation.
 * 2. Test-deletion expectedOutput — deletion is not test-verified behavior;
 *    the behavior should be kind: "manual".
 *
 * @param b - Behavior to inspect (already shape-validated).
 * @returns Zero or two warning strings (never both rules for one behavior:
 *          deletion is checked first and wins).
 */
export function collectBehaviorWarnings(b: Behavior): string[] {
  if (b.kind !== "test") return [];
  if (/\b(deletes?|removes?)\b/i.test(b.expectedOutput) && /\btests?\b/i.test(b.expectedOutput)) {
    return [
      `${b.id}: expectedOutput describes test deletion — test deletion is not ` +
        `test-verified behavior; set kind: manual for removal behaviors.`,
    ];
  }
  if (
    TEST_ARTIFACT_PATTERN.test(b.expectedOutput) &&
    !OBSERVABLE_MARKER_PATTERN.test(b.expectedOutput)
  ) {
    return [
      `${b.id}: expectedOutput describes test artifacts only — the commit ` +
        `would be red by construction (test without implementation). ` +
        `Merge the test and its implementation into one behavior.`,
    ];
  }
  return [];
}

/**
 * Carry over "done" status from a prior contract into a revised draft.
 *
 * A draft behavior gets status "done" when the prior contract has a
 * behavior with the same id whose status is "done" and whose description
 * and expectedOutput are byte-identical to the draft's. Any text change
 * leaves the draft's own status untouched (the behavior must be redone).
 * Pure: neither input is mutated.
 *
 * @param prior - The previously saved contract, if any.
 * @param draft - The freshly validated draft contract.
 * @returns The draft with preserved statuses, plus the ids (in draft order)
 *          whose done status was carried over.
 */
export function preserveDoneStatuses(
  prior: TaskContract | undefined,
  draft: TaskContract,
): { task: TaskContract; preserved: string[] } {
  if (!prior) return { task: draft, preserved: [] };
  const priorDone = new Map(
    prior.behaviors
      .filter((b) => b.status === "done")
      .map((b) => [b.id, b]),
  );
  const preserved: string[] = [];
  const behaviors = draft.behaviors.map((b) => {
    const p = priorDone.get(b.id);
    if (
      p &&
      p.description === b.description &&
      p.expectedOutput === b.expectedOutput
    ) {
      preserved.push(b.id);
      return { ...b, status: "done" as const };
    }
    return b;
  });
  return { task: { ...draft, behaviors }, preserved };
}

/**
 * Derive the v1 TaskContract view older consumers read from a saved v2
 * contract (T10).
 *
 * Files: every sources/tests path in declaration order — a declared D is
 * kept, any other path renders M when tracked at HEAD and A when untracked
 * (status is a display qualifier; ownership lives in the v2 contract).
 * Behaviors: one per task, `kind` "test" when the task owns at least one
 * tests path (manual otherwise), expectedOutput joined with "; ",
 * sourceFile = the task's first owned source path, status carried over.
 *
 * @param contract     - The validated (and status-preserved) v2 contract.
 * @param trackedPaths - Repo-relative paths tracked at HEAD (git ls-tree).
 * @returns The v1 TaskContract view.
 */
export function deriveTaskContract(
  contract: ContractV2,
  trackedPaths: ReadonlySet<string>,
): TaskContract {
  const files: FileEntry[] = [...contract.sources, ...contract.tests].map((e) => ({
    path: e.path,
    status: e.status === "D" ? "D" : trackedPaths.has(e.path) ? "M" : "A",
  }));
  const behaviors: Behavior[] = contract.tasks.map((t) => {
    const ownsTest = contract.tests.some((p) => p.tasks.includes(t.id));
    const firstSource = contract.sources.find((p) => p.tasks.includes(t.id));
    return {
      id: t.id,
      description: t.description,
      expectedOutput: t.expectedOutput.join("; "),
      kind: ownsTest ? "test" : "manual",
      status: t.status,
      ...(firstSource ? { sourceFile: firstSource.path } : {}),
    };
  });
  return {
    title: contract.title,
    instruction: contract.instruction,
    files,
    done: contract.done,
    behaviors,
  };
}
