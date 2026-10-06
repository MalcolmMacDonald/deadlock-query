# shell — state

- **Status:** M0 done
- **Version:** 0.0.0
- **Current milestone:** M0 complete; M1 next
- **Last updated:** 2026-10-06

## Done
- M0: Vite + React 18 + dockview app, two dummy modules via static `src/modules.ts`, versioned localStorage layout persistence (`src/layout.ts`, unit-tested), Reset layout button. `bun run e2e` (Playwright, not in `verify`) drags a panel and checks it survives reload.

## In progress
- (nothing yet)

## Next
- M1: Layer composition (`ManagedRuntime`), per-module error panels, mock services from contracts.

## Blockers / Requests to other modules
- infra: optionally run `bun run --filter @deadlock-query/shell e2e` in CI (needs Chromium); `tools/build.ts` already picks up `modules/shell/dist` (run `bun run --filter @deadlock-query/shell build` first).

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-06 — M0: e2e is a separate `bun run e2e` script (needs Chromium at `CHROMIUM_PATH` or `/opt/pw-browsers/chromium`), kept out of `verify` so CI does not need browsers; wire into CI later via infra request.
- 2026-10-06 — Vite `base` defaults to `./`; override with `SHELL_BASE` for prod subpath.

## Open questions
- (see PLAN.md §9)
