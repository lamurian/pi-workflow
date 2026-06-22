---
name: env-management
description: Environment variable management patterns and tooling.
---

# Environment Management

## Patterns

| Approach | Tool | Use Case |
|----------|------|----------|
| .env files | dotenv | Local development defaults |
| Secret injection | 1password CLI / Doppler / Vault | Production secrets |
| Environment switching | direnv | Per-directory env vars |
| Validation | envalid / zod | Runtime config validation |

## Best Practices

1. Keep a `.env.example` file checked into version control with all required keys (no real values).
2. Add `.env` to `.gitignore`.
3. Validate environment variables at startup with a library like `envalid` or `zod`.
4. Use a single source of truth for env var names (e.g., a shared schema).
5. Document each env var's purpose, type, and default in the ADR.

## Example `.env.example`

```bash
# Database
DATABASE_URL=postgres://user:pass@localhost:5432/db
# Authentication
AUTH_SECRET=  # generate via `openssl rand -base64 32`
# API
API_PORT=3000
```
