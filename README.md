# pi-workflow

A pi extension for a lean **discuss → implement** workflow: discuss a feature with the agent, then implement it with TDD. Committing, pushing, and opening PRs are handled by your own `/commit` extension and git workflows.

## Commands

| Command | Description |
|---------|-------------|
| `/discuss <topic>` | Discuss an issue, bug, chore, or small fix. No files are written; the agent clarifies, proposes an approach, and iterates until you confirm. |
| `/implement` | TDD implementation. Resolves the spec from: `@<file>` refs → plain file path → free-form topic → latest assistant message / discussion topic. |
| `/yolo` | Snap back to the default pi session from any phase. Resets all workflow state. |
| `/explore <instruction>` | Explore the codebase using parallel searches (scout subagents) and get a structured summary. |

## AI Tools

| Tool | Description |
|------|-------------|
| `explore` | Runs parallel codebase searches via scout subagents and returns a synthesized summary with relative file paths. |
| `complete_implementation` | Finalizes an implementation: ends the `implementing` phase and returns the workflow to idle. Call only after all tasks are done and tests pass. |

## Workflow

1. **Discuss** — `/discuss <topic>` starts a conversation. The agent asks probing questions, proposes an approach, and iterates on feedback. File edits are blocked during discussion.
2. **Implement** — `/implement` picks up the finalized plan (from the latest assistant message or discussion topic) and runs TDD: write a failing test → implement → run tests → repeat.
3. **Finalize** — the agent calls `complete_implementation` once all tasks are done and tests pass, returning to idle.
4. **Commit & push** — use your `/commit` command, then push and open a PR.

## Skills

Installed skills:
- `pre-commit-hook` — pre-commit setup patterns
- `pre-push-hook` — pre-push setup patterns
- `env-management` — environment management patterns

## Compaction

The extension preserves the agreed specification during context compaction. The spec is included in compaction summaries under Specification and Next Steps.

## File Structure

```
pi-workflow/
├── package.json              # pi package manifest
├── extensions/               # Extension source
│   ├── index.ts              # Entry point — wires commands, events, tool gates
│   ├── prompt.ts             # buildPhasePrompt (discussing phase protocol)
│   ├── state.ts              # Phase state machine and persistence
│   ├── discuss.ts            # /discuss orchestration
│   ├── implement.ts          # TDD implementation + complete_implementation tool
│   ├── explore.ts            # /explore command + explore tool
│   ├── explore-core.ts       # Parallel exploration engine
│   ├── subagent-runner.ts    # Scout subagent spawning
│   ├── yolo.ts               # /yolo state reset
│   ├── autocomplete.ts       # @ file reference autocomplete
│   ├── compaction.ts         # Compaction spec preservation
│   ├── paths.ts              # workflow.json config loading
│   └── utils.ts              # Shared utilities (loadContent, parseArgs, shortSlug)
├── content/                  # Protocol prompts
│   ├── phase-discussing.md   # /discuss protocol
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
