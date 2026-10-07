# kanban — state

- **Status:** M0, M1 done against mocks
- **Version:** 0.2.0
- **Current milestone:** M2 (creation form + issue template)
- **Last updated:** 2026-10-07

## Done
- M0: `GitHubApi` service (interface + `MockGitHubApi` fixtures), pure column/lane logic (`src/board.ts`), `Board` panel component (lock screen when `DevAuth` is anonymous, one lane otherwise), standalone harness (`bun run dev:standalone`), unit tests.

- M1: one lane per module (`modules` prop, manifest order), collapse and up/down reorder persisted via an injected `PrefsStore` (localStorage in the harness).

## In progress
- (nothing)

## Next
- M2 (creation form, mock). The shell should pass module ids from `module.json` files; the harness uses a fixed list. M3/M4 are workflow files; M5+ need the live proxy.
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
