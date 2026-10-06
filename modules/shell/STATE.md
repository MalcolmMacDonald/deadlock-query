# shell — state

- **Status:** M2 mostly done (viewer + embedded query editor wired to the shared viewer/selection; rows overlay and highlight on the map)
- **Version:** 0.1.0
- **Current milestone:** M1 complete; M2 next (needs real viewer/editor/results modules)
- **Last updated:** 2026-10-06

## Done
- M0: Vite + React 18 + dockview app, two dummy modules via static `src/modules.ts`, versioned localStorage layout persistence (`src/layout.ts`, unit-tested), Reset layout button. `bun run e2e` (Playwright, not in `verify`) drags a panel and checks it survives reload.

- M1: `src/runtime.ts` `composeModules` builds each module Layer in isolation (shared MemoMap, base = contracts mock SelectionBus/ViewerService/DevAuth), merges healthy ones into one `ManagedRuntime`; failed modules' panels render `ErrorPanel`. `src/panels.tsx` mounts React components or `{ mount(container) => dispose }` handles, each in an error boundary. Unit tests + `e2e/isolation.ts` (`?demoFailure` adds a module whose Layer dies).

- 2026-10-06 — Deployed site fix: `src/modules.ts` now mounts the real map-viewer (lazy import, mini-map fixture via `MockMapDataService`) and the query editor (iframe to `./editor/index.html`, the query-builder standalone app, still on `MockQueryEngine`). `tools/build.ts` now runs the shell Vite build and the editor build, so deploy no longer publishes the placeholder page.

- 2026-10-06 — M2 (viewer): one shared `ViewerController` (`src/viewer.ts`, lazy) backs both the Map panel and `ViewerService` via `appBaseLayer` (`src/runtime.ts`), replacing `MockViewerService` in the app; falls back to the mock if the viewer chunk fails to load. Unit-tested.

- 2026-10-06 — Map panel loads the published bundle (`./data/dl_midtown/manifest.json`, unzipped by `tools/fetch-data.ts` at deploy) via `ViewerController.loadBundle`, falling back to the fixture if absent. Note: the lite bundle has `tiles: []` (collision GLB only), so only entities render until the viewer draws collision/tiles.

- 2026-10-06 — M2 (layout): default "Query" preset (`src/presets.ts`: viewer left, editor docked right at 520 px, extras below) replaces the ad-hoc default placement; the editor iframe mounts lazily on first visibility (`src/LazyPanel.tsx`). New `e2e/slice.ts` builds the site (shell + editor + library) and checks: map canvas renders, a query runs in the editor panel, rows appear. Repaired stale `e2e/layout.ts` / `e2e/isolation.ts` (they still referenced the removed dummy Alpha/Beta panels); `bun run e2e` passes all three.

- 2026-10-06 — M2 (viewer panels): `viewer.tools` and `viewer.layers` (map-viewer M3) mounted from `src/viewer.ts` over the shared `ViewerController`; default "Query" preset docks Tools left of the map (220 px) with Layers below it. `LAYOUT_VERSION` bumped to 2 so saved layouts without the new panels reset once. New `e2e/panels.ts` (in `bun run e2e`) checks both panels sit left of the map and a point drawn with the tool shows up in the layers list.

- 2026-10-06 — M2 (editor ↔ viewer): the iframe `editor/` panel is replaced by query-builder's `makeQueryEditorPanel` (`src/editor.tsx`), mounted in-page (Monaco lazy via dynamic import, only once the panel is visible). The module's Layer captures the runtime's shared `ViewerService` / `SelectionBus` values and hands them to the panel, so a run sets the `query-result` overlay on the real map (listed in the Layers panel) and a row click highlights its features. The panel's bundle is the published `./data/dl_midtown` entities when present, else the mini-map fixture (same choice as the Map panel). Monaco's two workers are bundled by Vite (`src/monacoWorkers.ts`, `?worker&url`, `worker.format: "es"`) and served from the site's assets; `monaco-editor` is now a shell dependency for that. The library artifact is still read from `./editor/library.json`, which `tools/build.ts` keeps shipping from the standalone editor build. `e2e/slice.ts` now runs a query in the embedded editor and asserts the overlay layer and the viewer highlight (via a `__viewerController` window hook, like `__dockview`). `bun run e2e` passes all four scripts.

## In progress
- (nothing yet)

## Next
- M2 (remaining): swap the fixture for the published MapBundle once the extractor emits a real one; selection sync with a results panel (the editor panel carries its own table).
- Infra follow-up: ship `library.json` without the standalone editor app (it is only published for that file now).

## Blockers / Requests to other modules
- query-builder (resolved 2026-10-06): the embeddable panel shipped in PR #67 and is wired. Still nice to have there: a `SelectionBus` change stream (the panel polls `current` every 250 ms).
- map-viewer: confirmed — shell mounts a panel `component` that is `{ mount(container) => dispose }` (see `src/panels.tsx`); React components also work. `viewer.main` can use the handle as-is.
- infra: optionally run `bun run --filter @deadlock-query/shell e2e` in CI (needs Chromium); `tools/build.ts` already picks up `modules/shell/dist` (run `bun run --filter @deadlock-query/shell build` first).

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-06 — M0: e2e is a separate `bun run e2e` script (needs Chromium at `CHROMIUM_PATH` or `/opt/pw-browsers/chromium`), kept out of `verify` so CI does not need browsers; wire into CI later via infra request.
- 2026-10-06 — Vite `base` defaults to `./`; override with `SHELL_BASE` for prod subpath.

- 2026-10-06 — M1: base services use contracts mocks until real layers exist; `MockMapDataService`/`MockQueryEngine` get added to the base in M2 when panels need them.

- 2026-10-06 — M2: unrelated extra panels (e.g. `?demoFailure`) are split below the viewer rather than tabbed, so the map stays visible.

## Open questions
- (see PLAN.md §9)
