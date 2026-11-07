// Post-landing refresh of the generated test extension (F6). The generator is
// loaded FRESH in a child node process from the committed template, so edits
// landed during this run take effect even though the in-process module is stale.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "./state.ts";
import type { TestSuite } from "./test-tool-detect.ts";
import { GENERATED_MARKER, TEST_EXTENSION_RELATIVE } from "./test-extension-constants.ts";
import { commitTestExtensionChore, type ChoreCommitResult } from "./test-extension-chore.ts";

/** Generator producing the extension source; returns null when it fails. */
export type FreshGenerator = (suites: TestSuite[]) => Promise<string | null>;

/** Outcome of a refresh: unchanged, or the chore commit result. */
export interface RefreshResult {
  kind: "unchanged" | ChoreCommitResult["kind"];
  investigation: string;
}

/**
 * Build the default generator: a child node process imports the template.
 *
 * @param pi           - ExtensionAPI (exec access).
 * @param cwd          - Working directory for the child process.
 * @param templatePath - Absolute template path (defaults to the sibling file).
 * @returns A generator returning the fresh output, or null on failure.
 */
export function createChildProcessGenerator(
  pi: ExtensionAPI,
  cwd: string,
  templatePath: string = join(dirname(fileURLToPath(import.meta.url)), "test-extension-template.ts"),
): FreshGenerator {
  return async (suites) => {
    const url = pathToFileURL(templatePath).href;
    const script =
      `const m = await import(${JSON.stringify(url)});` +
      `process.stdout.write(m.generateTestExtension(${JSON.stringify(suites)}));`;
    const res = await pi.exec(
      "node",
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      { cwd },
    );
    return res.code === 0 && res.stdout ? res.stdout : null;
  };
}

/**
 * After a landed behavior, regenerate the test extension from a freshly
 * loaded generator; rewrite and commit it only when the output differs.
 *
 * @param pi       - ExtensionAPI reference.
 * @param cwd      - Repository working directory.
 * @param state    - Workflow state (recorded suites).
 * @param generate - Injectable generator (defaults to the child-process one).
 * @returns "unchanged" when nothing was written, else the chore outcome.
 */
export async function refreshTestExtensionAfterLanding(
  pi: ExtensionAPI,
  cwd: string,
  state: Pick<WorkflowState, "testTool">,
  generate: FreshGenerator = createChildProcessGenerator(pi, cwd),
): Promise<RefreshResult> {
  const unchanged: RefreshResult = { kind: "unchanged", investigation: "" };
  const suites = state.testTool?.suites ?? [];
  if (suites.length === 0) return unchanged;
  const target = join(resolve(cwd), TEST_EXTENSION_RELATIVE);
  let current: string | null = null;
  if (existsSync(target)) {
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = null;
    }
    if (current !== null && !current.includes(GENERATED_MARKER)) return unchanged;
  }
  const fresh = await generate(suites);
  if (fresh === null || fresh === current) return unchanged;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fresh);
  const chore = await commitTestExtensionChore(pi, cwd, TEST_EXTENSION_RELATIVE);
  return { kind: chore.kind, investigation: chore.investigation };
}
