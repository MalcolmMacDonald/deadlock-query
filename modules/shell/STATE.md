# shell — state

- **Status:** M1 done
- **Version:** 0.1.0
- **Current milestone:** M1 complete; M2 next (needs real viewer/editor/results modules)
- **Last updated:** 2026-10-06

## Done
- M0: Vite + React 18 + dockview app, two dummy modules via static `src/modules.ts`, versioned localStorage layout persistence (`src/layout.ts`, unit-tested), Reset layout button. `bun run e2e` (Playwright, not in `verify`) drags a panel and checks it survives reload.

- M1: `src/runtime.ts` `composeModules` builds each module Layer in isolation (shared MemoMap, base = contracts mock SelectionBus/ViewerService/DevAuth), merges healthy ones into one `ManagedRuntime`; failed modules' panels render `ErrorPanel`. `src/panels.tsx` mounts React components or `{ mount(container) => dispose }` handles, each in an error boundary. Unit tests + `e2e/isolation.ts` (`?demoFailure` adds a module whose Layer dies).

- 2026-10-06 — Deployed site fix: `src/modules.ts` now mounts the real map-viewer (lazy import, mini-map fixture via `MockMapDataService`) and the query editor (iframe to `./editor/index.html`, the query-builder standalone app, still on `MockQueryEngine`). `tools/build.ts` now runs the shell Vite build and the editor build, so deploy no longer publishes the placeholder page.

## In progress
- (nothing yet)

## Next
- M2 (remaining): swap fixture/mock for published data-25712201 bundle once extractor emits MapBundles; real QueryEngine; wire viewer + query editor + results panels, default Query preset, lazy loading (add real modules to `src/modules.ts`).

## Blockers / Requests to other modules
- map-viewer: confirmed — shell mounts a panel `component` that is `{ mount(container) => dispose }` (see `src/panels.tsx`); React components also work. `viewer.main` can use the handle as-is.
- infra: optionally run `bun run --filter @deadlock-query/shell e2e` in CI (needs Chromium); `tools/build.ts` already picks up `modules/shell/dist` (run `bun run --filter @deadlock-query/shell build` first).

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-06 — M0: e2e is a separate `bun run e2e` script (needs Chromium at `CHROMIUM_PATH` or `/opt/pw-browsers/chromium`), kept out of `verify` so CI does not need browsers; wire into CI later via infra request.
- 2026-10-06 — Vite `base` defaults to `./`; override with `SHELL_BASE` for prod subpath.

- 2026-10-06 — M1: base services use contracts mocks until real layers exist; `MockMapDataService`/`MockQueryEngine` get added to the base in M2 when panels need them.

## Open questions
- (see PLAN.md §9)
