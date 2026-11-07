import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateWorkflowConfig } from "../extensions/workflow-config-schema.ts";

describe("validateWorkflowConfig", () => {
  it("accepts argv and object test entries", () => {
    const errs = validateWorkflowConfig({
      implement: {
        tests: {
          scoped: [["npx", "vitest"], { argv: ["go", "test"], scope: "packages", cwd: "svc" }],
          full: [["npm", "test"], { argv: ["make", "test"], cwd: "." }],
        },
      },
    });
    assert.deepEqual(errs, []);
  });

  it("rejects bad test entry shapes naming the JSON path", () => {
    const errs = validateWorkflowConfig({
      implement: { tests: { scoped: ["npm test", { argv: [] }], full: [{ argv: ["x"], scope: "files" }] } },
    });
    assert.ok(errs.some((e) => e.startsWith("implement.tests.scoped[0]")));
    assert.ok(errs.some((e) => e.startsWith("implement.tests.scoped[1].argv")));
    assert.ok(errs.some((e) => e.startsWith("implement.tests.full[0].scope")));
  });

  it("accepts commands as argv maps and rejects shell strings", () => {
    assert.deepEqual(validateWorkflowConfig({ implement: { commands: { lint: ["npm", "run", "lint"] } } }), []);
    const errs = validateWorkflowConfig({ implement: { commands: { lint: "npm run lint", fmt: [] } } });
    assert.ok(errs.some((e) => e.startsWith("implement.commands.lint")));
    assert.ok(errs.some((e) => e.startsWith("implement.commands.fmt")));
  });

  it("accepts finalize limits only as positive integers", () => {
    assert.deepEqual(
      validateWorkflowConfig({
        finalize: { maxPathsPerTask: 5, maxAssertionsPerTask: 3, maxManualAssertions: 1, maxTaskBytes: 4000 },
      }),
      [],
    );
    const errs = validateWorkflowConfig({
      finalize: { maxPathsPerTask: 0, maxAssertionsPerTask: 1.5, maxManualAssertions: "2", maxTaskBytes: -1 },
    });
    for (const k of ["maxPathsPerTask", "maxAssertionsPerTask", "maxManualAssertions", "maxTaskBytes"]) {
      assert.ok(errs.some((e) => e.startsWith(`finalize.${k}`)), k);
    }
  });

  it("keeps paths.ts at or below 300 lines", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "extensions", "paths.ts"), "utf-8");
    assert.ok(src.split("\n").length <= 300);
  });
});
