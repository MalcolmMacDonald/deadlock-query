# Dev site (Cloudflare Pages)

`deploy.yml` builds `--target dev` and publishes `dist/` plus `functions/` to the Cloudflare Pages project `deadlock-query-dev` on every push to `main`. The job is skipped until `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist.

- `functions/_middleware.ts` gates every request on a signed session cookie (HttpOnly, Secure, SameSite=Strict, 12 h). No cookie: HTML requests redirect to `/auth/login`, everything else gets 401 with no assets.
- `functions/auth/login.ts`: PBKDF2-SHA256 check against `DEV_PASSWORD_HASH`, constant-time compare (see the next bullet for brute-force protection).
- Brute-force protection: PBKDF2 hashing, a 1 s delay on every failed attempt, and a random 20-character password. A per-IP counter was tried and removed: in-memory counters, the Cache API (no-op on `pages.dev`) and KV (eventually consistent, so the counter never advanced) all failed to throttle. If a hard limit is ever needed, use a Durable Object (needs a separate Worker) or a WAF rule on a custom domain.
- Local run: `wrangler pages dev dist` with `.dev.vars` containing `DEV_PASSWORD_HASH` and `SESSION_HMAC_KEY`.

## One-time setup (Malcolm)
1. Cloudflare account, then Workers & Pages → Create → Pages → Direct Upload, project name `deadlock-query-dev`.
2. API token ("Edit Cloudflare Pages") and account id → GitHub Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
3. `bun tools/hash-password.ts` → Pages project → Settings → Variables and Secrets: `DEV_PASSWORD_HASH` (encrypted).
4. `openssl rand -hex 32` → `SESSION_HMAC_KEY` (encrypted).
5. Re-run the deploy workflow.

## GitHub proxy (`/api/github/*`)
Behind the session cookie. Forwards an allowlist of repo-scoped endpoints (issues, comments, labels, PR reads, workflow runs, workflow dispatch, contents read) to `api.github.com/repos/MalcolmMacDonald/deadlock-query`, using the Pages secret `GITHUB_TOKEN_PROXY`. Every request needs header `x-dlq-csrf: 1`; cross-origin `Origin` is rejected; merges, deletes and non-listed paths are refused. Returns 503 until the secret is set. Client side: `DevAuthLive` in `modules/infra/src/devAuth.ts`.

## Budgets, promote, previews
- `bun tools/build.ts` fails the build when the output exceeds a budget: tile ≤ 20 MB (any file under a `tiles/` dir), site ≤ 900 MB, first-load JS ≤ 1.5 MB gzipped (scripts and modulepreloads referenced by `index.html`). Limits live in `tools/lib/budget.ts`.
- **Promote to prod:** Actions → deploy → Run workflow with `promote` ticked. Pushes to `main` only update dev; prod (GitHub Pages) moves only on promote.
- **PR previews:** `preview.yml` deploys same-repo PRs to the dev Pages project on branch `pr-<number>` (`https://pr-<n>.deadlock-query-dev.pages.dev`, behind the same login). Pages preview deployments read *Preview* environment variables, so set `DEV_PASSWORD_HASH`, `SESSION_HMAC_KEY` (and later `GITHUB_TOKEN_PROXY`) under Settings → Variables and Secrets → Preview as well, or previews will not serve. Skipped until the Cloudflare secrets exist.

## Publishing a new map bundle
1. Extract locally: `bun run dlq-extract extract --tier lite` (output: `data/bundles/<buildId>/lite`; the `full` tier is over the site budget and is refused).
2. `bun tools/publish-data.ts data/bundles/<buildId>/lite --upload` (needs `gh auth login`). It zips the bundle, uploads Release `data-<buildId>`, and rewrites `data/current-build.json` with the new sha256. Without `--upload` it only zips and prints the `gh` commands.
3. Commit `data/current-build.json` on a branch and open a PR with an `[infra]` title prefix. `data.yml` re-downloads the Release and checks the hash and budgets (`bun tools/check-data.ts` does the same locally). Merging to `main` redeploys the dev site, which downloads the Release into `dist/data/<map>/`.
4. To un-publish, see `docs/takedown.md`; to go back to the previous bundle, see `docs/rollback.md`. Day-to-day operations: `docs/runbook.md`.
