# infra — plan

## 1. Purpose & scope
Everything that keeps the repo healthy and deployable: root workspace config, CI, repo checks that enforce the module rules, prod/dev deployment, the dev password gate + GitHub proxy, and the publishing of map data (Release assets) into the deploy. Split out of `shell` so the UI host is not a bottleneck.

**Non-goals:** no feature UI; no module logic. (kanban owns its own `claude.yml`/`scope-check` *workflow glue*, but the checking logic lives here.)

## 2. Ownership boundary
`modules/infra/**`, `/tools/**`, `/.github/workflows/{ci,deploy,data}.yml`, root `package.json`, `bunfig.toml`, `tsconfig.base.json`, lint/format config, root `CLAUDE.md`, `/docs/adr/`, Cloudflare `functions/` + `wrangler.toml` for the dev site.

## 3. Published surface
- Bun scripts: `verify:all`, `check:scope`, `check:deps`, `check:state`, `new-module <id>`, `build [--target prod|dev]`, `dev`.
- Workflows: `ci.yml` (PR checks), `deploy.yml` (prod → GitHub Pages; dev → Cloudflare Pages; `workflow_dispatch` with `promote`), `data.yml` (publish/refresh bundle Release assets).
- Dev site: Pages Functions `functions/auth/*` (login/logout/session) and `functions/api/github/[[path]].ts` (proxy). Exposes the `DevAuth` service implementation consumed by shell (contract in `contracts`).
- Data convention: GitHub Release `data-<gameBuildId>` containing `lite` bundle archive + manifest hash; `deploy.yml` downloads the release named in `data/current-build.json`.

## 4. Uses
`contracts` (`DevAuth`, `ModuleDefinition` types).

## 5. Technical design
- **Workspaces**: root Bun workspaces `modules/*`; single `bun.lock` (D13). CI job "lockfile-sync" runs `bun install --frozen-lockfile`; a merge-queue/bot step regenerates the lockfile when it conflicts.
- **check:scope**: diff against base → every changed file must be under exactly one `modules/<id>/` (or be `bun.lock`); PR must carry label/title `[<id>]`; `STATE.md` of that module must be touched when code changed (`check:state`). Chore PRs labelled `infra` may touch root files.
- **check:deps**: dependency-cruiser config generated from each `module.json` `dependsOn`; forbids imports of other modules' `src` (only package entry of allowed modules), forbids cycles, forbids web modules importing Node APIs.
- **Build**: `tools/build.ts` orders `contracts → spatial-core → query-library (emit .d.ts, catalog) → others → shell`. `devOnly` modules excluded from prod. Budget gate (tile ≤ 20 MB, site ≤ 900 MB, initial JS ≤ 1.5 MB gz).
- **Deploy prod**: Pages artifact = shell build + downloaded bundle + accepted metadata; base path `/deadlock-query/` (repo name) with hash routing.
- **Deploy dev (D9)**: Cloudflare Pages project from the same build with `--target dev`. Functions: password check against secret `DEV_PASSWORD_HASH` (argon2/PBKDF2) with constant-time compare + login rate limit; session = signed HttpOnly, Secure, SameSite=Strict cookie (HMAC key secret, 12 h); proxy forwards only an allowlist of GitHub endpoints/methods (issues, PRs, comments, labels, workflow dispatch, contents read) using secret `GITHUB_TOKEN` (fine-grained PAT or GitHub App token), strips cookies, adds CSRF header check. Static dev assets are served only with a valid cookie (Pages Functions middleware). Fallback implementation `LocalPatAuth` (GitHub Pages dev; token pasted by user, stored passphrase-encrypted in localStorage) behind the same `DevAuth` interface.
- **Secrets inventory** documented in `docs/secrets.md` (no values): Cloudflare token, `DEV_PASSWORD_HASH`, session HMAC key, GitHub token, `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` (used by kanban's workflow), Turnstile secret (metadata).
- **Branch**: `main` is the default and only trunk (`master` unused). Workflows trigger on `main`.
- **CODEOWNERS**: `modules/spatial-core/src/semantics/** @MalcolmMacDonald` with branch protection requiring code-owner review, so Claude-authored PRs cannot change owner-written semantics without the owner approving. (`check:scope` additionally fails any PR from a `claude/*` branch that touches `semantics/**` bodies.)
- **Takedown runbook** `docs/takedown.md` (D8 mitigation): delete the data Release, remove `data/current-build.json` pointer, redeploy prod and dev, purge Cloudflare/Pages caches; target < 30 min.

## 6. Milestones
| # | Deliverable | Acceptance |
|---|---|---|
| M0 | Root workspace, tsconfig/lint/format, root `CLAUDE.md`, `new-module`, `verify:all` | `bun install && bun run verify:all` green on scaffold |
| M1 | `ci.yml` + `check:scope/state/deps` with tests on synthetic diffs | Two-module diff fails; single-module + lockfile passes |
| M2 | `deploy.yml` prod: hello-world shell on GitHub Pages | Public URL live |
| M3 | Data release flow (`data.yml`, `current-build.json`, download in deploy) | Deploy includes a test bundle from a Release |
| M4 | Dev site on Cloudflare Pages + password/session functions | Wrong password: 401 + no assets; right: assets served; rate limit works |
| M5 | GitHub proxy with allowlist + CSRF; `DevAuth` implementation | Contract tests; token never present in any response/body |
| M6 | Build budgets, `promote` dispatch, PR preview deploys (dev) | Over-budget build fails with clear message |
| M7 | Docs: secrets, runbook, rollback, takedown; lockfile conflict bot/merge-queue config; CODEOWNERS + `semantics/**` guard | Documented dry run; test PR touching `semantics/**` from a `claude/*` branch fails |

## 7. Test strategy
Unit tests on check scripts with synthetic git diffs; Functions tested with `wrangler`/miniflare; `actionlint` on workflows.

## 8. Standalone mode
`bun run tools/check-scope --base HEAD~1` locally; `wrangler pages dev` for the dev site with `.dev.vars`.

## 9. Risks & open questions
- Cloudflare account/dependency for dev + metadata Worker — accepted (D9, D11); someone must create the account/project and provide secrets.
- Lockfile merge conflicts with simultaneous module PRs (D13) — merge queue + regenerate.
- A public repo + Claude action: keep issue-triggering restricted (see kanban).
- Pages 1 GB limit vs. bundle size.

## 10. Definition of done
Fresh clone → one command builds both targets; CI enforces module rules; prod and dev deploy automatically; dev site is inaccessible without the password and the GitHub token never reaches the browser; runbook exists.
