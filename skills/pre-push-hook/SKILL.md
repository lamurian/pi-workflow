---
name: pre-push-hook
description: Pre-push hook patterns for CI gating and validation.
---

# Pre-push Hook

## Purpose

Validate code before pushing to remote. Catches issues that pre-commit hooks might miss.

## Common Validations

- Integration tests (slower than unit tests, run on push)
- Build verification (ensures the project compiles)
- Secrets scanning (prevent accidental credential leaks)
- Bundle size checks
- Linting with different rules (e.g., stricter rules for CI)

## Configuration

Husky example:
```bash
echo "npm run build && npm test" > .husky/pre-push
```

Lefthook example (`lefthook.yml`):
```yaml
pre-push:
  commands:
    build:
      run: npm run build
    test:
      run: npm test
```
