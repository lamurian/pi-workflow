# pi-workflow

A pi extension for a lean **discuss → finalize → implement** workflow. Discussion and contract-drafting are gated (read-only); implementation defaults to an orchestrator that runs one subagent per contract behavior and gates each behavior on a landed commit.

Committing is the orchestrator's job, and the project's own pre-commit hooks are the verification gate. The orchestrator commits with plain `git commit` (never `--no-verify`), so hooks — lint, format, tests — fire naturally and own pass/fail. The extension never detects or runs test commands itself (project sandboxes differ; wrong guesses produced false halts). In solo mode, the agent calls `commit_changes`, which also fires hooks.

Two deterministic gates protect the atomic green-commit invariant: a **test scan** at finalize time (advisory contract evidence) and a **staged-diff tamper guard** at commit time (hard, orchestrator-only).

## Commands

| Command | Description |
|---------|-------------|
| `/discuss <topic>` | Discuss an issue, bug, chore, or small fix. No files are written; the agent clarifies, proposes an approach, and iterates until you confirm. |
| `/finalize` | Draft the atomic task contract (files, instruction, definition of done, testable behaviors) from the discussion. Valid only after `/discuss`. |
| `/implement [--solo]` | Implement the finalized task contract. **Default: orchestrator** — spawns one subagent per active behavior, commits (hooks fire), and marks each done when HEAD moves. Pass `--solo` for the in-session TDD loop instead. Valid after `/finalize`; re-run it to resume a halted implementation from the first active behavior. |
| `/explore <instruction>` | Explore the codebase using parallel searches (scout subagents) and get a structured summary. |

## AI Tools

| Tool | Description |
|------|-------------|
| `explore` | Runs parallel codebase searches via scout subagents and returns a synthesized summary with relative file paths. |
| `save_task` | Persists the task contract, validating its shape deterministically, then runs the deterministic **test scan** (see below): per-entry evidence lines with confidence tags plus advisory warnings surface in the tool result. Transitions the workflow to the `finalizing` phase. |
| `mark_task_done` | Marks one behavior done after implementing it. Soft-warns (does not block) when no commit landed since the previous behavior. |
| `complete_implementation` | Finalizes a **solo** implementation: ends the `implementing` phase and returns the workflow to idle. Refuses while any behavior is active — test outcomes are not consulted (the project's hooks own verification). The orchestrator completes on its own and does not call this tool. |

There is no `run_tests` tool and no test-command detection: verification belongs to the project's commit hooks (orchestrator) or the agent's own sandboxed commands (solo).

The orchestrator runs extension code, not the model: it spawns the subagents, so no extra model-facing tools are exposed for that path.

## Workflow

1. **Discuss** — `/discuss <topic>` starts a conversation. The agent asks probing questions, proposes an approach, and iterates on feedback. File edits are blocked.
2. **Finalize** — `/finalize` has the agent draft an atomic task contract (files affected, instruction, definition of done, testable behaviors with expected outputs). Co-location rule: one behavior = test + implementation in the same commit — never split; a behavior whose `expectedOutput` describes only test artifacts is red by construction. `save_task` returns deterministic **scan evidence**; the agent classifies each item (preserved / superseded / obsolete / out-of-scope) and declares superseded/obsolete test paths in `files`. You review the contract in the conversation; run `/implement` to approve.
3. **Implement (orchestrator, default)** — `/implement` runs an extension-code loop over the contract's active behaviors, sequentially:
   - **Spawn** — one subagent per behavior (lean subprocess: `read`/`write`/`edit`/`bash` only, no workflow or commit tools; override with `PI_IMPLEMENTER_TOOLS`). It implements exactly its behavior and returns a report with a suggested conventional commit subject.
   - **Commit** — the orchestrator commits with the suggested conventional subject (no behavior id). Plain `git commit`: the project's pre-commit hooks fire and own verification — the extension never runs test commands itself.
   - **Staged-diff guard** — after `git add --all` and **before** `git commit`, the orchestrator inspects `git diff --cached --name-status` against the contract's `files` (the allowlist) and the test-kind behaviors' `sourceFile`s. Violations — undeclared test deletions, deletions of a test-kind behavior's `sourceFile` (even when declared), skip/only markers added to undeclared test paths, and on fix retries any modification/deletion of undeclared test paths — block the commit: `git commit` is **never invoked**, no fix subagent spawns, no retry budget is consumed, and the loop halts immediately with a `test-guard` outcome. Assertion deltas (HEAD vs staged assertion-line counts) appear in the investigation as context only — they never gate.
   - **HEAD gate** — HEAD before/after classifies the attempt:
     - **HEAD moved** → the commit landed, hooks passed → behavior marked done.
     - **HEAD unchanged + dirty tree** → the hook rejected the commit → a deterministic investigation (exit code, failing lint/format/test stage, `git status`, `diff --stat`, hook output tail) is built and a fix subagent is spawned with it plus the raw hook output.
     - **HEAD unchanged + clean tree** → the unit landed no changes → explicit retry instruction.
     - **Commit timed out** (`PI_COMMIT_TIMEOUT_MS`) → infrastructure failure → halt, no fix subagent.
   - **Retry budget** — 5 retries per behavior (shared across unit errors, hook rejections, no-changes); a further failure halts.
   - **Persisted handoff** — every halt (and any orchestrator crash) persists `lastHalt` — behavior id, error carrying the investigation and hook output, tree state, landed commits, timestamp — into the session log, so failures are diagnosable after the fact.
   Removed behaviors are skipped.
4. **Implement (`--solo`)** — `/implement --solo` steers the in-session agent with a TDD prompt instead: write a failing test → implement → self-check via its own sandboxed commands → `mark_task_done` → (when available) `commit_changes`, which fires the same hooks. When `commit_changes` is registered, the prompt instructs a conventional commit after each behavior; the instruction is omitted entirely when the tool is absent. `mark_task_done` soft-warns if HEAD has not advanced since the previous behavior — it never blocks.

   **Solo asymmetry:** solo mode has no extension-level staged-diff inspection. The tamper rule is **prompt-only** (prompt discipline): the TDD prompt instructs the agent to never delete, skip, or weaken a test to land a commit, and to report instead. The orchestrator's hard guard does not apply on this path — only the project's commit hooks gate.
5. **Complete** — the orchestrator returns the workflow to idle on its own once every behavior is done (each `done` backed by a landed commit whose hooks passed). In solo mode the agent calls `complete_implementation`, which refuses while behaviors are active; test outcomes are not consulted. Completed manual behaviors are listed in the final report under **Manual verification required**.
6. **Resume** — after a halt, re-run `/implement`. Done behaviors are skipped and the loop continues from the first active one; when the working tree is dirty, the resumed unit receives the `git status --short` output as context. The original baseline HEAD is kept.
7. **Commit & push** — push and open a PR with your own git workflow.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_COMMIT_TIMEOUT_MS` | `300000` | Budget for `git commit` — hooks run lint+format+test, which can exceed a minute on cold caches. Exceeding it halts as an infrastructure failure. |
| `PI_IMPLEMENT_TIMEOUT_MS` | `600000` | Per-implementer-unit subprocess budget, independent of the scout timeout (`PI_EXPLORE_TIMEOUT_MS`). |
| `PI_IMPLEMENTER_TOOLS` | `read,write,edit,bash` | Full override of the tool allowlist granted to implementer subprocesses. |

### Files-allowlist contract rule

The contract's `files` field is the guard's allowlist. Declare every test path the contract **updates or removes** there: superseded tests (asserting old behavior the contract changes) and obsolete tests (covering behavior the contract removes). Undeclared test paths are protected — deleting or skipping them halts implementation with a `test-guard` outcome. When implementation surfaces a required test-path change that is not declared, the correct move is `/discuss → /finalize` to amend the contract, not a workaround.

### Red-baseline assumption

The workflow assumes the project's test suite is **green before `/implement` starts**. The extension never runs test commands itself, so a pre-existing failure is invisible until commit time: the project's pre-commit hook rejects **every** behavior's commit regardless of the unit's work.

**Halt signature:** repeated `hook-rejected` outcomes attributed to the test stage across successive behaviors, retries burning to zero each time, with the hook output tail showing the same pre-existing failure. **Resolution:** fix the baseline first, then re-run `/implement` — do not burn the retry budget against a red baseline.

### Contract test scan

`save_task` runs a deterministic, language-agnostic **test scan** after validation: `find` enumerates files (excluding `node_modules`, `.git`, `dist`, `build`, `coverage`, `.venv`, `vendor`), matched test files are read JS-side (size caps, binary sniffing), and four derivation layers — structural path mirroring, boundary-aware import-path matching, exported-symbol extraction (one-level barrels), basename fallback — match test files to each `files` entry using per-language profiles (JS/TS, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP). A pure cross-check then produces evidence lines (`entry -> test [method, confidence]`) and advisory warnings (`undeclared-referencing`, `declared-not-found`, `no-evidence`).

The scan is **advisory, confidence-tagged, and never blocking**: warnings never fail a save, zero-hit entries render `unverified` (never "clean"), and a scan failure degrades to a "scan unavailable" note. The agent classifies the evidence at finalize time; the commit-time guard is the hard enforcement.

### Diagnosing a halt

The last `workflow-state` session entry carries `lastHalt`: the behavior that failed, the error (unit failure, hook investigation with raw hook output, staged-diff guard investigation with name-status lines, or timeout note), `git status --short` at halt time, and the commits landed so far. A `test-guard` halt means the staged diff touched undeclared tests — re-declare via `/discuss → /finalize`, then re-run `/implement` to resume. A red-baseline signature (see above) means fix the suite before resuming.

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
│   ├── implementer-runner.ts # Implementer subprocess runner (spawn errors, stdout tails, named timeouts)
│   ├── finalize.ts           # /finalize command + save_task tool + contract scan wiring
│   ├── task-contract.ts      # Pure contract logic (validation, rendering, completion gate)
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
