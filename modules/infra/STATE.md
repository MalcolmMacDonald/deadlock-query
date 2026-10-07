# infra — state

- **Status:** M0–M4, M6 done; M5 code done (live needs PAT); M7 done in repo (merge queue ruleset, lockfile bot and prod rollback need Malcolm's settings/secret to go live)
- **Version:** 0.0.0
- **Current milestone:** none (see PLAN.md §6)
- **Last updated:** 2026-10-07

## Done
- M0: root workspace, `new-module`, `verify:all`.
- M1: `check:scope/state/deps` (tools/lib/checks.ts, 6 tests), `ci.yml`, CODEOWNERS for `semantics/**`, claude/* semantics guard.

- 2026-10-07 — `check:deps` accepts a subpath import that the target module's `package.json` `exports` declares (e.g. `@deadlock-query/map-metadata/editor`, which keeps DOM/IndexedDB code out of the module's root entry); anything else under a module stays a deep import. Unit-tested.

## In progress
- Docs from M7 started: `docs/secrets.md`, `docs/takedown.md`; root `NEXT.md` tracks next task per module.
- M2: `deploy.yml` + `tools/build.ts` (placeholder page until `modules/shell/dist` exists). Needs one-time human step: repo Settings → Pages → Source = GitHub Actions.

## M4 (done, live on Cloudflare)
- `functions/_middleware.ts` + `functions/auth/{login,logout,session}.ts`, `modules/infra/src/auth.ts` (PBKDF2, HMAC session; 3 tests), `tools/hash-password.ts`, `wrangler.toml`, `dev` job in `deploy.yml` (skips until Cloudflare secrets exist), `docs/dev-site.md`.
- Verified live 2026-10-05: no cookie gives 302 to login (HTML) or 401 (assets); wrong password 401; right password 303 + cookie then site served.

- Rate limiting: in-memory, Cache API and KV counters all failed to throttle live (KV binding did reach the function after declaring it in wrangler.toml, but counts never advanced). Removed the limiter; now a 1 s delay per failed login plus PBKDF2 and a random 20-char password. Hard limit later via Durable Object or WAF if needed.

## M5 (code done)
- `functions/api/github/[[path]].ts` + `modules/infra/src/proxy.ts`: allowlist of repo-scoped issues/PR/labels/runs/dispatch/contents-read endpoints, CSRF header (`x-dlq-csrf: 1`) required on every request, Origin must match, upstream gets only the token, response headers are whitelisted (no cookies/auth echoed). Session cookie still enforced by `_middleware.ts`. Returns 503 until `GITHUB_TOKEN_PROXY` is set.
- `modules/infra/src/devAuth.ts`: `DevAuthLive` layer over `/auth/session` + `/auth/login`.
- 6 contract tests in `test/proxy.test.ts`. Infra now depends on `contracts` and `effect`.
- Not done: live verification (needs the token secret and a redeploy).

## M6 (done)
- `tools/lib/budget.ts` + budget gate in `tools/build.ts` (tile 20 MB, site 900 MB, initial JS 1.5 MB gz); 5 tests in `test/budget.test.ts`.
- `deploy.yml`: `workflow_dispatch` input `promote`; prod job runs only on promote dispatch (pushes to main update dev only).
- `preview.yml`: same-repo PRs deploy to dev Pages branch `pr-<n>` (now also runs `fetch-data.ts`, so previews get the map bundle instead of the fixture fallback). Needs Preview-environment secrets in Cloudflare (Malcolm), see `docs/dev-site.md`.
- Docs updated in `docs/dev-site.md`.

## M3 (done)
- `data/current-build.json` pins a Release tag plus per-asset sha256 and extract dir; `tools/lib/data.ts` + `tools/fetch-data.ts` download, verify the hash, and unzip into `dist/data/<dest>`; both `deploy.yml` jobs run it after `build`. Currently points at the interim raw bundle `data-25712201` (dl_midtown collision GLB + entities + manifest). Tests in `test/data.test.ts`; verified against the real Release.
- Publishing a new bundle stays manual for now (extractor uploads a Release, then a PR bumps the pointer + hash). A `data.yml` publish workflow is deferred until the extractor emits the `lite` archive (M1).
- To un-publish: delete the Release and the pointer (docs/takedown.md); builds then fail loudly instead of deploying stale data.

## Publish helper (2026-10-06)
- `bun tools/publish-data.ts <bundle-dir> [--upload]` (logic in `tools/lib/publish.ts`, 3 tests): zips a bundle without `.work`/`.stage-*`, refuses oversize bundles (site budget), writes the sha256 into `data/current-build.json` (same tag merges assets by `dest`, new tag replaces), and with `--upload` creates/updates Release `data-<buildId>` via `gh`. Documented in `docs/dev-site.md`. The `data.yml` CI workflow is still deferred. Zipping uses a built-in writer (`tools/lib/zip.ts`, deflate, zip32: files < 2 GB, archive < 4 GB) so no `zip` binary is needed on Windows; tested with `unzip` and a `fetchData` roundtrip. Not run against a real bundle or Release.

## M7 (2026-10-06)
- Docs: `docs/runbook.md` (operations, incidents, one-time setup checklist), `docs/rollback.md`, `docs/dry-run.md` (what was run vs. what needs Malcolm), plus the earlier `secrets.md`/`takedown.md`.
- Merge queue: `.github/rulesets/main.json` (importable ruleset: PR required, `verify` required, merge queue with merge commits, code-owner review, admin bypass) and a `merge_group` trigger on `ci.yml`. Not applied: importing the ruleset is Malcolm's step.
- Lockfile conflicts: `tools/lib/lockfile.ts` + `tools/resolve-lockfile.ts` (takes main's `bun.lock`, `bun install`, stages; refuses if other files conflict; 4 tests on a real temp git repo). `lockfile.yml` runs it for conflicting same-repo PRs after a push to `main`; skipped until secret `LOCKFILE_BOT_TOKEN` exists. Workflow not yet exercised live.
- `data.yml` (no secrets): `tools/check-data.ts` downloads the pointed Release, verifies sha256, unzips, applies budgets; runs on PRs touching the pointer, in the merge queue and on dispatch. Publishing itself stays local (`publish-data.ts --upload`) because the bundle comes from the game install; the plan's "publish" workflow is therefore a verify gate. Verified against the real `data-25738777` Release. `checkPointer` enforces `tag == data-<buildId>`.
- `deploy.yml`: prod `promote` takes an optional `ref` to build an older commit (rollback). Concurrency moved from workflow level (a push to `main` cancelled an in-flight promote) to per-job: prod never cancels, dev cancels superseded runs.
- `ci.yml`: PR title/labels/refs passed through env instead of inline expressions (actionlint script-injection warning).
- Dry run: semantics guard, lockfile resolution, data gate and takedown failure mode run locally; the rest is listed for Malcolm in `docs/dry-run.md`.

- `tools/build.ts` passes `VITE_TARGET=<target>` to the shell build (the request in shell STATE.md M4), so `--target dev` ships dev-only modules and the lock screen and `--target prod` omits them. No dev-only module exists yet, so deployed output is unchanged today.

## Publish flow hardening (2026-10-07)
- Found while writing the publish/update runbook: re-publishing a changed bundle for the same game build used the fixed asset name `<map>-<build>-<tier>.zip` and `gh release upload --clobber`, so the Release asset changed before the pointer PR merged (every dev deploy and preview in between failed with `sha256 mismatch`) and a pointer revert could not roll back (old hash, overwritten asset). Asset names now end in the first 12 hex chars of the zip's sha256 (`assetName(info, sha256)`), so each publish adds an asset and never replaces one.
- `publish-data` now runs `checkBundleReady` (`src/bundleReady.ts`, 4 tests) before zipping: the contracts `checkTiles` + `checkFiles` (every file the manifest names exists with the recorded size and sha256) plus "has baked data with a navmesh" and "tiles have LODs". An `extract` rerun rewrites the manifest (no LODs, no `baked`, stale tile hashes), which this catches before upload.
- The raw game files `collision/walkable.nav` and `walkable.navflowmap` are left out of the published zip (only `bake` reads them; D8 hosts derived data only).
- Root scripts `bun run dlq-extract`, `publish-data`, `check:data` (the docs used `bun run dlq-extract` which did not exist at the root).
- `docs/dev-site.md` has the full extract, tile, bake, check, publish, PR, deploy sequence for first publish and updates; `runbook.md` and `rollback.md` point to it.

## One-command publish (2026-10-07)
- `bun run publish-map` (`tools/publish-map.ts`, planning and PR text in `tools/lib/publishMap.ts`, 5 tests): preflight (game build, on `main`, clean tree, `gh` signed in), `extract`/`tile`/`bake` (skipped when the bundle for the installed build already passes `checkBundleReady`; `--rebuild`/`--force` redo them), `inspect`, `pack-lite`, `check:real`, `publish-data --upload --skip-existing` (new flag: no second upload of an asset the Release already has), then branch `data/<id>-<hash>`, a commit of only the pointer, push and a PR assigned with `@me`. Stops on the first failure naming the step. `--dry-run` stops after the zip and restores the pointer. Reruns reuse an already pushed branch or PR, and say so when `main` already points at the asset.
- Not done: enabling auto-merge on the PR from the script (the sandbox's permission check refused that code in the thread that wrote this; the docs say to enable it by hand or via the merge queue). Not run against the real game or Release: the pure parts are tested, the git/gh orchestration was only exercised for its preflight failures.

- Review-panel proxy writes (2026-10-07): `PUT contents/data/{metadata,submissions}/**`, `PUT pulls/N/merge`, `PATCH pulls/N`; `checkBody` in `proxy.ts` (called from the Pages function) requires a non-default `branch` on contents writes, limits merge fields, and allows only `{"state":"closed"}` on PR patch. Tests in `test/proxy.test.ts`. `GITHUB_TOKEN_PROXY` now needs Pull requests (write) and Contents (write): Malcolm must update the PAT.

## Next
- Malcolm: import the ruleset, enable auto-merge, optional `LOCKFILE_BOT_TOKEN`, run the prod rollback dry run (see `docs/runbook.md` one-time setup).
- Malcolm creates the fine-grained PAT and sets `GITHUB_TOKEN_PROXY` (see `docs/secrets.md`); then curl the live proxy with a session cookie, confirm the token never appears in a response.

## Blockers / Requests to other modules
- (none)

## Decisions log
- 2026-10-06 — Lockfile bot writes with a PAT secret, not `GITHUB_TOKEN`, because pushes by the built-in token do not trigger CI. Merge queue config ships as an importable ruleset file since rulesets cannot be applied from a workflow without an admin token.

- 2026-10-05 — M6: prod deploy is promote-only (was every push to main), per "Promote to Prod" in the plan.

- 2026-10-05 — CI treats a `[infra]` PR title like the `infra` label (label is added after PR creation, so the first CI run raced it).

- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — Decisions accepted: Cloudflare for dev (D9), hosting lite tier publicly (D8), branch `main`; add CODEOWNERS for semantics/ and takedown runbook.

- 2026-10-05 — No per-IP login rate limit: only a 1 s failure delay (see M4 notes).

- 2026-10-07 — Content-addressed asset names inside one `data-<buildId>` Release (not a new tag per publish): `checkPointer` keeps `tag == data-<buildId>` and a takedown still deletes one Release.

## Open questions
- (see PLAN.md §9)

## Data-pointer scope (2026-10-07)
- `check:scope` now passes a PR whose only change is `data/current-build.json` (the pointer PR from `publish-data`) without an `[infra]` title/label. First real pointer PR (#130, branch `UpdateMap`, title "map updated") failed scope with `files outside modules/<id>/`. Test in `test/checks.test.ts`.
