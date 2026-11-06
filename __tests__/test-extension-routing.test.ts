import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateTestExtension } from "../extensions/test-extension-template.ts";
import { routeSuites } from "../extensions/suite-scope.ts";
import type { TestSuite } from "../extensions/test-tool-detect.ts";
import { writeContractGuardFile } from "../extensions/contract-guard-file.ts";
import { deriveAllowlist } from "../extensions/contract-derive.ts";
import type { ContractV2 } from "../extensions/state.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Routing shapes: packages (root + nested cwd), files (cwd + root), full. */
const SUITES: TestSuite[] = [
  { label: "go (go test ./...)", argv: ["go", "test", "./..."] },
  { label: "go internal", argv: ["go", "test", "./..."], cwd: "internal" },
  {
    label: "python (pytest)",
    argv: ["python", "-m", "pytest", "{tests}"],
    scope: "files",
    cwd: "py",
  },
  { label: "js (vitest run)", argv: ["npx", "vitest", "run", "{tests}"], scope: "files" },
  { label: "make (make test)", argv: ["make", "test"] },
];

/** Candidates: D path, non-test go file, no-language path all must be dropped. */
const PATHS = [
  { path: "pkg/foo_test.go" },
  { path: "pkg/helper.go" },
  { path: "internal/deep/deep_test.go" },
  { path: "py/test_alpha.py" },
  { path: "src/app.test.ts" },
  { path: "gone/gone_test.go", status: "D" },
  { path: "README.md" },
];

/**
 * Load the generated source as an ESM module with a seam exporting SUITES and
 * routeSuites, so the embedded routing can be compared against suite-scope.ts.
 *
 * @param src - Generated extension source plus the export seam.
 * @returns The module's SUITES and routeSuites bindings.
 */
async function loadGenerated(src: string): Promise<{
  SUITES: TestSuite[];
  routeSuites: typeof routeSuites;
}> {
  const dir = mkdtempSync(join(tmpdir(), "pi-routing-"));
  tmpDirs.push(dir);
  const file = join(dir, "gen.mjs");
  writeFileSync(file, src);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    SUITES: TestSuite[];
    routeSuites: typeof routeSuites;
  };
}

describe("generated routing parity with suite-scope.ts", () => {
  it("produces the same per-suite argv and skip decisions as routeSuites", async () => {
    const mod = await loadGenerated(
      `${generateTestExtension(SUITES)}\nexport { SUITES, routeSuites };\n`,
    );

    const generated = mod.routeSuites(mod.SUITES, PATHS);
    const reference = routeSuites(SUITES, PATHS);

    assert.deepEqual(
      generated,
      reference,
      "the embedded routing must match suite-scope.ts for the same suites and paths",
    );
    assert.deepEqual(
      generated.map((r) => r.skipped),
      [false, false, false, false, false],
      "every suite receives at least one routed path (full always runs)",
    );
    assert.deepEqual(generated[0]!.argv, ["go", "test", "./pkg/..."]);
    assert.deepEqual(generated[1]!.argv, ["go", "test", "./deep/..."], "deepest-ancestor cwd wins");
    assert.deepEqual(generated[2]!.argv, ["python", "-m", "pytest", "test_alpha.py"]);
    assert.deepEqual(generated[3]!.argv, ["npx", "vitest", "run", "src/app.test.ts"]);
    assert.deepEqual(generated[4]!.argv, ["make", "test"], "full suite keeps plain argv");
  });

  it("skips suites with no routed paths and drops D / non-test / no-language paths", async () => {
    const mod = await loadGenerated(
      `${generateTestExtension(SUITES)}\nexport { SUITES, routeSuites };\n`,
    );

    const generated = mod.routeSuites(mod.SUITES, [
      { path: "gone/gone_test.go", status: "D" },
      { path: "README.md" },
    ]);

    assert.deepEqual(
      generated.map((r) => r.skipped),
      [true, true, true, true, false],
      "only the full suite runs; the D path and README route nothing",
    );
    for (const run of generated.slice(0, 4)) assert.deepEqual(run.argv, []);
    assert.deepEqual(generated[4]!.argv, ["make", "test"]);
  });
});

describe("unit payload testFiles (T4)", () => {
  it("payloadCarriesTestFilesExcludingD: the payload lists the owned non-D test paths", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-payload-"));
    tmpDirs.push(tmp);
    const contract: ContractV2 = {
      title: "Routing payload",
      instruction: "shared context only",
      done: "suite green",
      sources: [{ path: "extensions/suite-scope.ts", tasks: ["T1"] }],
      tests: [
        { path: "__tests__/a.test.ts", tasks: ["T1"] },
        { path: "__tests__/b.test.ts", tasks: ["T1", "T2"] },
        { path: "__tests__/gone.test.ts", status: "D", tasks: ["T1"] },
      ],
      tasks: [
        { id: "T1", description: "routing", expectedOutput: ["ok"], status: "active" },
      ],
    };
    const pi = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    } as unknown as ExtensionAPI;

    const guardPath = await writeContractGuardFile(pi, tmp, deriveAllowlist(contract), "base123", {
      contract,
      taskId: "T1",
    });

    const payload = JSON.parse(readFileSync(guardPath, "utf8")) as {
      repoRoot: string;
      unit: { id: string; testFiles: string[]; packages: string[] };
    };
    assert.equal(payload.repoRoot, tmp);
    assert.equal(payload.unit.id, "T1");
    assert.deepEqual(
      payload.unit.testFiles,
      ["__tests__/a.test.ts", "__tests__/b.test.ts"],
      "unit.testFiles lists the task's owned non-D test paths in contract order",
    );
    assert.deepEqual(payload.unit.packages, ["__tests__"], "packages stay alongside testFiles");
  });
});
