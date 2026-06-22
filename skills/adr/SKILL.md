---
name: adr
description: Architecture Decision Record format and conventions. Use when creating or reviewing ADRs.
---

# ADR (Architecture Decision Record)

This project uses a MADR-inspired format for Architecture Decision Records.

## Location

ADRs are stored in `docs/ADR/` with the naming convention `YYYYMMDD-title.md`.

## Templates

These are the **output formats** that ADR, spec, and plan files must follow.
The extension code renders them from template files in `content/` with `{{placeholder}}`
substitution — but the resulting documents must match these schemas exactly.

### ADR Template

```markdown
---
title: Title Matching Filename (<5 words)
description: One sentence summarizing the decision
status: proposed
date: YYYY-MM-DD
---

# Context

Problem statement or user story. What options were considered?

# Decision

Chosen approach and rationale. Why this over the alternatives?

# Impact

Trade-offs, costs, benefits. What becomes easier or harder because of this decision?
```

Rendered from `content/adr-template.md` with `{{title}}`, `{{description}}`, `{{status}}`, `{{date}}`, `{{context}}`, `{{decision}}`, `{{impact}}`.

### Spec Template

```markdown
---
title: Spec Title (<5 words)
description: One sentence summarizing the plan
date: YYYY-MM-DD
---

# Requirements Specification

- Bullet points on functional and non-functional requirements

# Design Principles

- Bullet points on system architecture, data models, API and interface definitions

# References

- @path/to/adr.md
```

Rendered from `content/spec-template.md` with `{{title}}`, `{{description}}`, `{{date}}`, `{{content}}`.

### Plan Template

```markdown
---
title: Plan Title (<5 words)
description: One sentence summarizing the plan
date: YYYY-MM-DD
---

# Overview

What does this plan cover? Brief context and motivation.

# Goals

- Goal 1: measurable outcome
- Goal 2: measurable outcome
- Goal 3: measurable outcome

# Implementation Steps

- [ ] Step 1: description
- [ ] Step 2: description
- [ ] Step 3: description

# Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Risk 1 | High/Med/Low | High/Med/Low | Mitigation strategy |
| Risk 2 | High/Med/Low | High/Med/Low | Mitigation strategy |

# UAT

1. Step to guide user testing
2. Described until completion

# References

- @path/to/spec.md
```

Rendered from `content/plan-template.md` with `{{title}}`, `{{description}}`, `{{date}}`, `{{content}}`.

## Workflow

1. Create ADR during brainstorming (`/brainstorm`)
2. Reference ADR during implementation (`/implement`)
3. Update status when decision is implemented or superseded
