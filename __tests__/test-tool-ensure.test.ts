import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureTestTool, resolveTestExtensionPath } from "../extensions/test-tool-ensure.ts";
import {
  DEFAULT_SUITE_TIMEOUT_MS,
  GENERATED_MARKER,
  TEST_EXTENSION_RELATIVE,
} from "../extensions/test-extension-constants.ts";
import { generateTestExtension } from "../extensions/test-extension-template.ts";
import {
  detectTestSuites,
  projectFacts,
  type TestSuiteDetection,
} from "../extensions/test-tool-detect.ts";
import { loadContent } from "../extensions/utils.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DETECTED: TestSuiteDetection = {
  source: "detected",
  suites: [
    { label: "javascript (npm run test)", argv: ["npm", "run", "test"] },
    { label: "go (go test ./...)", argv: ["go", "test", "./..."] },
  ],
};

const NONE: TestSuiteDetection = { source: "none", suites: [] };

const CONFIG: TestSuiteDetection = {
  source: "config",
  suites: [{ label: "config (npm run test:ci)", argv: ["npm", "run", "test:ci"] }],
};

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Fresh temp project root, removed after the test. */
function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ensure-"));
  tmpDirs.push(dir);
  return dir;
}

interface MockPiOptions {
  /** sourceInfo.path of a registered `test` tool; undefined = no test tool. */
  testToolPath?: string;
}

/** Mock ExtensionAPI with getAllTools + a recording exec (T7: no git seam — nothing is tracked or declared). */
function mockPi(opts: MockPiOptions = {}) {
  const execCalls: Array<{ cmd: string; args: string[] }> = [];
  const tools = opts.testToolPath
    ? [
        {
          name: "test",
          description: "",
          parameters: {},
          sourceInfo: { path: opts.testToolPath },
        },
      ]
    : [];
  const pi = {
    getAllTools: () => tools,
    exec: async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    execCalls,
  };
  return pi as unknown as ExtensionAPI & { execCalls: typeof execCalls };
}

/** Shape of the tool definition the generated extension registers. */
interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

interface ExecCall {
  cmd: string;
  args: string[];
  opts: { cwd: string; timeout?: number };
}

/**
 * Load generated extension source as an ESM module (it is plain JS with an
 * `export default`, so an .mjs file imports without any TS transform) and
 * capture the registered tool against a fake host pi whose exec results come
 * from the given queue.
 */
async function loadGenerated(
  src: string,
  results: Array<() => unknown>,
): Promise<{ definition: ToolDef; calls: ExecCall[] }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-gen-"));
  tmpDirs.push(dir);
  const file = join(dir, "gen.mjs");
  writeFileSync(file, src);
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    default: (pi: unknown) => void;
  };
  let definition: ToolDef | undefined;
  const calls: ExecCall[] = [];
  const host = {
    registerTool: (def: ToolDef) => {
      definition = def;
    },
    exec: async (cmd: string, args: string[], opts: ExecCall["opts"]) => {
      calls.push({ cmd, args, opts });
      const next = results.shift();
      return next ? next() : { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  mod.default(host);
  assert.ok(definition, "the generated extension must register a tool");
  return { definition, calls };
}

/** Restore PI_TEST_TIMEOUT_MS around a generated-tool run. */
async function withTimeoutEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const prev = process.env.PI_TEST_TIMEOUT_MS;
  if (value === undefined) delete process.env.PI_TEST_TIMEOUT_MS;
  else process.env.PI_TEST_TIMEOUT_MS = value;
  try {
    return await run();
  } finally {
    if (prev === undefined) delete process.env.PI_TEST_TIMEOUT_MS;
    else process.env.PI_TEST_TIMEOUT_MS = prev;
  }
}

/**
 * Set/clear the unit-payload env vars around a generated-tool run.
 *
 * The host process may carry an ambient PI_UNIT_FILE / PI_CONTRACT_GUARD_FILE
 * (the orchestrator writes one per unit spawn), so every default-scope run in
 * these tests must control both explicitly instead of inheriting real packages.
 */
async function withUnitEnv<T>(unitFile: string | undefined, run: () => Promise<T>): Promise<T> {
  const prevUnit = process.env.PI_UNIT_FILE;
  const prevLegacy = process.env.PI_CONTRACT_GUARD_FILE;
  if (unitFile === undefined) {
    delete process.env.PI_UNIT_FILE;
    delete process.env.PI_CONTRACT_GUARD_FILE;
  } else {
    process.env.PI_UNIT_FILE = unitFile;
    delete process.env.PI_CONTRACT_GUARD_FILE;
  }
  try {
    return await run();
  } finally {
    if (prevUnit === undefined) delete process.env.PI_UNIT_FILE;
    else process.env.PI_UNIT_FILE = prevUnit;
    if (prevLegacy === undefined) delete process.env.PI_CONTRACT_GUARD_FILE;
    else process.env.PI_CONTRACT_GUARD_FILE = prevLegacy;
  }
}

/** Write a unit payload carrying the given derived packages (T7). */
function writeUnitPayload(packages: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-unit-"));
  tmpDirs.push(dir);
  const file = join(dir, "unit.json");
  writeFileSync(file, JSON.stringify({ repoRoot: dir, unit: { id: "T1", packages } }));
  return file;
}

/**
 * Run a generated tool's execute with a controlled env: unit payload and
 * PI_TEST_TIMEOUT_MS never leak in from the host process (T7).
 */
async function runTool(
  definition: ToolDef,
  params: Record<string, unknown> = {},
  options: { cwd?: string; unitFile?: string; timeoutMs?: string } = {},
): Promise<Awaited<ReturnType<ToolDef["execute"]>>> {
  return withUnitEnv(options.unitFile, () =>
    withTimeoutEnv(options.timeoutMs, () =>
      definition.execute("id", params, undefined, undefined, { cwd: options.cwd ?? "/proj" }),
    ),
  );
}

// ═══ generateTestExtension — static shape ═══
describe("generateTestExtension — static shape", () => {
  it("carries the GENERATED marker and no imports (self-contained)", () => {
    const src = generateTestExtension(DETECTED.suites);
    assert.ok(src.includes(GENERATED_MARKER), "the marker comment must be present");
    assert.doesNotMatch(src, /^\s*import\s/m, "the generated file must not import anything");
    assert.match(src, /export default/, "it default-exports the extension factory");
  });

  it("registers a tool named test and embeds every suite as argv arrays", () => {
    const src = generateTestExtension(DETECTED.suites);
    assert.match(src, /name: "test"/);
    for (const suite of DETECTED.suites) {
      assert.ok(src.includes(suite.label), `label ${suite.label} must be embedded`);
      assert.ok(src.includes(JSON.stringify(suite.argv)), `argv for ${suite.label} must be embedded`);
    }
  });

  it("mentions the per-suite timeout env var, its default and the tail cap", () => {
    const src = generateTestExtension(DETECTED.suites);
    assert.match(src, /PI_TEST_TIMEOUT_MS/);
    assert.ok(src.includes(String(DEFAULT_SUITE_TIMEOUT_MS)), "the 300000 default must appear");
    assert.ok(src.includes("4000"), "the 4000-char tail cap must appear");
  });

  it("goldenOutput: the npm + go DETECTED output is byte-identical to the pre-split golden fixture", () => {
    const golden = readFileSync(
      fileURLToPath(new URL("./fixtures/test-extension.golden.txt", import.meta.url)),
      "utf8",
    );
    assert.equal(generateTestExtension(DETECTED.suites), golden);
  });

  it("testToolModulesWithinLineBudget: the split test-tool modules are each at most 250 lines", () => {
    for (const file of [
      "test-tool-ensure.ts",
      "test-extension-constants.ts",
      "test-extension-template.ts",
      "test-extension-template-helpers.ts",
      "test-gate-run.ts",
      "test-gate-report.ts",
    ]) {
      const full = fileURLToPath(new URL(`../extensions/${file}`, import.meta.url));
      assert.ok(existsSync(full), `${file} exists`);
      const lines = readFileSync(full, "utf8").split("\n").length;
      assert.ok(lines <= 250, `${file} has ${lines} lines (budget 250)`);
    }
  });
});

// ═══ generateTestExtension — runtime behavior ═══
describe("generateTestExtension — runtime behavior", () => {
  it("runs every suite sequentially via pi.exec with the default timeout", async () => {
    const src = generateTestExtension(DETECTED.suites);
    const { definition, calls } = await loadGenerated(src, [
      () => new Promise((r) => setTimeout(() => r({ stdout: "js ok", stderr: "", code: 0, killed: false }), 40)),
      () => ({ stdout: "go ok", stderr: "", code: 0, killed: false }),
    ]);
    assert.equal(definition.name, "test");

    const result = await runTool(definition);

    assert.equal(result.isError, undefined, "all-pass must not be an error");
    assert.equal(calls.length, 2, "both suites run");
    assert.deepEqual(calls[0]!.cmd, "npm");
    assert.deepEqual(calls[0]!.args, ["run", "test"]);
    assert.deepEqual(calls[1]!.cmd, "go");
    assert.deepEqual(calls[1]!.args, ["test", "./..."]);
    for (const call of calls) {
      assert.equal(call.opts.cwd, "/proj", "exec runs in the tool context cwd");
      assert.equal(call.opts.timeout, DEFAULT_SUITE_TIMEOUT_MS, "PI_TEST_TIMEOUT_MS default 300000");
    }
    const text = result.content[0]!.text;
    const jsIdx = text.indexOf("javascript (npm run test)");
    const goIdx = text.indexOf("go (go test ./...)");
    assert.ok(jsIdx >= 0 && goIdx > jsIdx, "sections stay in suite order despite completion order");
    assert.match(text, /all 2 suite\(s\) passed/);
  });

  it("honors PI_TEST_TIMEOUT_MS per suite", async () => {
    const src = generateTestExtension([DETECTED.suites[0]!]);
    const { definition, calls } = await loadGenerated(src, []);

    await runTool(definition, {}, { timeoutMs: "1500" });

    assert.equal(calls[0]!.opts.timeout, 1500, "the env override wins");
  });

  it("caps a long suite output at the 4000-char tail", async () => {
    const huge = "HEAD" + "x".repeat(4990) + "TAIL";
    const src = generateTestExtension([DETECTED.suites[0]!]);
    const { definition } = await loadGenerated(src, [
      () => ({ stdout: huge, stderr: "", code: 0, killed: false }),
    ]);

    const result = await runTool(definition);

    const text = result.content[0]!.text;
    assert.ok(!text.includes("HEAD"), "the head of the output must be cut");
    assert.ok(text.includes("TAIL"), "the tail of the output must survive");
    assert.ok(text.length < 4300, `total text was ${text.length}, must stay near the 4000 cap`);
  });

  it("errors when any suite fails", async () => {
    const src = generateTestExtension(DETECTED.suites);
    const { definition } = await loadGenerated(src, [
      () => ({ stdout: "js ok", stderr: "", code: 0, killed: false }),
      () => ({ stdout: "", stderr: "FAIL", code: 1, killed: false }),
    ]);

    const result = await runTool(definition);

    assert.equal(result.isError, true, "a failing suite must surface isError");
    assert.match(result.content[0]!.text, /1\/2 suite\(s\) failed/);
    assert.match(result.content[0]!.text, /go \(go test \.\/\.\.\.\)/, "the failing suite is named");
    assert.match(result.content[0]!.text, /FAIL/, "the failing output tail is included");
  });

  it("errors when a suite cannot be spawned at all", async () => {
    const src = generateTestExtension([DETECTED.suites[0]!]);
    const { definition } = await loadGenerated(src, [
      () => {
        throw new Error("spawn ENOENT");
      },
    ]);

    const result = await runTool(definition);

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /spawn failed: spawn ENOENT/);
  });
});

// ═══ T7 — structured scope/run filters on the generated tool ═══
describe("generated tool structured filters (T7)", () => {
  it("testToolDefaultsToPayloadScope: no args runs payload packages on filterable suites plus all non-filterable suites", async () => {
    const src = generateTestExtension(DETECTED.suites);
    const { definition, calls } = await loadGenerated(src, [
      () => ({ stdout: "js ok", stderr: "", code: 0, killed: false }),
      () => ({ stdout: "go ok", stderr: "", code: 0, killed: false }),
    ]);
    const unitFile = writeUnitPayload(["extensions", "__tests__"]);

    const result = await runTool(definition, {}, { unitFile });

    assert.equal(result.isError, undefined, "the default-scope run passes");
    assert.equal(calls.length, 2, "no suite is skipped without an explicit filter");
    assert.deepEqual(
      calls[0]!.args,
      ["run", "test"],
      "the non-filterable suite keeps its argv",
    );
    assert.deepEqual(
      calls[1]!.args,
      ["test", "./extensions/...", "./__tests__/..."],
      "the filterable (Go) suite runs the payload's derived packages",
    );
    const text = result.content[0]!.text;
    assert.match(text, /all 2 suite\(s\) passed/);
    assert.ok(!text.includes("filtered run"), "a default-scope run carries no filtered header");
    assert.ok(!text.includes("skipped"), "nothing is skipped on a no-args run");
  });

  it("testToolDefaultsToPayloadScope: a missing payload falls back to the suites' own package pattern", async () => {
    const src = generateTestExtension(DETECTED.suites);
    const { definition, calls } = await loadGenerated(src, [
      () => ({ stdout: "js ok", stderr: "", code: 0, killed: false }),
      () => ({ stdout: "go ok", stderr: "", code: 0, killed: false }),
    ]);

    const result = await runTool(definition, {}, { unitFile: undefined });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls[1]!.args, ["test", "./..."], "no payload means the full unfiltered run");
    assert.equal(calls.length, 2);
  });

  it("testToolRejectsMalformedScope: leading '-', '..' and out-of-set chars are rejected before anything runs", async () => {
    for (const bad of ["-run=Foo", "pkg/../other", "sp ace", "pkg;rm", "pkg*", ""] as const) {
      const src = generateTestExtension(DETECTED.suites);
      const { definition, calls } = await loadGenerated(src, []);

      const result = await runTool(definition, { scope: [bad] });

      assert.equal(result.isError, true, `${JSON.stringify(bad)} must be rejected`);
      const text = result.content[0]!.text;
      assert.match(text, /invalid scope entry/);
      assert.ok(text.includes(JSON.stringify(bad)), "the offending entry is named");
      assert.equal(calls.length, 0, "nothing runs when the scope is malformed");
    }
  });

  it("testToolRejectsMalformedScope: a structured run-only filter stays -run and never free-form argv", async () => {
    const src = generateTestExtension(DETECTED.suites);
    const { definition, calls } = await loadGenerated(src, [
      () => ({ stdout: "go ok", stderr: "", code: 0, killed: false }),
    ]);

    const result = await runTool(definition, { run: "TestScope" });

    assert.equal(result.isError, undefined);
    assert.deepEqual(
      calls[0]!.args,
      ["test", "-run", "TestScope", "./..."],
      "run maps to -run <regex> on the filterable suite",
    );
    assert.equal(calls.length, 1, "the non-filterable suite is skipped");
  });

  it("testToolReportsSkippedSuites: a filter pass skips non-filterable suites with the explicit line and header", async () => {
    const src = generateTestExtension(DETECTED.suites);
    const { definition, calls } = await loadGenerated(src, [
      () => ({ stdout: "go ok", stderr: "", code: 0, killed: false }),
    ]);

    const result = await runTool(definition, { scope: ["extensions"] });

    assert.equal(calls.length, 1, "only the filterable suite runs");
    assert.deepEqual(calls[0]!.args, ["test", "./extensions/..."]);
    const text = result.content[0]!.text;
    assert.equal(
      text.split("\n")[0],
      "filtered run — 1/2 suites — does not satisfy the done criteria",
      "every filtered result carries the header first (n = suites run, m = total)",
    );
    assert.ok(
      text.includes(
        "suite 'javascript (npm run test)' skipped (not filterable) — filtered iteration run, not verification",
      ),
      "the skip line is explicit",
    );
    assert.equal(result.isError, undefined, "no run suite failed");
  });

  it("testToolReportsSkippedSuites: a failing filtered run still reports the header and isError", async () => {
    const src = generateTestExtension(DETECTED.suites);
    // Only the filterable suite execs on this filtered run (npm is skipped),
    // so the queue's first item is what the go suite consumes.
    const { definition } = await loadGenerated(src, [
      () => ({ stdout: "FAIL", stderr: "", code: 1, killed: false }),
    ]);

    const result = await runTool(definition, { run: "TestX" });

    assert.equal(result.isError, true);
    const text = result.content[0]!.text;
    assert.equal(
      text.split("\n")[0],
      "filtered run — 1/2 suites — does not satisfy the done criteria",
    );
    assert.match(text, /1\/1 suite\(s\) failed/);
    assert.ok(
      text.includes(
        "suite 'javascript (npm run test)' skipped (not filterable) — filtered iteration run, not verification",
      ),
    );
  });
});

// ═══ resolveTestExtensionPath ═══
describe("resolveTestExtensionPath", () => {
  it("returns undefined when the file is absent", () => {
    assert.equal(resolveTestExtensionPath(tmpCwd()), undefined);
  });

  it("returns the absolute path when the file exists", () => {
    const dir = tmpCwd();
    const full = join(dir, ".pi", "extensions", "test.ts");
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(full, "// file\n");
    assert.equal(resolveTestExtensionPath(dir), full);
  });
});

// ═══ ensureTestTool ═══
describe("ensureTestTool", () => {
  it("ensureTestToolNoInjection: no files entry, no git query, no injection", async () => {
    const dir = tmpCwd();
    const pi = mockPi();

    const result = await ensureTestTool(pi, dir, DETECTED);

    assert.ok(!("fileEntry" in result), "no fileEntry (files) entry is returned (T7)");
    assert.ok(!("files" in result), "nothing the caller could inject into a contract allowlist");
    assert.deepEqual(
      Object.keys(result).sort(),
      ["message", "path", "source", "suites"],
      "the result shape is exactly { source, suites, path?, message }",
    );
    assert.equal(
      pi.execCalls.some((c) => c.cmd === "git"),
      false,
      "no git command runs — tracked-ness is never consulted",
    );
    assert.ok(!result.message.includes("declared"), "no allowlist-declaration wording");
  });

  it("writes a fresh extension with the marker, suites and evidence message", async () => {
    const dir = tmpCwd();
    const pi = mockPi();

    const result = await ensureTestTool(pi, dir, DETECTED);

    const full = join(dir, ".pi", "extensions", "test.ts");
    assert.ok(existsSync(full), "the extension file must be written");
    const content = readFileSync(full, "utf8");
    assert.ok(content.includes(GENERATED_MARKER), "the written file carries the marker");
    assert.ok(content.includes(JSON.stringify(["npm", "run", "test"])), "suites embedded");
    assert.equal(result.source, "detected");
    assert.equal(result.path, full);
    assert.deepEqual(result.suites, DETECTED.suites);
    assert.match(result.message, /generated/);
    assert.ok(
      result.message.includes(TEST_EXTENSION_RELATIVE),
      "the message names the repo-relative path",
    );
  });

  it("regenerates a marked file in place with the current suites", async () => {
    const dir = tmpCwd();
    const full = join(dir, ".pi", "extensions", "test.ts");
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(full, `${GENERATED_MARKER}\n// STALE content\n`);
    const pi = mockPi();

    const result = await ensureTestTool(pi, dir, CONFIG);

    assert.equal(readFileSync(full, "utf8"), generateTestExtension(CONFIG.suites), "content is exactly the generator output");
    assert.equal(result.source, "config");
    assert.equal(result.path, full);
    assert.ok(!("fileEntry" in result), "regeneration returns no files entry");
    assert.match(result.message, /regenerated/);
  });

  it("refuses to overwrite an unmarked file and reports it", async () => {
    const dir = tmpCwd();
    const full = join(dir, ".pi", "extensions", "test.ts");
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(full, "// hand written by a human\n");
    const pi = mockPi();

    const result = await ensureTestTool(pi, dir, DETECTED);

    assert.equal(readFileSync(full, "utf8"), "// hand written by a human\n", "hand-written content is untouched");
    assert.ok(!("fileEntry" in result), "no files entry when nothing was written");
    assert.equal(result.path, undefined);
    assert.equal(result.source, "existing", "the hand-written file owns the test-tool slot");
    assert.match(result.message, /hand-written/i);
    assert.match(result.message, /marker/i);
  });

  it("stops when a test tool from another path owns the name", async () => {
    const dir = tmpCwd();
    const pi = mockPi({ testToolPath: "/elsewhere/extensions/test.ts" });

    const result = await ensureTestTool(pi, dir, DETECTED);

    assert.equal(existsSync(join(dir, ".pi", "extensions", "test.ts")), false, "no file is written");
    assert.equal(result.source, "existing");
    assert.ok(!("fileEntry" in result));
    assert.equal(result.path, undefined);
    assert.match(result.message, /elsewhere/);
  });

  it("does not stop when the registered test tool comes from the generated path itself", async () => {
    const dir = tmpCwd();
    const full = join(dir, ".pi", "extensions", "test.ts");
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(full, `${GENERATED_MARKER}\n// STALE\n`);
    const pi = mockPi({ testToolPath: full });

    const result = await ensureTestTool(pi, dir, DETECTED);

    assert.equal(readFileSync(full, "utf8"), generateTestExtension(DETECTED.suites), "regenerated in place");
    assert.equal(result.path, full);
    assert.ok(!("fileEntry" in result));
  });

  it("returns none and writes nothing when detection found nothing", async () => {
    const dir = tmpCwd();
    const pi = mockPi();

    const result = await ensureTestTool(pi, dir, NONE);

    assert.equal(existsSync(join(dir, ".pi", "extensions", "test.ts")), false);
    assert.equal(result.source, "none");
    assert.deepEqual(result.suites, []);
    assert.ok(!("fileEntry" in result));
    assert.match(result.message, /no test/i);
  });

  it("still stops for an external tool when detection found nothing (registry first)", async () => {
    const dir = tmpCwd();
    const pi = mockPi({ testToolPath: "/elsewhere/test.ts" });

    const result = await ensureTestTool(pi, dir, NONE);

    assert.equal(result.source, "existing", "the registry check precedes the none branch");
    assert.match(result.message, /elsewhere/);
  });

  it("generates the tool from config suites as-is (no manifest detection)", async () => {
    const dir = tmpCwd();
    const pi = mockPi();

    const result = await ensureTestTool(pi, dir, CONFIG);

    const content = readFileSync(join(dir, ".pi", "extensions", "test.ts"), "utf8");
    assert.equal(content, generateTestExtension(CONFIG.suites));
    assert.ok(content.includes(JSON.stringify(["npm", "run", "test:ci"])), "configured argv used as-is");
    assert.equal(result.source, "config");
    assert.equal(result.path, join(dir, ".pi", "extensions", "test.ts"));
    assert.ok(!("fileEntry" in result));
  });
});

// ═══ T5 — dogfood: pi-workflow ships its own generated test extension ═══
describe("dogfood: pi-workflow's own generated test extension (T5)", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));

  it("detects the repo's own suite: package.json scripts.test + package-lock -> npm run test", () => {
    const detection = detectTestSuites(projectFacts(repoRoot));
    assert.equal(detection.source, "detected", "manifest scan with no config override");
    assert.deepEqual(
      detection.suites,
      [{ label: "javascript (npm run test)", argv: ["npm", "run", "test"] }],
      "package-lock.json (no pnpm/yarn/bun lock) pins the runner to npm",
    );
  });

  it(".pi/extensions/test.ts exists and equals generateTestExtension output for that suite", () => {
    const detection = detectTestSuites(projectFacts(repoRoot));
    const file = join(repoRoot, ".pi", "extensions", "test.ts");
    assert.ok(existsSync(file), ".pi/extensions/test.ts must exist in pi-workflow itself (dogfood)");
    const content = readFileSync(file, "utf8");
    assert.equal(
      content,
      generateTestExtension(detection.suites),
      "the dogfooded file must equal the generator output for the repo's detected suite",
    );
    assert.ok(content.includes(GENERATED_MARKER), "the marker guards regeneration");
    assert.equal(resolveTestExtensionPath(repoRoot), file, "resolution finds the repo's file");
  });
});

// ═══ T5 — README documents detection, generation, orchestrator ownership ═══
describe("README test-tool documentation (T5)", () => {
  const readme = (): string => readFileSync(new URL("../README.md", import.meta.url), "utf8");

  it("documents manifest-based test-suite detection with the lockfile runner", () => {
    const content = readme();
    assert.match(
      content,
      /test-suite detection|detects? (?:the )?(?:project's )?test suites/i,
      "suite detection must be documented",
    );
    assert.match(content, /lockfile/i, "the lockfile-derived runner must be documented");
  });

  it("documents generation of .pi/extensions/test.ts", () => {
    const content = readme();
    assert.match(content, /\.pi\/extensions\/test\.ts/, "the generated file path must be named");
    assert.match(content, /generat/i, "generation must be documented");
  });

  it("documents the generated test extension as orchestrator-owned, never auto-declared", () => {
    const content = readme();
    assert.doesNotMatch(
      content,
      /auto-declar/i,
      "the auto-declaration paragraph must be replaced by orchestrator-owned wording",
    );
    assert.match(content, /orchestrator-owned/i, "orchestrator ownership must be documented");
  });
});

// ═══ T5 — finalize-prompt.md and tdd-prompt.md updates ═══
describe("prompt content updates (T5)", () => {
  it("finalize-prompt.md treats .pi/extensions/test.ts as orchestrator-owned, not auto-injected", async () => {
    const content = await loadContent("finalize-prompt.md");
    assert.match(content, /\.pi\/extensions\/test\.ts/, "the generated file is named");
    assert.doesNotMatch(content, /auto-injected/i, "the auto-injection paragraph must be gone");
    assert.match(content, /orchestrator-owned/i, "orchestrator-owned wording must replace it");
  });

  it("tdd-prompt.md directs the solo agent to the test tool when present", async () => {
    const content = await loadContent("tdd-prompt.md");
    assert.match(content, /prefer the `test` tool/i, "the solo agent prefers the test tool");
    assert.match(content, /when present/i, "the direction is conditional on the tool being present");
  });
});
