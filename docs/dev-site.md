# Dev site (Cloudflare Pages)

`deploy.yml` builds `--target dev` and publishes `dist/` plus `functions/` to the Cloudflare Pages project `deadlock-query-dev` on every push to `main`. The job is skipped until `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist.

- `functions/_middleware.ts` gates every request on a signed session cookie (HttpOnly, Secure, SameSite=Strict, 12 h). No cookie: HTML requests redirect to `/auth/login`, everything else gets 401 with no assets.
- `functions/auth/login.ts`: PBKDF2-SHA256 check against `DEV_PASSWORD_HASH`, constant-time compare, 5 attempts/minute per IP.
- Login rate limit (5 attempts/min per IP) is stored in a KV namespace bound as `RATE_LIMIT`. Without the binding the limit is off. The Workers Cache API and in-memory counters do not work for this on `pages.dev` (both were tried and never triggered).
- `wrangler.toml` declares the `RATE_LIMIT` KV binding (namespace id is not secret). Bindings added only in the dashboard do not reach deployments made with `wrangler pages deploy`; secrets still come from the dashboard.
- Local run: `wrangler pages dev dist` with `.dev.vars` containing `DEV_PASSWORD_HASH` and `SESSION_HMAC_KEY`.

## One-time setup (Malcolm)
1. Cloudflare account, then Workers & Pages → Create → Pages → Direct Upload, project name `deadlock-query-dev`.
2. API token ("Edit Cloudflare Pages") and account id → GitHub Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
3. `bun tools/hash-password.ts` → Pages project → Settings → Variables and Secrets: `DEV_PASSWORD_HASH` (encrypted).
4. `openssl rand -hex 32` → `SESSION_HMAC_KEY` (encrypted).
5. Workers & Pages → KV → Create namespace `deadlock-query-dev-ratelimit`; then put its id in `wrangler.toml` under `[[kv_namespaces]]` with binding `RATE_LIMIT`.
6. Re-run the deploy workflow.

## GitHub proxy (`/api/github/*`)
Behind the session cookie. Forwards an allowlist of repo-scoped endpoints (issues, comments, labels, PR reads, workflow runs, workflow dispatch, contents read) to `api.github.com/repos/MalcolmMacDonald/deadlock-query`, using the Pages secret `GITHUB_TOKEN_PROXY`. Every request needs header `x-dlq-csrf: 1`; cross-origin `Origin` is rejected; merges, deletes and non-listed paths are refused. Returns 503 until the secret is set. Client side: `DevAuthLive` in `modules/infra/src/devAuth.ts`.
