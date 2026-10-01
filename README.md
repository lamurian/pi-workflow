# pi-workflow

A pi extension for a lean **discuss → implement** workflow: discuss a feature with the agent, then implement it with TDD. Committing, pushing, and opening PRs are handled by your own `/commit` extension and git workflows.

## Commands

| Command | Description |
|---------|-------------|
| `/discuss <topic>` | Discuss an issue, bug, chore, or small fix. No files are written; the agent clarifies, proposes an approach, and iterates until you confirm. |
| `/finalize` | Draft the atomic task contract (files, instruction, definition of done, testable behaviors) from the discussion. Valid only after `/discuss`. |
| `/implement` | TDD implementation of the finalized task contract. Valid only after `/finalize`. |
| `/explore <instruction>` | Explore the codebase using parallel searches (scout subagents) and get a structured summary. |

## AI Tools

| Tool | Description |
|------|-------------|
| `explore` | Runs parallel codebase searches via scout subagents and returns a synthesized summary with relative file paths. |
| `save_task` | Persists the task contract, validating its shape deterministically. Transitions the workflow to the `finalized` phase. |
| `run_tests` | Runs the detected test command and records the result. Exit code is the primary pass/fail signal. |
| `mark_task_done` | Marks one behavior done after implementing it and running tests. |
| `back_to_finalize` | Returns to the finalized phase to add a discovered testable surface or remove an out-of-scope behavior. |
| `complete_implementation` | Finalizes an implementation: ends the `implementing` phase and returns the workflow to idle. Refuses while any behavior is active or tests are failing. |

## Workflow

1. **Discuss** — `/discuss <topic>` starts a conversation. The agent asks probing questions, proposes an approach, and iterates on feedback. File edits are blocked.
2. **Finalize** — `/finalize` has the agent draft an atomic task contract (files affected, instruction, definition of done, testable behaviors with expected outputs). You review it in the conversation and steer the tested behaviors; run `/implement` to approve.
3. **Implement** — `/implement` consumes the contract and runs TDD per behavior: write a failing test → implement → `run_tests` → `mark_task_done`. Non-test behaviors are verified against the definition of done.
4. **Complete** — the agent calls `complete_implementation` once all behaviors are done and tests pass, returning to idle.
5. **Commit & push** — use your `/commit` command, then push and open a PR.

### Escaping a gated phase

`discussing` and `finalized` block file edits. There is no reset command; use `/new` to start a fresh session.

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
│   ├── implement.ts          # /implement + run_tests/mark_task_done/back_to_finalize/complete_implementation
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
│   ├── phase-finalized.md    # /finalize review protocol
│   ├── finalize-prompt.md    # Task-contract drafting prompt
│   ├── tdd-prompt.md         # TDD enforcement prompt
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
