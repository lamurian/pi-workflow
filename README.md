# pi-workflow

A pi extension for a lean **discuss → finalize → implement** workflow. Discussion and contract-drafting are gated (read-only); implementation defaults to an orchestrator that runs one subagent per contract task and gates each task on a landed commit.

Committing is the orchestrator's job, and the project's own pre-commit hooks are the verification gate. The orchestrator commits with plain `git commit` (never `--no-verify`), so hooks — lint, format, tests — fire naturally and own pass/fail. The orchestrator never invents test commands: verification comes from the project's hooks plus the orchestrator's own test gates over the detected suites (see [Test gates](#test-gates-orchestrator-run)). At `/finalize` the extension detects the project's test suites and generates a `test` tool the implementer units run in-turn (see [Test-tool detection, generation, and lifecycle](#test-tool-detection-generation-and-lifecycle)). In solo mode, the agent calls `commit_changes`, which also fires hooks.

Two deterministic gates protect the atomic green-commit invariant: a **test scan** at finalize time (advisory contract evidence) and a **staged-diff tamper guard** at commit time (hard, orchestrator-only). An optional third gate, the [slop gate](#slop-gate), scans the staged diff for AI-slop before the commit when enabled.

## Commands

| Command | Description |
|---------|-------------|
| `/discuss <topic>` | Discuss an issue, bug, chore, or small fix. No files are written; the agent clarifies, proposes an approach, and iterates until you confirm. |
| `/finalize` | Draft the atomic task contract (files, instruction, definition of done, testable tasks) from the discussion. Valid only after `/discuss`. |
| `/implement [--solo]` | Implement the finalized task contract. **Default: orchestrator** — spawns one subagent per active task, commits (hooks fire), and marks each done when HEAD moves. Pass `--solo` for the in-session TDD loop instead. Valid after `/finalize`; re-run it to resume a halted implementation from the first active task. |
| `/explore <instruction>` | Explore the codebase using parallel searches (scout subagents) and get a structured summary. |

## AI Tools

| Tool | Description |
|------|-------------|
| `explore` | Runs parallel codebase searches via scout subagents and returns a synthesized summary with relative file paths. |
| `save_task` | Persists the normalized contract (v2): `sources` and `tests` path lists plus `tasks[]` with a per-assertion `expectedOutput` array. Hard-validates every invariant (dangling taskRef, duplicate path, a path in both lists, a `D` entry without an owning task, empty `expectedOutput`, duplicate task id) and renders a per-task summary (id → sources → tests → assertion count). Then runs the test-suite detection step: when suites are detected and no session `test` tool exists, it generates `.pi/extensions/test.ts` — orchestrator-owned, never declared in the contract (see below). Then runs the deterministic **test scan**: per-entry evidence lines with confidence tags plus advisory warnings surface in the tool result. Transitions the workflow to the `finalizing` phase. Two operations: `replace` (default) saves the whole contract; `split` (`{ operation: "split", parentId, tasks: [{ description, expectedOutput, paths, commands? }] }`) replaces one task with children `<parentId>.1..k` — the agent may split in `finalizing`, the orchestrator in `implementing`. Both run the same commands, breadth and sizing checks. |
| `update_workflow_config` | Edits `.pi/workflow.json` (`implement.tests`, `implement.commands`, `finalize` limits) after schema validation. Allowed only in the `discussing` phase; the guard points units and later phases back to `/discuss`. |
| `mark_task_done` | Marks one task done after implementing it. For a task with `tests` refs the evidence carries the orchestrator's gate result line (scope + pass/fail) from the per-task scope gate, replacing the unit's self-report. Soft-warns (does not block) when no commit landed since the previous task. |
| `complete_implementation` | Ends the `implementing` phase and returns the workflow to idle. Refuses while any task is active, then runs the FULL GATE — every detected suite unfiltered, orchestrator-run — and blocks completion on red, naming the failing suite and its output tail. The orchestrator completes on its own and does not call this tool. |

There is no `run_tests` tool. Test-suite detection is deterministic and runs at `/finalize`: manifests are scanned and `.pi/extensions/test.ts` is generated for the detected suites, orchestrator-owned and never declared in the contract's path lists; orchestrator subagents load it as their `test` tool, defaulting to their task's derived scope. Authoritative verification belongs to the project's commit hooks plus the orchestrator's scope and full gates (orchestrator), or to the `test` tool and the agent's own sandboxed commands (solo).

The orchestrator runs extension code, not the model: it spawns the subagents, so no extra model-facing tools are exposed for that path.

## Workflow

1. **Discuss** — `/discuss <topic>` starts a conversation. The agent asks probing questions, proposes an approach, and iterates on feedback. File edits are blocked.
2. **Finalize** — `/finalize` has the agent draft the normalized contract (v2). `sources` and `tests` are the two path lists and the single source of truth: the guard's allowlist, each unit's scope and the path-ownership map are all derived from them (declare each fact once, never restate a path list). `tasks[]` holds the testable tasks, each with `id`, `description`, a `status` and an `expectedOutput` array with one entry per assertion — the task's tests must prove exactly those entries. Co-location rule: one task = test + implementation in the same commit — never split; a task whose `expectedOutput` describes only test artifacts is red by construction. `save_task` hard-validates the invariants (dangling taskRef, duplicate path, a path in both lists, a `D` entry without an owning task, empty `expectedOutput`, duplicate task id), renders a per-task summary (id → sources → tests → assertion count) and returns deterministic **scan evidence**; the agent classifies each item (preserved / superseded / obsolete / out-of-scope) and declares superseded/obsolete test paths in `tests`. You review the contract in the conversation; run `/implement` to approve.
3. **Implement (orchestrator, default)** — `/implement` runs an extension-code loop over the contract's active tasks, sequentially:
   - **Spawn** — one subagent per task, **bash-free** (lean shell-less subprocess: `read`/`write`/`edit`/`grep`/`find`/`ls`/`delete_file` only, no workflow or commit tools; override with `PI_IMPLEMENTER_TOOLS`). The unit loads the child contract-guard (`--no-extensions -e extensions/contract-guard/index.ts`) plus, when `/finalize` generated one, the project's `.pi/extensions/test.ts` (registering the `test` tool). The unit's task text is its **slice** of the normalized contract — task id, description, one line per `expectedOutput` assertion, the `sources`/`tests` it owns, preloaded contents of its owned files, and the Verification line; the full contract is never embedded. Before each spawn the orchestrator writes the payload to `.pi/workflow/contract-guard.json` — `repoRoot`, `baselineHead`, the derived allowlist and the unit's slice `unit { id, sources, tests, packages, testSuites }` — and passes its path via the internal `PI_UNIT_FILE` env var (`PI_CONTRACT_GUARD_FILE` stays as the read-fallback for one release; the guard fails closed when neither is valid). In-turn the guard enforces **strict per-task ownership**: `write`/`edit` only on declared paths whose `tasks` include the unit's task id, `delete_file` only on a `status: "D"` path the task owns; every other path or tool — undeclared paths, paths owned by other tasks, `.git/` paths, any tool outside the allowlist (including a shell re-added via the env override) — is blocked with the declared list in the message, and `.pi/extensions/test.ts` is blocked unconditionally (orchestrator-owned). The unit implements exactly its task and returns a report with a suggested conventional commit subject.
   - **Commit** — the orchestrator commits with the suggested conventional subject (no task id). Plain `git commit`: the project's pre-commit hooks fire and own verification. Before gating, staged paths that are declared but **owned by another task** are auto-unstaged (`git restore --staged -- <path>` — the work stays on disk for its owning task) and each unstage is appended to the attempt report as a remediation note; only truly undeclared paths halt the commit.
   - **Scope gate (per task, orchestrator-run)** — after each task commit lands, the orchestrator itself runs — via `state.testTool.suites`, never through the unit's `test` tool call — every filterable suite with the committed task's derived package scope plus every non-filterable suite unfiltered. A red gate means the task is not done: the loop steers a fix-forward attempt through the retry path instead of marking it done, and halts with the gate report (failing suite + output tail) past the retry budget. A task with no `tests` refs derives an empty scope and gets no gate — manual-ness is derived from the path lists, never a declared field.
   - **Full gate (completion)** — `complete_implementation` runs every detected suite unfiltered, orchestrator-run, and blocks completion on red, naming the failing suite and its output tail. `mark_task_done` evidence for a task with `tests` refs carries the orchestrator's gate result line (scope + pass/fail), replacing the unit's self-report.
   - **Staged-diff guard** — after `git add --all` and **before** `git commit`, the orchestrator inspects `git diff --cached --name-status` against the contract's `sources`/`tests` (the allowlist) and the test-kind tasks' `sourceFile`s. Violations — undeclared test deletions, deletions of a test-kind task's `sourceFile` (even when declared), skip/only markers added to undeclared test paths, and on fix retries any modification/deletion of undeclared test paths — block the commit: `git commit` is **never invoked**, no fix subagent spawns, no retry budget is consumed, and the loop halts immediately with a `test-guard` outcome. Assertion deltas (HEAD vs staged assertion-line counts) appear in the investigation as context only — they never gate.
   - **HEAD gate** — HEAD before/after classifies the attempt:
     - **HEAD moved** → the commit landed, hooks passed → task marked done.
     - **HEAD unchanged + dirty tree** → the hook rejected the commit → a deterministic investigation (exit code, failing lint/format/test stage, `git status`, `diff --stat`, hook output tail) is built and a fix subagent is spawned with it plus the raw hook output.
     - **HEAD unchanged + clean tree** → the unit landed no changes → explicit retry instruction.
     - **Commit timed out** (`PI_COMMIT_TIMEOUT_MS`) → infrastructure failure → halt, no fix subagent.
   - **Retry budget** — 5 retries per task (shared across unit errors, hook rejections, no-changes); a further failure halts.
   - **Progress and wrap-up steers (50% / 80%)** — the per-unit budget (`PI_IMPLEMENT_TIMEOUT_MS`, 600 s default) carries two steers: at 50% a progress check, at 80% a wrap-up steer to stop exploring, persist its work, and emit its JSON report. The hard kill at 100% is unchanged — the steer only gives the unit a chance to leave a coherent handoff instead of being killed mid-edit.
   - **Partial reports and continuations** — the implementer report parses optional `status`, `findings`, `nextSteps` and `alreadySatisfied` fields. A `partial` attempt that made tree progress continues without committing and without consuming the retry budget: a **continuation unit** picks up the uncommitted work with the prior findings and `nextSteps` injected. Continuations are bounded at **4 per task** (`MAX_CONTINUATIONS`); after that, plain retries take over.
   - **Early halt on non-converging exploration** — two consecutive attempts with **no** tree progress (e.g. repeated timeouts that wrote nothing) halt the task immediately with diagnosis `exploration not converging`, instead of burning the retry budget on attempts that never touch the tree.
   - **Shared findings ledger** — every unit's report findings are appended to a session-wide ledger, deduplicated, capped at 40 entries, and rendered into every subsequent unit's task text as `## Known findings from earlier units`. The ledger is cleared when implementation completes. When an attempt times out or returns no report, its recorded tool calls are collapsed into a **tool-call digest** finding (`previous attempt touched: …`) so the next unit inherits what the dead one learned.
   - **Persisted handoff** — every halt (and any orchestrator crash) persists `lastHalt` — task id, error carrying the investigation and hook output, tree state, landed commits, attempt records, diagnosis and recommended next action — into the session log, so failures are diagnosable after the fact.
   - **Enriched halt report** — on halt the orchestrator returns a structured report to the main process: `Commits landed since /implement started:` (per-run fallback lists landed commit subjects or `(none)`), a truncated attempt table (outcome, duration, progress, last text cut to 200 chars), the findings tail, a `Diagnosis:` line and a `Recommended next action:` line, closing with *"Relay this status and the recommended next action to the user. Do not run tools or modify the working tree."* The **main process** — not a subagent — relays this status and the recommended action to you.
   - **alreadySatisfied** — a unit may report `alreadySatisfied: true` when the task is in fact already implemented at HEAD. With a **clean tree and unchanged HEAD** since the attempt started, the orchestrator marks the task done **without invoking git commit** (no hook run, no retry) and lists it in the completion report under `Satisfied without a new commit:`. With a dirty tree the flag is ignored and the normal commit gate runs — only a verifiably no-op change skips the gate.
   Removed tasks are skipped.
4. **Implement (`--solo`)** — `/implement --solo` steers the in-session agent with a TDD prompt instead: write a failing test → implement → self-check (the `test` tool when present, else its own sandboxed commands) → `mark_task_done` → (when available) `commit_changes`, which fires the same hooks. When `commit_changes` is registered, the prompt instructs a conventional commit after each task; the instruction is omitted entirely when the tool is absent. `mark_task_done` soft-warns if HEAD has not advanced since the previous task — it never blocks.

   **Solo asymmetry:** solo mode has no extension-level staged-diff inspection, and no slop gate runs on this path either — the scan resolves only inside the orchestrator loop. The tamper rule is **prompt-only** (prompt discipline): the TDD prompt instructs the agent to never delete, skip, or weaken a test to land a commit, and to report instead. The orchestrator's hard guard does not apply on this path — only the project's commit hooks gate.
5. **Complete** — the orchestrator returns the workflow to idle on its own once every task is done (each `done` backed by a landed commit whose hooks passed and, for tasks with tests, a green scope gate; tasks reported `alreadySatisfied` on a clean tree with unchanged HEAD are flagged in the completion report). In solo mode the agent calls `complete_implementation`, which refuses while tasks are active and runs the full gate — every suite unfiltered — blocking completion on red. Completed manual tasks are listed in the final report under **Manual verification required**.
6. **Resume** — after a halt, re-run `/implement`. Done tasks are skipped and the loop continues from the first active one; when the working tree is dirty, the resumed unit receives the `git status --short` output as context. The original baseline HEAD is kept. The persisted `lastHalt` is rendered as a `## Previous run halted` section (diagnosis, recommended next action, attempt table) and prepended to the **first unit of the halted task only** — retries, continuations and other tasks never inherit it.
7. **Commit & push** — push and open a PR with your own git workflow.

### Run plan and preflight

`/finalize` pins a **run plan** in the workflow state: the scoped and full suites, the declared `implement.commands`, and a hash of `.pi/workflow.json`. Before any unit spawns, `/implement` runs a **preflight** that refuses to start when the config hash changed since approval, or when an active task owns a test path but the plan has no scoped suites. The refusal names the fix (`/discuss -> /finalize` to re-pin). A dirty-tree check then blocks on declared dirty paths and warns on undeclared ones.

### Named commands and the `run` tool

`implement.commands` in workflow.json maps command names to argv arrays (e.g. `{ "lint": ["npm", "run", "lint"] }`). A task lists the names it needs in `commands`; `save_task` rejects a name not declared there — add it via `update_workflow_config` first. The generated extension registers a `run` tool next to `test`, so bash-free units can execute exactly those declared commands and nothing else.

### Task sizing limits

`save_task` rejects oversized non-done tasks. Limits live under `finalize` in workflow.json:

| Key | Default | Meaning |
|-----|---------|---------|
| `maxPathsPerTask` | see `paths.ts` | Owned paths per task. |
| `maxAssertionsPerTask` | `3` | `expectedOutput` entries per task. |
| `maxManualAssertions` | `2` | Assertions per manual (`inspect:`) task. |
| `maxTaskBytes` | `98304` | Total bytes of a task's owned files. |

Bulk wording such as "every file" or "all rows" is rejected too. Split the task instead (`save_task` `operation: "split"`).

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_COMMIT_TIMEOUT_MS` | `300000` | Budget for `git commit` — hooks run lint+format+test, which can exceed a minute on cold caches. Exceeding it halts as an infrastructure failure. |
| `PI_IMPLEMENT_TIMEOUT_MS` | `600000` | Per-implementer-unit subprocess budget (600 s), independent of the scout timeout (`PI_EXPLORE_TIMEOUT_MS`). At 50% the unit gets a progress-check steer; at 80% it gets the wrap-up steer. |
| `PI_IMPLEMENTER_TOOLS` | `read,write,edit,grep,find,ls,delete_file` | Full override of the tool allowlist granted to implementer subprocesses. Units never receive a shell through this override — the child contract-guard blocks it either way. |
| `PI_SLOP_GATE` | (unset) | Overrides `implement.slop.mode` for the run when it holds a valid mode (`off`, `advisory`, `baseline`, `hard`); any other value is ignored and the configured mode stands. Read fresh when each task's gate resolves, so `PI_SLOP_GATE=off` disables the slop gate for a run (see [Slop gate](#slop-gate)). |
| `PI_UNIT_FILE` | `.pi/workflow/contract-guard.json` | Internal: path of the per-spawn payload the orchestrator writes before each unit spawn — `repoRoot`, `baselineHead`, the derived allowlist and the unit's slice `unit { id, sources, tests, packages, testSuites }`. Read by the child contract-guard (per-task ownership) and by the generated `test` tool (default scope). Not meant to be set by hand. |
| `PI_CONTRACT_GUARD_FILE` | `.pi/workflow/contract-guard.json` | Legacy read-fallback for `PI_UNIT_FILE`, kept for one release: the guard reads it when `PI_UNIT_FILE` is absent. Not meant to be set by hand. |

### Files-allowlist contract rule

The contract's path lists — `sources` and `tests` — are the guard's files allowlist: one entry per path, each naming the tasks that own it (shared files name several; `status: "D"` grants delete authority to its owning tasks only). Declare every test path the contract **updates or removes** in `tests`: superseded tests (asserting what the contract changes) and obsolete tests (covering what the contract removes). Undeclared test paths are protected — deleting or skipping them halts implementation with a `test-guard` outcome — and a staged path owned by another task is auto-unstaged at commit time with a remediation note (the work stays on disk). When implementation surfaces a required test-path change that is not declared, the correct move is `/discuss → /finalize` to amend the contract, not a workaround.

### Red-baseline assumption

The workflow assumes the project's test suite is **green before `/implement` starts**. The orchestrator does not run ad-hoc test commands: a pre-existing failure surfaces at the first per-task scope gate (red gate → fix-forward steers that cannot fix it → halt) and in the project's pre-commit hook, which rejects **every** commit regardless of the unit's work.

**Halt signature:** a red scope gate, or repeated `hook-rejected` outcomes attributed to the test stage, across successive tasks with retries burning to zero each time, and a gate/hook output tail showing the same pre-existing failure. **Resolution:** fix the baseline first, then re-run `/implement` — do not burn the retry budget against a red baseline.

### Contract test scan

`save_task` runs a deterministic, language-agnostic **test scan** after validation: a `git ls-files` based enumeration lists files (excluding `node_modules`, `.git`, `dist`, `build`, `coverage`, `.venv`, `vendor`), matched test files are read JS-side (size caps, binary sniffing), and four derivation layers — structural path mirroring, boundary-aware import-path matching, exported-symbol extraction (one-level barrels), basename fallback — match test files to each `files` entry using per-language profiles (JS/TS, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP). A pure cross-check then produces evidence lines (`entry -> test [method, confidence]`) and advisory warnings (`undeclared-referencing`, `declared-not-found`, `no-evidence`).

The scan is **advisory, confidence-tagged, and never blocking**: warnings never fail a save, zero-hit entries render `unverified` (never "clean"), and a scan failure degrades to a "scan unavailable" note. The agent classifies the evidence at finalize time; the commit-time guard is the hard enforcement.

### Test-tool detection, generation, and lifecycle

`save_task` gives bash-free implementer units an in-turn red-green loop via a generated `test` tool, following a fixed precedence chain:

1. **Config override** — `implement.tests.{scoped,full}` in workflow.json (argv arrays, optionally `{ argv, scope?, cwd? }` for scoped entries) or the legacy `implement.testCommands` (argv arrays) is used as-is: no detection, no generation. The scoped list drives the unit `test` tool and the scope gate; the full list drives the final gate (see [Scoped vs full suites](#scoped-vs-full-suites-scope-modes-placeholders-cwd-routing)).
2. **Existing tool** — when the session already has a tool named `test` from another path, it owns the name and nothing is generated.
3. **Test-suite detection** — otherwise manifests are scanned into the two recorded lists: the **scoped** suites (what the unit `test` tool and the scope gate route paths over) and the **full** suites (what the final gate runs). One suite per toolchain in fixed order: `package.json` `scripts.test` with a lockfile-derived runner (`pnpm-lock.yaml` → `pnpm exec`/`pnpm run test`, `yarn.lock` → `yarn`, `bun.lockb` → `bunx`, else `npx`/`npm run test`; a bare `vitest`/`jest` script — or a vitest/jest config file — maps to the non-watch files suite `vitest run {tests}`/`jest --ci {tests}`), JS workspace packages (`pnpm-workspace.yaml`/`package.json` `workspaces`) and nested go modules each adding a suite with their own `cwd`, `go.mod` → packages suite `go test {pkgs}`, `Cargo.toml` → full suite `cargo test`, `pyproject.toml`/`pytest.ini` → files suite `pytest {tests}` (wrapped as `pixi run python -m pytest {tests}` when pixi manages the environment: `pixi.toml` exists or `pyproject.toml` carries a `[tool.pixi]` table), and task-runner test tasks — `pixi run test` (`pixi.toml` `[tasks]` or `pyproject.toml` `[tool.pixi.tasks]` defines `test`), `mise run test` (`mise.toml`/`.mise.toml` `[tasks]` defines `test`), `make test` (`Makefile` `test:` target) — which become the full-suite list whenever any is present. Commands are argv arrays, never shell strings.
4. **Generation** — the detected suites generate `.pi/extensions/test.ts`, a self-contained (import-free) pi extension that registers the `test` tool and runs every suite sequentially via `pi.exec` with a per-suite `PI_TEST_TIMEOUT_MS` budget (default 300000 ms), labeled output capped at a 4000-char tail, and an error result when any suite fails. The file carries a `// GENERATED by pi-workflow /finalize — do not edit` marker guarding regeneration; an unmarked file at the same path is hand-written and never overwritten.
5. **Orchestrator ownership** — the generated file is **orchestrator-owned**: it is never declared in the contract's path lists, and the in-turn guard blocks write/edit on `.pi/extensions/test.ts` unconditionally for every unit. The orchestrator regenerates it at `/implement` start and lands it alone as `chore: regenerate test extension` — the sole chore-commit exception (any other staged path aborts it).
6. **Nothing detected** — a warning in the save result, no test tool, and verification falls back to the pre-commit hook (orchestrator) or inspection (unit).

This repository dogfoods the mechanism: its own `.pi/extensions/test.ts` is the generator output for its detected suite (`npm run test` via package-lock.json).

### Scoped vs full suites: scope modes, placeholders, cwd, routing

A recorded test tool (`state.testTool`) carries two suite lists:

- **Scoped suites** — what the generated `test` tool and the per-task scope gate route paths over. Configured as `implement.tests.scoped` (argv arrays or `{ argv, scope?, cwd? }`); otherwise detected from manifests.
- **Full suites** — what the final gate runs unfiltered. Configured as `implement.tests.full` (argv arrays or `{ argv, cwd? }`, never a `scope`); otherwise the detected task-runner suites (`pixi run test`, `mise run test`, `make test`) when any exists, else the scoped argv mapped to unfiltered form.

**Scope modes** — each scoped suite carries a mode deciding what routed paths it receives:

| Mode | Receives | Typical suite |
|------|----------|---------------|
| `files` | routed file paths spliced in at the `{tests}` placeholder | vitest, jest, pytest |
| `packages` | routed package dirs as `./dir/...` at `{pkgs}` | `go test` |
| `full` | nothing — always runs unfiltered | `cargo test`, `npm run test` |

A config entry sets `scope` explicitly; without one it is derived from argv (`go test ...` → `packages`, everything else → `full`). Detected suites carry their mode directly: vitest/jest/pytest are `files`, `go test` is `packages`, runner scripts and `cargo test` are `full`.

**Placeholders** — `{tests}` and `{pkgs}` are substituted per run: a files suite receives its routed paths (relative to the suite `cwd`) at `{tests}`; a packages suite receives the deduped package dirs of its routed files mapped to `./dir/...` (`./...` for the suite root) at `{pkgs}`, replacing any existing `./...`. Unfiltered runs — full scope, and the final-gate fallback — drop `{tests}` and map `{pkgs}` to `./...`.

**cwd and routing** — a suite may declare a repo-relative `cwd` (config entries only; rejected when absolute, containing `..`, or nonexistent under the repo root). Routing sends each path only to the matching-language suite whose `cwd` is the deepest ancestor of it: `.py` → python, `.go` → go (and only `_test.go`), `.ts`/`.tsx`/`.js`/`.jsx` → javascript. `D`-status paths are never routed, and a files/packages suite with no routed paths is skipped with an explicit line instead of run. Every routed suite executes via `pi.exec` with `cwd = join(repoRoot, suite.cwd)` — each suite in its own directory, not just the repo root. The generated tool applies the same routing in-turn: a no-args run routes the unit payload's owned test files (`unit.testFiles` via `PI_UNIT_FILE`), `test(scope, run)` routes explicit repo-relative paths (with `run` inserted as `-run <regex>` for `go test`), and every filtered run carries the `filtered run — n/m suites — does not satisfy the done criteria` header.

### Test gates (orchestrator-run)

The gates run the suites recorded at `/finalize` (`state.testTool`) through the orchestrator's own execution — never through a unit's `test` tool call, so a unit cannot certify its own work:

- **Scope gate** — after each task commit lands, the orchestrator routes the committed task's owned test paths (its declared non-`D` `tests` entries) over the scoped suites exactly like the `test` tool: each suite runs its routed argv in its own `cwd`, full-scope suites run unfiltered at every scope gate, and a suite that received no paths is recorded as skipped (`(skipped — no routed paths)`, counted green) instead of run. Each suite gets the `PI_TEST_TIMEOUT_MS` budget (default 300000 ms). Red ⇒ the task stays open: the loop steers a fix-forward attempt through the retry path and does not mark the task done; past the retry budget the run halts with the gate report (failing suite + output tail). A task with no `tests` refs derives an empty scope and gets no gate.
- **Unbounded final gate (both modes)** — the final gate resolves the recorded **full** suites (falling back to the scoped suites with `{tests}` dropped and `{pkgs}` mapped to `./...`) and runs each sequentially in its own `cwd` with **no exec timeout** — unbounded by contract — forwarding the caller's AbortSignal. It runs in both modes: the orchestrator runs it after every task is done, and `complete_implementation` runs it before returning to idle in `--solo`. A red gate blocks completion, naming each failing suite and its output tail (solo: a second consecutive red refuses with a stop-and-report instruction instead of retrying).
- **Final-gate triage, one fix round, `/discuss` steer** — on a red final gate the orchestrator extracts the failing test paths from each red suite's tail (pytest `FAILED`, vitest/go `FAIL`, go `--- FAIL:` blocks), maps them repo-relative through the suite `cwd`, and marks each against the contract's allowlist. When **every** failing test is declared, exactly one `FULL-GATE` fix unit runs — carrying the red gate report, the landed commits and the failing tests with their owning tasks, allowed to write only declared paths and never to delete, skip or weaken a test — its commit goes through the normal commit gate, and the final gate re-runs once (green completes; red halts with the report). When any failing test is **undeclared**, or a red suite yields no parseable failing path, no fix round runs: the halt lists each failure with its declared/undeclared marking and owners and steers `/discuss → /finalize → /implement` to re-declare the paths in the contract. A fix unit blocked by the guard on an undeclared path halts with the same steer.
- **Gate-backed evidence** — `mark_task_done` evidence for a task with `tests` refs carries the orchestrator's gate result line (scope + pass/fail), replacing the unit's self-report.

Filtered in-turn runs by a unit are iteration only: the generated `test` tool headers them `filtered run — n/m suites — does not satisfy the done criteria` and reports skipped non-filterable suites as `filtered iteration run, not verification`. Verification is the orchestrator's gates plus the project's hooks — never the unit's own run.

### Slop gate

The orchestrator optionally scans the **staged diff** for AI-slop before every commit: code paths are scored with `aislop scan --staged --json`, prose paths (`.md`/`.mdx`/`.txt`) with one `zero-slop score <path>` each — and only when such paths are actually staged. Configuration lives under `implement.slop` in workflow.json (defaults ← global ← project-local); keys are validated independently, so a partial or malformed block keeps the missing defaults:

| Key | Default | Meaning |
|-----|---------|---------|
| `mode` | `advisory` | Gate behavior: `off`, `advisory`, `baseline` or `hard`. |
| `fetchFallback` | `true` | Allow the `npx --yes <pkg>@latest` network fallback when a scanner is not installed locally. |
| `codeFailBelow` | `80` | A code score below this breaches the gate. |
| `proseGate` | `25` | A prose score above this breaches the gate. |

**Modes and manual promotion** — the four modes increase in strictness and promotion is **manual**: nothing escalates on its own. Promote or relax the gate by editing `implement.slop.mode` in workflow.json, or override it for a run with `PI_SLOP_GATE` (see the environment-variable table above):

- `off` — the gate does not run; no scanner is resolved.
- `advisory` (default) — never blocks. Each breach becomes a `slop advisory:` note (e.g. `slop advisory: code score 42 is below codeFailBelow 80`) that rides the landed commit into the shared findings ledger.
- `baseline` — blocks only slop the change itself introduced (next paragraph).
- `hard` — blocks on any breach: a code score below `codeFailBelow` (listing every staged diagnostic) or a prose score above `proseGate`.

**Baseline-as-HEAD semantics** — `baseline` measures the staged state against HEAD instead of raw thresholds alone. A code diagnostic counts as a violation only when its line was **added by the staged diff** (from `git diff --cached -U0` added-line facts; the raw code score is ignored). A prose file breaches only when its staged score exceeds **both** `proseGate` and the file's HEAD score: the HEAD version is extracted with `git show HEAD:<path>` into a temp file and scored alongside the staged one; a path absent at HEAD has no HEAD score and is judged against `proseGate` alone.

**Fetch fallback** — each scanner resolves through a ladder: `<cwd>/node_modules/.bin/<tool>` first, then `which <tool>` on PATH, then — when `fetchFallback` is `true` — `npx --yes <pkg>@latest` (`zero-slop` additionally requires `python3` on PATH, checked first). An unresolvable scanner or unparseable output never blocks: it degrades to a never-blocking `slop gate unavailable:` note.

**Fix rounds (`slop-guard`)** — the gate runs after the staged-diff tamper guard and **before `git commit`**. A `block` verdict never invokes `git commit`: the attempt is classified `slop-guard` and a fix round is spawned with the investigation and the violation list. The fix instruction requires rewriting or deleting the flagged content — adding `aislop-ignore` directives, suppression comments or config exclusions to silence the gate is explicitly forbidden. A `slop-guard` spends the shared 5-retry budget like any other failed attempt; past it the run halts with `slop gate blocked the commit for <id> after 5 retries`, and the halt diagnosis recommends reviewing the findings or setting `implement.slop.mode` to `advisory` before re-running `/implement`. Advisory notes never block: they only ever ride a commit that lands.

**Solo asymmetry** — none of this runs in `--solo` mode: the gate resolves only inside the orchestrator loop, so the agent's own `git commit` path is scanned by nothing — only the project's pre-commit hooks gate, consistent with the prompt-only tamper rule described in the workflow above.

### Diagnosing a halt

The last `workflow-state` session entry carries `lastHalt`: the task that failed, the error (unit failure, hook investigation with raw hook output, staged-diff guard investigation with name-status lines, or timeout note), `git status --short` at halt time, the commits landed since `/implement` started, the attempt records (outcome, duration, progress, truncated last text), and the derived diagnosis with recommended next action. The same content is returned to the main process as the halt report, which relays it to you. A `test-guard` halt means the staged diff touched undeclared tests — re-declare via `/discuss → /finalize`, then re-run `/implement` to resume. A `slop-guard` halt means the gate flagged the staged diff — remove the flagged content (or relax `implement.slop.mode`), then re-run `/implement`. A red-baseline signature (see above) means fix the suite before resuming.

### Re-finalizing preserves done behaviors

When `save_task` runs with a prior contract (a re-finalize after a halt or scope change), a draft behavior **keeps status `done`** whenever the prior contract has a behavior with the same id, identical description and identical `expectedOutput` whose status was `done` — an unchanged done behavior is never demoted to active. Any text change leaves the draft's own status. Preserved ids are reported in the tool result as `Preserved done behaviors: T1, T2` so the agent and reviewer can see what survived the rewrite.

### Escaping a gated phase

`discussing` and `finalizing` block file edits. There is no reset command; use `/new` to start a fresh session.

## Skills

Installed skills:
- `pre-commit-hook` — pre-commit setup patterns
- `pre-push-hook` — pre-push setup patterns
- `env-management` — environment management patterns

## Compaction

The extension preserves the task contract during context compaction. The contract (behaviors and their statuses) and the spec are included in compaction summaries under Task Contract, Specification, and Next Steps.

## File Structure

```
pi-workflow/
├── package.json              # pi package manifest
├── extensions/               # Extension source
│   ├── index.ts              # Entry point — wires commands, events, tool gates
│   ├── prompt.ts             # buildPhasePrompt (discussing phase protocol)
│   ├── state.ts              # Phase state machine and persistence
│   ├── discuss.ts            # /discuss orchestration
│   ├── implement.ts          # /implement entry + mark_task_done/complete_implementation + crash safety + report
│   ├── implement-loop.ts     # Orchestrator loop (spawn → staged-diff guard → commit → HEAD gate → mark, retry budget, halt, resume)
│   ├── commit-gate.ts        # HEAD-gate classification + staged-diff tamper classifier + investigations + fix-task builder (pure)
│   ├── test-scan.ts          # Language profiles, isTestPath, derivation layers, cross-check (pure)
│   ├── implementer-runner.ts # Implementer subprocess runner (spawn errors, stdout tails, wrap-up steer, named timeouts)
│   ├── findings-ledger.ts    # Shared findings ledger (cap, digest fallback, section rendering)
│   ├── halt-report.ts        # Halt report rendering (attempt table, diagnosis, recommendation)
│   ├── resume-context.ts     # "Previous run halted" section for resumed runs
│   ├── unit-progress.ts      # Partial-attempt continuations, early halt, alreadySatisfied (pure)
│   ├── finalize.ts           # /finalize command + save_task tool + contract scan wiring
│   ├── task-contract.ts      # Pure contract logic (validation, rendering, done-preservation, completion gate)
│   ├── explore.ts            # /explore command + explore tool
│   ├── explore-core.ts       # Parallel exploration engine
│   ├── subagent-runner.ts    # Scout + implementer subprocess spawning, timeouts, argv builders
│   ├── autocomplete.ts       # @ file reference autocomplete
│   ├── compaction.ts         # Compaction spec preservation
│   ├── paths.ts              # workflow.json config loading
│   └── utils.ts              # Shared utilities (loadContent, parseArgs, shortSlug)
├── content/                  # Protocol prompts
│   ├── phase-discussing.md   # /discuss protocol
│   ├── phase-finalizing.md   # /finalize review protocol
│   ├── finalize-prompt.md    # Task-contract drafting prompt
│   ├── tdd-prompt.md         # Solo TDD enforcement prompt
│   ├── unit-prompt.md        # Orchestrator subagent (per-behavior unit) prompt
│   ├── report-template.md    # End-of-implementation report
│   ├── explore-decompose.md  # Exploration decomposition prompt
│   ├── explore-synthesis.md  # Exploration synthesis prompt
│   └── agents/scout.md       # Scout agent definition
└── skills/                   # Reference skills (pre-commit, pre-push, env)
```

## Development

```bash
cd ~/.pi/agent/extensions
git clone <repo-url>
cd pi-workflow
npm install
```

pi auto-discovers the extension from `extensions/index.ts`.

## Publishing

```bash
# Tag and push
git tag v0.1.0
git push origin v0.1.0

# Users install with:
pi install git:github.com/user/pi-workflow
```
