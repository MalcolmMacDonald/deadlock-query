# Dev site (Cloudflare Pages)

`deploy.yml` builds `--target dev` and publishes `dist/` plus `functions/` to the Cloudflare Pages project `deadlock-query-dev` on every push to `main`. The job is skipped until `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist.

- `functions/_middleware.ts` gates every request on a signed session cookie (HttpOnly, Secure, SameSite=Strict, 12 h). No cookie: HTML requests redirect to `/auth/login`, everything else gets 401 with no assets.
- `functions/auth/login.ts`: PBKDF2-SHA256 check against `DEV_PASSWORD_HASH`, constant-time compare, 5 attempts/minute per IP.
- Login rate limit (5 attempts/min per IP) is stored in a KV namespace bound as `RATE_LIMIT`. Without the binding the limit is off. The Workers Cache API and in-memory counters do not work for this on `pages.dev` (both were tried and never triggered).
- There is deliberately no `wrangler.toml`: when one exists, `wrangler pages deploy` treats it as the source of truth and ignores dashboard bindings (the `RATE_LIMIT` KV binding never reached the function). Bindings and secrets are managed in the dashboard.
- Local run: `wrangler pages dev dist` with `.dev.vars` containing `DEV_PASSWORD_HASH` and `SESSION_HMAC_KEY`.

## One-time setup (Malcolm)
1. Cloudflare account, then Workers & Pages → Create → Pages → Direct Upload, project name `deadlock-query-dev`.
2. API token ("Edit Cloudflare Pages") and account id → GitHub Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
3. `bun tools/hash-password.ts` → Pages project → Settings → Variables and Secrets: `DEV_PASSWORD_HASH` (encrypted).
4. `openssl rand -hex 32` → `SESSION_HMAC_KEY` (encrypted).
5. Workers & Pages → KV → Create namespace `deadlock-query-dev-ratelimit`; then Pages project → Settings → Bindings → Add → KV namespace, variable name `RATE_LIMIT` (Production).
6. Re-run the deploy workflow.
