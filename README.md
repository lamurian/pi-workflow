# Modular Workflow

A pi extension for guided brainstorming and TDD implementation with phase-gated conversational protocols.

## Commands

| Command | Description |
|---------|-------------|
| `/brainstorm <topic>` | Start requirements elicitation. Discuss feature, propose approach, write ADR. |
| `/brainstorm @docs/ADR/<file>` | Transition to specifying phase. Read ADR, propose components, write spec. |
| `/brainstorm @docs/specs/<file>` | Transition to planning phase. Read spec, propose tasks, write plan. |
| `/implement @docs/plans/<file>` | TDD implementation from plan. Resolves cross-references to spec and ADR. |
| `/adr [list\|show\|new]` | Manage Architecture Decision Records. |
| `/status` | Show current workflow phase, artifacts, and ARCHITECTURE.md status. |

## Workflow Phases

The phase is determined by the `@file` reference in `/brainstorm`:

| Phase | Trigger | Protocol | Artifact |
|-------|---------|----------|----------|
| **requirements** | `/brainstorm <topic>` | Elicit user story → propose approach → loop feedback → ADR | `docs/ADR/001-slug.md` |
| **specifying** | `/brainstorm @docs/ADR/xxx.md` | Read ADR → propose components → relate to business value → loop → spec | `docs/specs/002-slug.md` |
| **planning** | `/brainstorm @docs/specs/xxx.md` | Read spec+ADR → propose tasks → loop → plan | `docs/plans/003-slug.md` |
| **implementing** | `/implement @docs/plans/xxx.md` | Resolve cross-refs → TDD | Code |

Each phase has a **deterministic protocol** (the step sequence) with **indeterministic execution** (freeform conversation within each step). The LLM loops on propose/adjust until the user explicitly confirms, then creates the artifact.

### Cross-Reference Chain

```
plan.md ──@──→ spec.md ──@──→ adr.md
  │                        │
  └── /implement reads all ──→ full context
```

Documents reference each other via `@path/to/file.md` (relative to project root). The cross-reference resolver recursively resolves these, with cycle detection.

## File Naming

All documents follow a uniform naming convention:

```
{NUMBER}-{short-slug}.md
```

- `NUMBER`: 3-digit zero-padded sequential number (001, 002, ...)
- `short-slug`: ≤20 characters, sluggified from the title

Examples:
- `docs/ADR/001-jwt-auth.md`
- `docs/specs/002-auth-flow.md`
- `docs/plans/003-implement-auth.md`

## Configuration (`workflow.json`)

Workflow behavior is configurable via a JSON file with three merge levels
(defaults ← global ← project-local):

| Level | Path |
|-------|------|
| Defaults | Hardcoded in `src/paths.ts` |
| Global | `~/.pi/agent/workflow.json` |
| Project | `<cwd>/.pi/workflow.json` |

### Schema

```json
{
  "brainstorm": {
    "skipQuestionnaire": false,
    "skipTopics": []
  },
  "implement": {
    "enforceTdd": true,
    "testCommand": "npm run test:ci"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `brainstorm.skipQuestionnaire` | boolean | `false` | Skip the questionnaire about pre-commit, pre-push, and env management (requirements phase only). |
| `brainstorm.skipTopics` | string[] | `[]` | Granular topic skipping when `skipQuestionnaire` is `false`. Values: `"pre-commit"`, `"pre-push"`, `"env-management"`. |
| `implement.enforceTdd` | boolean | `true` | Require test-first development during implementation. |
| `implement.testCommand` | string | auto-detected | Override the test command (e.g. `"npm run test:ci"`). |

## Skills

Installed skills:
- `adr` — ADR format and conventions
- `pre-commit-hook` — pre-commit setup patterns
- `pre-push-hook` — pre-push setup patterns
- `env-management` — environment management patterns

## Compaction

The extension preserves the agreed specification during context compaction.
The spec is included in compaction summaries under Key Decisions and Next Steps.

## File Structure

```
modular-workflow/
├── package.json              # pi package manifest
├── content/                  # Phase protocol prompts and templates
│   ├── adr-template.md       # ADR template with {{placeholder}} variables
│   ├── spec-template.md      # Spec template with {{placeholder}} variables
│   ├── plan-template.md      # Plan template with {{placeholder}} variables
│   ├── architecture-template.md  # ARCHITECTURE.md skeleton template
│   ├── phase-requirements.md
│   ├── phase-specifying.md
│   ├── phase-planning.md
│   ├── tdd-prompt.md
│   └── report-template.md
├── skills/                   # Reference skills
│   ├── adr/SKILL.md          # Documents output formats; notes content/ files as source
│   ├── pre-commit-hook/SKILL.md
│   ├── pre-push-hook/SKILL.md
│   └── env-management/SKILL.md
└── src/
    ├── index.ts          # Entry point — wires commands and events
    ├── state.ts          # State machine and persistence
    ├── brainstorm.ts     # Phase detection + orchestration
    ├── implement.ts      # TDD implementation orchestrator
    ├── adr.ts            # ADR create/read/update
    ├── spec.ts           # Spec create/list/archive
    ├── plan.ts           # Plan create/list/archive/tasks
    ├── cross-ref.ts      # @path reference resolver (recursive)
    ├── architecture.ts   # ARCHITECTURE.md read/write
    ├── commands.ts       # /adr /spec /plan command handlers
    ├── adr-detect.ts     # ADR directory auto-detection
    ├── autocomplete.ts   # @ file reference autocomplete
    ├── compaction.ts     # Compaction spec preservation
    ├── detect-hooks.ts   # Pre-commit/pre-push detection
    ├── paths.ts          # Config loading (directories.json, workflow.json)
    └── utils.ts          # Shared utilities (shortSlug, detectDocType, etc.)
```

## Development

```bash
cd ~/.pi/agent/extensions
git clone <repo-url>
cd modular-workflow
npm install
```

pi auto-discovers the extension from `extensions/modular-workflow/src/index.ts`.

## Publishing

```bash
# Tag and push
git tag v0.1.0
git push origin v0.1.0

# Users install with:
pi install git:github.com/user/modular-workflow
```
