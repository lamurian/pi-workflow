---
name: pre-commit-hook
description: Pre-commit hook setup patterns and framework options.
---

# Pre-commit Hook

## Frameworks

| Framework | Language | Config File | Notes |
|-----------|----------|-------------|-------|
| husky | JavaScript/Node | `.husky/` | Most popular for Node projects. Uses `.husky/pre-commit` |
| lefthook | Any (git-native) | `lefthook.yml` | Fast, supports parallel execution |
| pre-commit | Python (multi-lang) | `.pre-commit-config.yaml` | Language-agnostic, popular in Python ecosystem |

## Common Hooks

- lint-staged: run linters on staged files
- tsc --noEmit: type checking
- prettier --check: formatting validation
- eslint: linting
- Unit tests for changed files

## Configuration

Husky example:
```bash
npx husky init
echo "npx lint-staged" > .husky/pre-commit
```
