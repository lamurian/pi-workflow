---
name: workflow-config
description: Author and update .pi/workflow.json (test suites, named commands, finalize sizing limits) through the update_workflow_config tool.
---

# Workflow config (.pi/workflow.json)

## Write path

`update_workflow_config` is the only write path. Never edit `.pi/workflow.json`
with `write`/`edit`. The tool takes a JSON merge patch, validates the result,
shows every argv for user confirmation, and only then writes. Without a UI the
confirm step fails and nothing is written.

## implement.tests

- `implement.tests.scoped`: suites the per-task `test` tool runs. Each entry is
  an argv array or `{ "argv": [...], "scope": "files" | "packages" | "full", "cwd": "rel/dir" }`.
  Changed paths are appended per scope (`files`: test files, `packages`: package dirs,
  `full`: no filter).
- `implement.tests.full`: suites for the full gate. Entry is argv or `{ "argv", "cwd" }`.

Important: full suites without scoped suites leave units without a test tool.
Always configure at least one scoped suite if units should run tests.

## implement.commands

Named commands: `name -> non-empty argv array`, e.g. `"lint": ["pixi", "run", "lint"]`.

## finalize sizing limits

Positive integers only:

- `finalize.maxPathsPerTask` (default 5)
- `finalize.maxAssertionsPerTask`
- `finalize.maxManualAssertions`
- `finalize.maxTaskBytes`

## Pixi example

```json
{
  "implement": {
    "tests": {
      "scoped": [{ "argv": ["pixi", "run", "pytest", "-q"], "scope": "files" }],
      "full": [["pixi", "run", "pytest", "-q"]]
    },
    "commands": { "lint": ["pixi", "run", "lint"] }
  },
  "finalize": { "maxPathsPerTask": 5, "maxAssertionsPerTask": 8 }
}
```
