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
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SUITE_TIMEOUT_MS,
  GENERATED_MARKER,
  TEST_EXTENSION_RELATIVE,
  ensureTestTool,
  generateTestExtension,
  resolveTestExtensionPath,
} from "../extensions/test-tool-ensure.ts";
import type { TestSuiteDetection } from "../extensions/test-tool-detect.ts";

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
  /** Exit code of `git ls-files --error-unmatch` (0 = tracked). */
  lsFilesCode?: number;
}

/** Mock ExtensionAPI with getAllTools + a recording exec (git ls-files seam). */
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
      if (cmd === "git" && args[0] === "ls-files") {
        const code = opts.lsFilesCode ?? 1;
        return {
          stdout: code === 0 ? `${TEST_EXTENSION_RELATIVE}\n` : "",
          stderr: code === 0 ? "" : "error: pathspec did not match",
          code,
          killed: false,
        };
      }
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

    const result = await withTimeoutEnv(undefined, () =>
      definition.execute("id1", {}, undefined, undefined, { cwd: "/proj" }),
    );

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

    await withTimeoutEnv("1500", () =>
      definition.execute("id2", {}, undefined, undefined, { cwd: "/proj" }),
    );

    assert.equal(calls[0]!.opts.timeout, 1500, "the env override wins");
  });

  it("caps a long suite output at the 4000-char tail", async () => {
    const huge = "HEAD" + "x".repeat(4990) + "TAIL";
    const src = generateTestExtension([DETECTED.suites[0]!]);
    const { definition } = await loadGenerated(src, [
      () => ({ stdout: huge, stderr: "", code: 0, killed: false }),
    ]);

    const result = await withTimeoutEnv(undefined, () =>
      definition.execute("id3", {}, undefined, undefined, { cwd: "/proj" }),
    );

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

    const result = await withTimeoutEnv(undefined, () =>
      definition.execute("id4", {}, undefined, undefined, { cwd: "/proj" }),
    );

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

    const result = await withTimeoutEnv(undefined, () =>
      definition.execute("id5", {}, undefined, undefined, { cwd: "/proj" }),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /spawn failed: spawn ENOENT/);
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
  it("writes a fresh extension and returns A when the path is untracked/absent", async () => {
    const dir = tmpCwd();
    const pi = mockPi({ lsFilesCode: 1 });

    const result = await ensureTestTool(pi, dir, DETECTED);

    const full = join(dir, ".pi", "extensions", "test.ts");
    assert.ok(existsSync(full), "the extension file must be written");
    const content = readFileSync(full, "utf8");
    assert.ok(content.includes(GENERATED_MARKER), "the written file carries the marker");
    assert.ok(content.includes(JSON.stringify(["npm", "run", "test"])), "suites embedded");
    assert.deepEqual(result.fileEntry, { path: TEST_EXTENSION_RELATIVE, status: "A" });
    assert.equal(result.source, "detected");
    assert.equal(result.path, full);
    assert.deepEqual(result.suites, DETECTED.suites);
    assert.match(result.message, /generated/);
    assert.match(result.message, /\.pi\/extensions\/test\.ts/);
    assert.ok(
      pi.execCalls.some(
        (c) => c.cmd === "git" && c.args.join(" ") === "ls-files --error-unmatch -- .pi/extensions/test.ts",
      ),
      "tracked-ness is decided via git ls-files --error-unmatch",
    );
  });

  it("returns M when the path is tracked by git", async () => {
    const dir = tmpCwd();
    const pi = mockPi({ lsFilesCode: 0 });

    const result = await ensureTestTool(pi, dir, DETECTED);

    assert.deepEqual(result.fileEntry, { path: TEST_EXTENSION_RELATIVE, status: "M" });
  });

  it("regenerates a marked file in place with the current suites", async () => {
    const dir = tmpCwd();
    const full = join(dir, ".pi", "extensions", "test.ts");
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(full, `${GENERATED_MARKER}\n// STALE content\n`);
    const pi = mockPi({ lsFilesCode: 0 });

    const result = await ensureTestTool(pi, dir, CONFIG);

    assert.equal(readFileSync(full, "utf8"), generateTestExtension(CONFIG.suites), "content is exactly the generator output");
    assert.equal(result.source, "config");
    assert.deepEqual(result.fileEntry, { path: TEST_EXTENSION_RELATIVE, status: "M" });
    assert.match(result.message, /regenerated/);
  });

  it("refuses to overwrite an unmarked file and reports it", async () => {
    const dir = tmpCwd();
    const full = join(dir, ".pi", "extensions", "test.ts");
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(full, "// hand written by a human\n");
    const pi = mockPi({ lsFilesCode: 0 });

    const result = await ensureTestTool(pi, dir, DETECTED);

    assert.equal(readFileSync(full, "utf8"), "// hand written by a human\n", "hand-written content is untouched");
    assert.equal(result.fileEntry, undefined, "no files entry when nothing was written");
    assert.equal(result.path, undefined);
    assert.equal(result.source, "existing", "the hand-written file owns the test-tool slot");
    assert.match(result.message, /hand-written/i);
    assert.match(result.message, /marker/i);
  });

  it("stops when a test tool from another path owns the name", async () => {
    const dir = tmpCwd();
    const pi = mockPi({ testToolPath: "/elsewhere/extensions/test.ts", lsFilesCode: 1 });

    const result = await ensureTestTool(pi, dir, DETECTED);

    assert.equal(existsSync(join(dir, ".pi", "extensions", "test.ts")), false, "no file is written");
    assert.equal(result.source, "existing");
    assert.equal(result.fileEntry, undefined);
    assert.equal(result.path, undefined);
    assert.match(result.message, /elsewhere/);
  });

  it("does not stop when the registered test tool comes from the generated path itself", async () => {
    const dir = tmpCwd();
    const full = join(dir, ".pi", "extensions", "test.ts");
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(full, `${GENERATED_MARKER}\n// STALE\n`);
    const pi = mockPi({ testToolPath: full, lsFilesCode: 0 });

    const result = await ensureTestTool(pi, dir, DETECTED);

    assert.equal(readFileSync(full, "utf8"), generateTestExtension(DETECTED.suites), "regenerated in place");
    assert.deepEqual(result.fileEntry, { path: TEST_EXTENSION_RELATIVE, status: "M" });
  });

  it("returns none and writes nothing when detection found nothing", async () => {
    const dir = tmpCwd();
    const pi = mockPi({ lsFilesCode: 1 });

    const result = await ensureTestTool(pi, dir, NONE);

    assert.equal(existsSync(join(dir, ".pi", "extensions", "test.ts")), false);
    assert.equal(result.source, "none");
    assert.deepEqual(result.suites, []);
    assert.equal(result.fileEntry, undefined);
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
    const pi = mockPi({ lsFilesCode: 1 });

    const result = await ensureTestTool(pi, dir, CONFIG);

    const content = readFileSync(join(dir, ".pi", "extensions", "test.ts"), "utf8");
    assert.equal(content, generateTestExtension(CONFIG.suites));
    assert.ok(content.includes(JSON.stringify(["npm", "run", "test:ci"])), "configured argv used as-is");
    assert.equal(result.source, "config");
    assert.deepEqual(result.fileEntry, { path: TEST_EXTENSION_RELATIVE, status: "A" });
  });
});
