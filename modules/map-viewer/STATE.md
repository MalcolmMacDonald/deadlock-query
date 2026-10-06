# map-viewer — state

- **Status:** M0 done
- **Version:** 0.0.1
- **Current milestone:** M1 (next)
- **Last updated:** 2026-10-06

## Done
- M0: package scaffold; `makeViewerModule(data)` returns a `ModuleDefinition` with one `viewer.main` panel whose component is `{ mount(container) => dispose }` rendering a 2D top-down canvas of mini-map entities; `loadViewerData` reads `MapDataService` (tested against contracts' `MockMapDataService`).

## In progress
- (nothing)

## Next
- M1: Three.js scene, load mini-map fixture GLBs (apply `glbToWorld` then `Space.worldToThree`), Map/Orbit/Fly cameras, URL-hash camera state, Playwright smoke.

## Blockers / Requests to other modules
- Shell: confirm the panel `component` handle shape (`{ mount(container): dispose }`) is what the shell mounts; contracts types it as `unknown`.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-06 — M0 uses a dependency-free framework-agnostic mount handle and a 2D canvas placeholder; Three.js arrives in M1. Harness test is a bun unit test (no DOM); Playwright arrives with M1.

## Open questions
- (see PLAN.md §9)
