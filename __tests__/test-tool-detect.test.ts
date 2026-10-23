import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTestSuites,
  projectFacts,
  type DetectionFacts,
} from "../extensions/test-tool-detect.ts";
import { LANG_PROFILES } from "../extensions/test-scan-profiles.ts";

/** In-memory project facts from a { filename: content } map. */
function facts(files: Record<string, string>): DetectionFacts {
  return {
    hasFile: (name) => Object.prototype.hasOwnProperty.call(files, name),
    readFile: (name) => (name in files ? files[name]! : null),
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

// ═══ package.json runner by lockfile ═══
describe("detectTestSuites — package.json runner by lockfile", () => {
  it("defaults to npm run test without a lockfile", () => {
    const result = detectTestSuites(facts({ "package.json": pkg("vitest run") }));
    assert.deepEqual(result, {
      source: "detected",
      suites: [{ label: "javascript (npm run test)", argv: ["npm", "run", "test"] }],
    });
  });

  it("derives pnpm, yarn and bun runners from their lockfiles", () => {
    const cases: Array<[string, string[]]> = [
      ["pnpm-lock.yaml", ["pnpm", "run", "test"]],
      ["yarn.lock", ["yarn", "run", "test"]],
      ["bun.lockb", ["bun", "run", "test"]],
    ];
    for (const [lockfile, argv] of cases) {
      const result = detectTestSuites(
        facts({ "package.json": pkg("vitest run"), [lockfile]: "" }),
      );
      assert.deepEqual(result.suites[0]?.argv, argv, `${lockfile} -> ${argv.join(" ")}`);
    }
  });

  it("prefers pnpm over yarn when several lockfiles are present", () => {
    const result = detectTestSuites(
      facts({ "package.json": pkg("vitest run"), "yarn.lock": "", "pnpm-lock.yaml": "" }),
    );
    assert.deepEqual(result.suites[0]?.argv, ["pnpm", "run", "test"]);
  });

  it("maps a bare vitest script to `vitest run` (watch-mode hazard)", () => {
    const result = detectTestSuites(facts({ "package.json": pkg("vitest") }));
    assert.deepEqual(result, {
      source: "detected",
      suites: [{ label: "javascript (vitest run)", argv: ["vitest", "run"] }],
    });
  });

  it("maps a bare jest script to `jest --ci` (watch-mode hazard)", () => {
    const result = detectTestSuites(facts({ "package.json": pkg("jest") }));
    assert.deepEqual(result.suites, [{ label: "javascript (jest --ci)", argv: ["jest", "--ci"] }]);
  });

  it("uses the lockfile runner when the script is not bare vitest/jest", () => {
    const result = detectTestSuites(
      facts({ "package.json": pkg("vitest run --coverage"), "pnpm-lock.yaml": "" }),
    );
    assert.deepEqual(result.suites[0]?.argv, ["pnpm", "run", "test"]);
  });

  it("skips package.json without a scripts.test entry", () => {
    const result = detectTestSuites(
      facts({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) }),
    );
    assert.deepEqual(result, { source: "none", suites: [] });
  });

  it("tolerates a broken package.json without throwing", () => {
    const result = detectTestSuites(facts({ "package.json": "{not json" }));
    assert.deepEqual(result, { source: "none", suites: [] });
  });
});

// ═══ Other toolchains ═══
describe("detectTestSuites — other toolchains", () => {
  it("go.mod yields `go test ./...`", () => {
    const result = detectTestSuites(facts({ "go.mod": "module example.com/x\n" }));
    assert.deepEqual(result, {
      source: "detected",
      suites: [{ label: "go (go test ./...)", argv: ["go", "test", "./..."] }],
    });
  });

  it("Cargo.toml yields `cargo test`", () => {
    const result = detectTestSuites(facts({ "Cargo.toml": "[package]\nname = \"x\"\n" }));
    assert.deepEqual(result.suites, [{ label: "rust (cargo test)", argv: ["cargo", "test"] }]);
  });

  it("pyproject.toml and pytest.ini each yield `pytest`", () => {
    for (const manifest of ["pyproject.toml", "pytest.ini"]) {
      const result = detectTestSuites(facts({ [manifest]: "" }));
      assert.deepEqual(
        result.suites,
        [{ label: "python (pytest)", argv: ["pytest"] }],
        `${manifest} -> pytest`,
      );
    }
  });

  it("a Makefile with a test: target yields `make test`", () => {
    const result = detectTestSuites(facts({ Makefile: "test:\n\tnpm test\n" }));
    assert.deepEqual(result.suites, [{ label: "make (make test)", argv: ["make", "test"] }]);
  });

  it("a Makefile without a test: target yields nothing", () => {
    const result = detectTestSuites(facts({ Makefile: "build:\n\ttsc\n" }));
    assert.deepEqual(result, { source: "none", suites: [] });
  });

  it("does not treat a pattern target (test-%:) as the test target", () => {
    const result = detectTestSuites(facts({ Makefile: "test-%:\n\trun $@\n" }));
    assert.deepEqual(result, { source: "none", suites: [] });
  });
});

// ═══ Multi-language aggregation ═══
describe("detectTestSuites — multi-language aggregation", () => {
  it("collects every toolchain in a deterministic order with argv-array commands", () => {
    const result = detectTestSuites(
      facts({
        "package.json": pkg("vitest"),
        "pnpm-lock.yaml": "",
        "go.mod": "module example.com/x\n",
        "Cargo.toml": "[package]\n",
        "pyproject.toml": "[project]\n",
        Makefile: "test:\n\tmake test\n",
      }),
    );
    assert.equal(result.source, "detected");
    assert.deepEqual(
      result.suites.map((s) => s.argv),
      [
        ["vitest", "run"],
        ["go", "test", "./..."],
        ["cargo", "test"],
        ["pytest"],
        ["make", "test"],
      ],
    );
    for (const suite of result.suites) {
      assert.ok(Array.isArray(suite.argv), "commands are argv arrays, never shell strings");
      assert.ok(suite.argv.every((part) => typeof part === "string" && part.length > 0));
    }
  });
});

// ═══ LANG_PROFILES reuse ═══
describe("detectTestSuites — LANG_PROFILES reuse", () => {
  it("labels every language suite with a LANG_PROFILES id", () => {
    const profileIds = new Set(LANG_PROFILES.map((p) => p.id));
    for (const id of ["javascript", "go", "rust", "python"]) {
      assert.ok(profileIds.has(id), `LANG_PROFILES must carry the ${id} profile`);
    }
    const result = detectTestSuites(
      facts({
        "package.json": pkg("vitest run"),
        "go.mod": "",
        "Cargo.toml": "",
        "pytest.ini": "",
        Makefile: "test:\n\ttrue\n",
      }),
    );
    for (const suite of result.suites) {
      const language = suite.label.split(" (")[0]!;
      if (language === "make") continue; // Makefile has no language profile.
      assert.ok(profileIds.has(language), `label language ${language} must be a LANG_PROFILES id`);
    }
  });
});

// ═══ implement.testCommands override ═══
describe("detectTestSuites — implement.testCommands override", () => {
  it("overrides detection entirely with source config and the argv as-is", () => {
    const result = detectTestSuites(explodingFacts, {
      implement: { testCommands: [["npm", "run", "test:ci"]] },
    });
    assert.deepEqual(result, {
      source: "config",
      suites: [{ label: "config (npm run test:ci)", argv: ["npm", "run", "test:ci"] }],
    });
  });

  it("accepts several configured commands", () => {
    const result = detectTestSuites(explodingFacts, {
      implement: {
        testCommands: [
          ["go", "test", "./..."],
          ["pytest", "-q"],
        ],
      },
    });
    assert.deepEqual(
      result.suites.map((s) => s.argv),
      [
        ["go", "test", "./..."],
        ["pytest", "-q"],
      ],
    );
  });

  it("drops invalid entries and falls through to detection when none survive", () => {
    const partial = detectTestSuites(facts({ "go.mod": "" }), {
      implement: { testCommands: [["go", "test"], "npm test", [], [42]] as never },
    });
    assert.deepEqual(partial.suites, [{ label: "config (go test)", argv: ["go", "test"] }]);

    const none = detectTestSuites(facts({ "go.mod": "" }), {
      implement: { testCommands: ["npm test", []] as never },
    });
    assert.equal(none.source, "detected", "an all-invalid override falls through to detection");
  });

  it("treats an empty testCommands array as unset and detects normally", () => {
    const result = detectTestSuites(facts({ "go.mod": "" }), {
      implement: { testCommands: [] },
    });
    assert.equal(result.source, "detected");
    assert.deepEqual(result.suites[0]?.argv, ["go", "test", "./..."]);
  });
});

// ═══ No manifests ═══
describe("detectTestSuites — no manifests", () => {
  it("returns { source: none, suites: [] } when nothing matches", () => {
    assert.deepEqual(detectTestSuites(facts({})), { source: "none", suites: [] });
  });
});

// ═══ projectFacts (real fs) ═══
describe("projectFacts (real fs)", () => {
  it("detects suites from a real temp project", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-detect-"));
    try {
      writeFileSync(join(dir, "package.json"), pkg("vitest"));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const result = detectTestSuites(projectFacts(dir));
      assert.deepEqual(result, {
        source: "detected",
        suites: [{ label: "javascript (vitest run)", argv: ["vitest", "run"] }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports none for an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-detect-empty-"));
    try {
      assert.deepEqual(detectTestSuites(projectFacts(dir)), { source: "none", suites: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
