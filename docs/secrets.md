# Secrets inventory (names only, never values)

| Secret | Where set | Used by | How to create |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secrets | `deploy.yml` dev job | Cloudflare dashboard → My Profile → API Tokens → "Edit Cloudflare Pages" template |
| `DEV_PASSWORD_HASH` | Cloudflare Pages env (encrypted) | `functions/auth/*` | `bun tools/hash-password.ts` (added in infra M4); paste the output |
| `SESSION_HMAC_KEY` | Cloudflare Pages env | session cookie signing | `openssl rand -hex 32` |
| `GITHUB_TOKEN_PROXY` | Cloudflare Pages env | `/api/github/*` proxy | Fine-grained PAT on this repo: Issues, Pull requests, Contents (read), Actions (write), Metadata |
| `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) | GitHub Actions secrets | kanban's `claude.yml` | `claude setup-token` locally, or Anthropic Console |
| `TURNSTILE_SECRET` | Cloudflare Worker env | map-metadata submissions (Phase 3) | Cloudflare → Turnstile |

The GitHub token exists only in Cloudflare; it must never appear in a browser response.
