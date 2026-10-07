# kanban — state

- **Status:** M0-M2 done against mocks
- **Version:** 0.4.0
- **Current milestone:** M5 (needs the live proxy)
- **Last updated:** 2026-10-07

## Done
- M0: `GitHubApi` service (interface + `MockGitHubApi` fixtures), pure column/lane logic (`src/board.ts`), `Board` panel component (lock screen when `DevAuth` is anonymous, one lane otherwise), standalone harness (`bun run dev:standalone`), unit tests.

- M1: one lane per module (`modules` prop, manifest order), collapse and up/down reorder persisted via an injected `PrefsStore` (localStorage in the harness).

- M2: `createIssue` on `GitHubApi` (mock assigns numbers, backlog), `buildFeatureIssue` validation (module required, exactly one `module:<id>` label, title required), `FeatureFormView` on the board.

- M3: `.github/workflows/claude.yml` (allowlisted actors, exactly one `module:<id>` label, per-module concurrency, prompt limits edits to the module) and `.github/ISSUE_TEMPLATE/feature.yml` (PR #218). M4: covered by the `check:scope` step in `ci.yml`, no separate `scope-check.yml`. M5 UI-side logic (drawer, actions) can still be built on mocks if wanted.

## In progress
- (nothing)

## Next
- Only live-proxy work remains: M5 feedback drawer round-trip, M6 promote/CI/token totals, and the real `GitHubApi` over the dev `/api/github/*` proxy (infra M5 live).
- Malcolm: set the `CLAUDE_CODE_OAUTH_TOKEN` secret and `CLAUDE_ALLOWED_ACTORS` variable so `claude.yml` can run; then run the M3 sandbox-repo acceptance.
- Live path: a `GitHubApi` implementation that calls the dev `/api/github/*` proxy. Blocked on infra M5 live (`GITHUB_TOKEN_PROXY`); going live is a layer swap.

## Blockers / Requests to other modules
- infra M5 live (token secret) for the real GitHub path.
- NEXT.md kanban row is stale (outside module scope): should read "M0 done on mocks; M1/M2 next; live path waits for infra M5".

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-07 — M0 uses an own minimal board instead of the `@malcolmmacdonald/github-kanban` dependency (not verifiable offline, and the module needs per-lane filtering anyway). Revisit if upstream reuse is wanted.
- 2026-10-07 — All GitHub access is behind the `GitHubApi` Effect service so mock and live are swappable.

## Open questions
- (see PLAN.md §9)
