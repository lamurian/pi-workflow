import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTestSuites,
  projectFacts,
  type DetectionFacts,
} from "../extensions/test-tool-detect.ts";
import { LANG_PROFILES } from "../extensions/test-scan-profiles.ts";

/** In-memory project facts from a { path: content } map (dirs derived from paths). */
function facts(files: Record<string, string>): DetectionFacts {
  return {
    hasFile: (name) => Object.prototype.hasOwnProperty.call(files, name),
    readFile: (name) => (name in files ? files[name]! : null),
    listDir: (rel) => {
      const prefix = rel === "." ? "" : `${rel}/`;
      const seen = new Map<string, boolean>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length).split("/");
        seen.set(rest[0]!, rest.length > 1 || seen.get(rest[0]!) === true);
      }
      return [...seen].map(([name, dir]) => ({ name, dir }));
    },
  };
}

/** Facts that throw on any access — proves detection was skipped entirely. */
const explodingFacts: DetectionFacts = {
  hasFile: () => {
    throw new Error("detection must not touch facts under a config override");
  },
  readFile: () => {
    throw new Error("detection must not touch facts under a config override");
  },
};

/** package.json content with the given test script. */
function pkg(testScript: string): string {
  return JSON.stringify({ scripts: { test: testScript } });
}

describe("detectTestSuites — package.json", () => {
  it("defaults to npm run test without a lockfile", () => {
    const result = detectTestSuites(facts({ "package.json": pkg("vitest run") }));
    const s = [{ label: "javascript (npm run test)", argv: ["npm", "run", "test"] }];
    assert.deepEqual(result, { source: "detected", suites: s, full: s });
  });

  it("derives pnpm, yarn and bun runners; pnpm wins", () => {
    const cases: Array<[string, string]> = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
    ];
    for (const [lockfile, runner] of cases) {
      const r = detectTestSuites(facts({ "package.json": pkg("vitest run"), [lockfile]: "" }));
      assert.deepEqual(r.suites[0]?.argv, [runner, "run", "test"]);
    }
    const r = detectTestSuites(
      facts({ "package.json": pkg("x"), "yarn.lock": "", "pnpm-lock.yaml": "" }),
    );
    assert.deepEqual(r.suites[0]?.argv, ["pnpm", "run", "test"]);
  });

  it("bare vitest/jest become scoped files suites via the lockfile exec", () => {
    const cases: Array<[string | null, string[]]> = [
      [null, ["npx"]],
      ["pnpm-lock.yaml", ["pnpm", "exec"]],
      ["yarn.lock", ["yarn"]],
      ["bun.lockb", ["bunx"]],
    ];
    for (const [lock, exec] of cases) {
      const extra: Record<string, string> = lock ? { [lock]: "" } : {};
      const v = detectTestSuites(facts({ "package.json": pkg("vitest"), ...extra }));
      assert.deepEqual(v.suites, [
        {
          label: `javascript (${[...exec, "vitest", "run", "{tests}"].join(" ")})`,
          argv: [...exec, "vitest", "run", "{tests}"],
          scope: "files",
        },
      ]);
      const j = detectTestSuites(facts({ "package.json": pkg("jest"), ...extra }));
      assert.deepEqual(j.suites[0]?.argv, [...exec, "jest", "--ci", "{tests}"]);
      assert.equal(j.suites[0]?.scope, "files");
    }
  });

  it("a vitest.config.* yields a vitest files suite without a test script", () => {
    const r = detectTestSuites(facts({ "package.json": "{}", "vitest.config.ts": "" }));
    assert.deepEqual(r.suites[0]?.argv, ["npx", "vitest", "run", "{tests}"]);
    assert.equal(r.suites[0]?.scope, "files");
  });

  it("skips package.json without a test and tolerates broken json", () => {
    const none = { source: "none", suites: [], full: [] };
    assert.deepEqual(detectTestSuites(facts({ "package.json": '{"scripts":{}}' })), none);
    assert.deepEqual(detectTestSuites(facts({ "package.json": "{not json" })), none);
  });
});

describe("detectTestSuites — languages", () => {
  it("go.mod yields a go test {pkgs} packages suite", () => {
    const r = detectTestSuites(facts({ "go.mod": "module x\n" }));
    assert.deepEqual(r.suites, [
      { label: "go (go test {pkgs})", argv: ["go", "test", "{pkgs}"], scope: "packages" },
    ]);
    assert.deepEqual(r.full, r.suites);
  });

  it("Cargo.toml yields cargo test", () => {
    const r = detectTestSuites(facts({ "Cargo.toml": "" }));
    assert.deepEqual(r.suites, [{ label: "rust (cargo test)", argv: ["cargo", "test"] }]);
  });

  it("python without pixi yields pytest {tests}", () => {
    for (const m of ["pyproject.toml", "pytest.ini"]) {
      const r = detectTestSuites(facts({ [m]: "" }));
      assert.deepEqual(r.suites, [
        { label: "python (pytest {tests})", argv: ["pytest", "{tests}"], scope: "files" },
      ]);
    }
  });

  it("python with pixi wraps pytest in pixi run python -m pytest", () => {
    const argv = ["pixi", "run", "python", "-m", "pytest", "{tests}"];
    const a = detectTestSuites(facts({ "pyproject.toml": "", "pixi.toml": "[project]\n" }));
    assert.deepEqual(a.suites[0]?.argv, argv);
    assert.equal(a.suites[0]?.scope, "files");
    const b = detectTestSuites(facts({ "pyproject.toml": "[tool.pixi.project]\n" }));
    assert.deepEqual(b.suites[0]?.argv, argv);
  });

  it("labels language suites with LANG_PROFILES ids", () => {
    const ids = new Set(LANG_PROFILES.map((p) => p.id));
    const r = detectTestSuites(
      facts({ "package.json": pkg("x"), "go.mod": "", "Cargo.toml": "", "pytest.ini": "" }),
    );
    assert.equal(r.suites.length, 4);
    for (const s of r.suites) assert.ok(ids.has(s.label.split(" (")[0]!));
  });
});

describe("detectTestSuites — task runners", () => {
  it("pixi test task yields full pixi run test", () => {
    const a = detectTestSuites(facts({ "pixi.toml": "[tasks]\ntest = \"pytest\"\n" }));
    assert.deepEqual(a.full, [{ label: "pixi (pixi run test)", argv: ["pixi", "run", "test"] }]);
    assert.deepEqual(a.suites, []);
    assert.equal(a.source, "detected");
    const b = detectTestSuites(
      facts({ "pyproject.toml": "[tool.pixi.tasks]\ntest = \"pytest\"\n" }),
    );
    assert.deepEqual(b.full.map((s) => s.argv), [["pixi", "run", "test"]]);
    assert.deepEqual(b.suites[0]?.argv, ["pixi", "run", "python", "-m", "pytest", "{tests}"]);
  });

  it("mise [tasks.test] yields full mise run test", () => {
    for (const m of ["mise.toml", ".mise.toml"]) {
      const r = detectTestSuites(facts({ [m]: "[tasks.test]\nrun = \"go test\"\n" }));
      assert.deepEqual(r.full.map((s) => s.argv), [["mise", "run", "test"]]);
    }
  });

  it("Makefile test target yields full make test, never scoped", () => {
    const r = detectTestSuites(facts({ Makefile: "test:\n\tgo test\n", "go.mod": "" }));
    assert.deepEqual(r.full, [{ label: "make (make test)", argv: ["make", "test"] }]);
    assert.ok(r.suites.every((s) => s.argv[0] !== "make"));
    const none = { source: "none", suites: [], full: [] };
    assert.deepEqual(detectTestSuites(facts({ Makefile: "build:\n" })), none);
    assert.deepEqual(detectTestSuites(facts({ Makefile: "test-%:\n" })), none);
  });
});

describe("detectTestSuites — nested", () => {
  it("every nested go.mod yields a packages suite with cwd", () => {
    const r = detectTestSuites(
      facts({ "go.mod": "", "svc/a/go.mod": "", "tools/go.mod": "", "vendor/x/go.mod": "" }),
    );
    assert.deepEqual(r.suites.map((s) => s.cwd), [undefined, "svc/a", "tools"]);
    for (const s of r.suites) assert.deepEqual(s.argv, ["go", "test", "{pkgs}"]);
  });

  it("ignores node_modules, .venv etc. and stops below depth 4", () => {
    const ignored = ["node_modules", "vendor", ".pixi", ".venv", "renv", ".git", "dist"];
    const files: Record<string, string> = { "a/b/c/d/go.mod": "", "a/b/c/d/e/go.mod": "" };
    for (const d of ignored) files[`${d}/m/go.mod`] = "";
    const r = detectTestSuites(facts(files));
    assert.deepEqual(r.suites.map((s) => s.cwd), ["a/b/c/d"]);
  });

  it("JS workspace packages with tests yield cwd suites", () => {
    const r = detectTestSuites(
      facts({
        "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
        "pnpm-lock.yaml": "",
        "packages/a/package.json": pkg("vitest"),
        "packages/b/package.json": "{}",
        "packages/b/vitest.config.ts": "",
        "packages/c/package.json": "{}",
        "other/package.json": pkg("vitest"),
      }),
    );
    assert.deepEqual(
      r.suites.map((s) => [s.cwd, s.scope, s.argv]),
      [
        ["packages/a", "files", ["pnpm", "exec", "vitest", "run", "{tests}"]],
        ["packages/b", "files", ["pnpm", "exec", "vitest", "run", "{tests}"]],
      ],
    );
    const y = detectTestSuites(
      facts({
        "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
        "apps/w/package.json": pkg("jest"),
      }),
    );
    assert.deepEqual(y.suites.map((s) => s.cwd), ["apps/w"]);
  });
});

describe("detectTestSuites — implement.testCommands override", () => {
  it("overrides detection entirely with source config", () => {
    const result = detectTestSuites(explodingFacts, {
      implement: { testCommands: [["npm", "run", "test:ci"]] },
    });
    assert.deepEqual(result, {
      source: "config",
      suites: [
        { label: "config (npm run test:ci)", argv: ["npm", "run", "test:ci"], scope: "full" },
      ],
      full: [{ label: "config (npm run test:ci)", argv: ["npm", "run", "test:ci"] }],
    });
  });

  it("falls through to detection when no entry survives", () => {
    const none = detectTestSuites(facts({ "go.mod": "" }), {
      implement: { testCommands: ["npm test", []] as never },
    });
    assert.equal(none.source, "detected");
    const empty = detectTestSuites(facts({ "go.mod": "" }), { implement: { testCommands: [] } });
    assert.deepEqual(empty.suites[0]?.argv, ["go", "test", "{pkgs}"]);
  });
});

describe("projectFacts (real fs)", () => {
  it("detects root and nested suites from a real temp project", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-detect-"));
    try {
      writeFileSync(join(dir, "package.json"), pkg("vitest"));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      mkdirSync(join(dir, "mod"));
      writeFileSync(join(dir, "mod", "go.mod"), "module m\n");
      const r = detectTestSuites(projectFacts(dir));
      assert.deepEqual(
        r.suites.map((s) => [s.cwd, s.argv]),
        [
          [undefined, ["pnpm", "exec", "vitest", "run", "{tests}"]],
          ["mod", ["go", "test", "{pkgs}"]],
        ],
      );
      assert.deepEqual(r.full, r.suites);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports none for an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-detect-empty-"));
    try {
      assert.deepEqual(detectTestSuites(projectFacts(dir)), { source: "none", suites: [], full: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
