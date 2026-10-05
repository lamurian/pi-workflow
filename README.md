# pi-workflow

A pi extension for a lean **discuss → finalize → implement** workflow. Discussion and contract-drafting are gated (read-only); implementation defaults to an orchestrator that runs one subagent per contract behavior.

Committing is decoupled from this extension. When a `commit_changes` tool is registered (e.g. your own `/commit` extension), the orchestrator commits each completed behavior with a conventional subject, and the solo TDD prompt tells the agent to commit per behavior. When no such tool is present, the workflow runs without any commit step.

## Commands

| Command | Description |
|---------|-------------|
| `/discuss <topic>` | Discuss an issue, bug, chore, or small fix. No files are written; the agent clarifies, proposes an approach, and iterates until you confirm. |
| `/finalize` | Draft the atomic task contract (files, instruction, definition of done, testable behaviors) from the discussion. Valid only after `/discuss`. |
| `/implement [--solo]` | Implement the finalized task contract. **Default: orchestrator** — spawns one subagent per active behavior, then verifies, commits, and marks each done. Pass `--solo` for the in-session TDD loop instead. Valid after `/finalize`; re-run it to resume a halted implementation from the first active behavior. |
| `/explore <instruction>` | Explore the codebase using parallel searches (scout subagents) and get a structured summary. |

## AI Tools

| Tool | Description |
|------|-------------|
| `explore` | Runs parallel codebase searches via scout subagents and returns a synthesized summary with relative file paths. |
| `save_task` | Persists the task contract, validating its shape deterministically. Transitions the workflow to the `finalizing` phase. |
| `run_tests` | Runs the detected test command and records the result. Exit code is the primary pass/fail signal. |
| `mark_task_done` | Marks one behavior done after implementing it and running tests. Soft-warns (does not block) when no commit landed since the previous behavior. |
| `complete_implementation` | Finalizes a **solo** implementation: ends the `implementing` phase and returns the workflow to idle. Refuses while any behavior is active or tests are failing. The orchestrator completes on its own and does not call this tool. |

The orchestrator runs extension code, not the model: it spawns the subagents, so no extra model-facing tools are exposed for that path.

## Workflow

1. **Discuss** — `/discuss <topic>` starts a conversation. The agent asks probing questions, proposes an approach, and iterates on feedback. File edits are blocked.
2. **Finalize** — `/finalize` has the agent draft an atomic task contract (files affected, instruction, definition of done, testable behaviors with expected outputs). You review it in the conversation and steer the tested behaviors; run `/implement` to approve.
3. **Implement (orchestrator, default)** — `/implement` runs an extension-code loop over the contract's active behaviors, sequentially:
   - **Spawn** — one subagent per behavior (lean subprocess: `write`/`edit`/`bash` only, no workflow or commit tools). It implements exactly its behavior and returns a report with a suggested conventional commit subject.
   - **Verify** — the orchestrator runs the test command itself and parses the result; it does not trust the subagent's claim.
   - **Commit** — on green, it commits with the subagent's suggested conventional subject (no behavior id in the subject).
   - **Mark** — it records the behavior done and advances the widget.
   Removed behaviors are skipped. Each unit gets **one retry** with the failure output appended to its task text; a second failure halts the loop and reports the unit id, error, tree state, and commits landed so far.
4. **Implement (`--solo`)** — `/implement --solo` steers the in-session agent with a TDD prompt instead: write a failing test → implement → `run_tests` → `mark_task_done` → (when available) `commit_changes`. When `commit_changes` is registered, the prompt instructs a conventional commit after each behavior; the instruction is omitted entirely when the tool is absent. `mark_task_done` soft-warns if HEAD has not advanced since the previous behavior — it never blocks.
5. **Complete** — the orchestrator returns the workflow to idle on its own once every behavior is done and tests pass. In solo mode the agent calls `complete_implementation`, which refuses while behaviors are active or tests fail. Completed manual behaviors are listed in the final report under **Manual verification required**.
6. **Resume** — after a halt, re-run `/implement`. Done behaviors are skipped and the loop continues from the first active one; the original baseline HEAD is kept.
7. **Commit & push** — push and open a PR with your own git workflow.

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
│   ├── implement.ts          # /implement entry + run_tests/mark_task_done/complete_implementation + report
│   ├── implement-loop.ts     # Orchestrator loop (spawn → verify → commit → mark, retry, halt, resume)
│   ├── implementer-runner.ts # Implementer subprocess runner + argv builder + report parser
│   ├── finalize.ts           # /finalize command + save_task tool
│   ├── task-contract.ts      # Pure contract logic (validation, rendering, parsing, gate)
│   ├── explore.ts            # /explore command + explore tool
│   ├── explore-core.ts       # Parallel exploration engine
│   ├── subagent-runner.ts    # Scout subagent spawning
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
