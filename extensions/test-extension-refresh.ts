// F6: keep the generated test extension fresh after each landed behavior.
// The generator is loaded in a CHILD node process importing the committed
// template, so edits landed during this run are picked up (the in-process
// module is stale).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "./state.ts";
import type { TestSuite } from "./test-tool-detect.ts";
import { GENERATED_MARKER, TEST_EXTENSION_RELATIVE } from "./test-extension-constants.ts";
import { commitTestExtensionChore, type ChoreCommitResult } from "./test-extension-chore.ts";

/** Generator returning fresh test-extension source, or null on failure. */
export type FreshGenerator = (pi: ExtensionAPI, cwd: string, suites: TestSuite[]) => Promise<string | null>;

/** Outcome of the post-landing refresh. */
export interface RefreshResult {
  kind: ChoreCommitResult["kind"] | "unchanged";
  investigation: string;
}

/**
 * Generate test-extension source in a child node process from the template file.
 *
 * @param pi     - ExtensionAPI (exec).
 * @param cwd    - Working directory.
 * @param suites - Recorded suites.
 * @returns The generated source, or null when the child failed.
 */
export async function generateInChildProcess(
  pi: ExtensionAPI,
  cwd: string,
  suites: TestSuite[],
): Promise<string | null> {
  const templatePath = fileURLToPath(new URL("./test-extension-template.ts", import.meta.url));
  const script =
    `const m = await import(${JSON.stringify("file://" + templatePath + "?t=" + Date.now())});` +
    `process.stdout.write(m.generateTestExtension(${JSON.stringify(suites)}));`;
  const res = await pi.exec(
    "node",
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
    { cwd },
  );
  if (res.code !== 0 || !res.stdout) return null;
  return res.stdout;
}

/**
 * After a landed behavior, regenerate `.pi/extensions/test.ts` from a freshly
 * loaded generator; when it differs, write it and land the chore commit.
 *
 * @param pi       - ExtensionAPI.
 * @param cwd      - Repository working directory.
 * @param state    - Workflow state (recorded suites).
 * @param generate - Fresh generator (defaults to the child-process one).
 * @returns The refresh outcome; "unchanged" when nothing was written.
 */
export async function refreshTestExtensionAfterLanding(
  pi: ExtensionAPI,
  cwd: string,
  state: Pick<WorkflowState, "testTool">,
  generate: FreshGenerator = generateInChildProcess,
): Promise<RefreshResult> {
  const suites = state.testTool?.suites ?? [];
  if (suites.length === 0) return { kind: "unchanged", investigation: "" };
  const target = join(resolve(cwd), TEST_EXTENSION_RELATIVE);
  let current: string | null = null;
  if (existsSync(target)) {
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = null;
    }
    if (current !== null && !current.includes(GENERATED_MARKER)) {
      return { kind: "unchanged", investigation: "" };
    }
  }
  const fresh = await generate(pi, cwd, suites);
  if (fresh === null || fresh === current) return { kind: "unchanged", investigation: "" };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fresh);
  return commitTestExtensionChore(pi, cwd, TEST_EXTENSION_RELATIVE);
}
