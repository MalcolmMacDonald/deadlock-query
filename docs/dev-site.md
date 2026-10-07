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
Everything up to the upload runs on the laptop that has the Deadlock install (it needs the game, Source2Viewer, ~4 GB free, `gh auth login` and `bun install`). Nothing here runs in CI except the gate in step 7 and the deploys in step 8. Run from the repo root; on Windows use `\` in the paths. `<id>` is the game build id the extractor prints (the folder name under `data/bundles`).

1. `git checkout main && git pull && bun install`
2. `bun run dlq-extract extract --tier lite --keep-work` writes `data/bundles/<id>/lite`. The first run per game build takes about 8 minutes (Source2Viewer render export, about 3 GB of scratch). Stages are cached, `--keep-work` keeps the full export so a reduction retry needs no new export, and `--force` redoes everything.
3. `bun run dlq-extract tile data/bundles/<id>/lite` compresses the render tiles and writes the LODs. **Every `extract` run rewrites `manifest.json`** (drops LODs, tile hashes and the baked record), so run `tile` and `bake` again after each `extract`, and in this order (`tile`, then `bake`): `tile` rewrites the manifest through the contracts schema, so `bake` goes last and its record is exactly what it wrote.
4. `bun run dlq-extract bake data/bundles/<id>/lite` builds the collision BVH, sample grid and navmesh (from the game's `.nav` when `extract` exported it). It is cached by input hash; add `--force` after changing extractor or semantics code. The navmesh OBJ for a visual check lands in `data/bundles/<id>/lite.qa/navmesh.obj`.
5. Check the result: `bun run dlq-extract inspect data/bundles/<id>/lite`, `bun run dlq-extract pack-lite data/bundles/<id>/lite` (size, no textures) and `cd modules/contracts && bun run check:real -- ../../data/bundles/<id>/lite` (every file against the manifest, sha256 included).
6. `bun run publish-data data/bundles/<id>/lite --upload` refuses a bundle that is untiled, unbaked or whose files differ from the manifest, zips it (without `.work`, `.stage-*` and the raw game `.nav` files, D8), and adds `dl_midtown-<id>-lite-<hash>.zip` to the Release `data-<id>` (created on first use). The asset name carries the hash, so publishing again for the same game build never overwrites the asset the current pointer or a rollback names. It also rewrites `data/current-build.json`. Without `--upload` it only zips and prints the `gh` commands.
7. `git checkout -b data/<id>`, commit `data/current-build.json`, push, open a PR with an `[infra]` title and enable auto-merge. `data.yml` re-downloads the Release and checks hash and budgets; `bun run check:data` does the same locally. Do this only after the upload finished: until the PR merges, `main` still points at the previous asset, which is untouched, so nothing breaks in between.
8. Merging to `main` redeploys the dev site (`deploy.yml`, job `dev`), which downloads the Release into `dist/data/<map>/`. Prod picks it up only when you promote: Actions → deploy → Run workflow with `promote` ticked (see [runbook](runbook.md#promote-to-prod)).

To update later, repeat steps 2 to 8: after a game update there is a new `<id>` and a new Release; after re-extracting or re-baking the same build the Release stays and gets one more asset, and the pointer moves to it. To un-publish, see `docs/takedown.md`; to go back to the previous bundle, see `docs/rollback.md`. Day-to-day operations: `docs/runbook.md`.
