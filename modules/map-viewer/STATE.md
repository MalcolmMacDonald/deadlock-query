# map-viewer — state

- **Status:** M1 done (fixture); real-bundle perf check pending
- **Version:** 0.1.0
- **Current milestone:** M2 (next)
- **Last updated:** 2026-10-06

## Done
- M0: package scaffold; `makeViewerModule(data)` returns a `ModuleDefinition` with one `viewer.main` panel whose component is `{ mount(container) => dispose }` rendering a 2D top-down canvas of mini-map entities; `loadViewerData` reads `MapDataService` (tested against contracts' `MockMapDataService`).

- M1: Three.js scene (`src/scene.ts`) loads fixture tile GLBs with `worldToThree * glbToWorld` and draws entity markers; Map/Orbit/Fly cameras over one world-space pose (`src/camera.ts` pure math, `src/controls.ts` input; keys 1/2/3 or toolbar buttons switch mode, WASD/QE + wheel speed in Fly); URL-hash camera state `#cam=<mode>:<tx>,<ty>,<tz>,<yaw>,<pitch>,<dist>` (`src/hashState.ts`), restored on load; render-on-demand. Tests: bun unit (camera math, hash codec, fixture lands inside manifest bounds) and `bun run test:e2e` Playwright smoke (pan/zoom/orbit/fly, reload restores camera) using software GL; e2e is not in `verify` (needs Chromium, `CHROMIUM_PATH` overrides `/opt/pw-browsers/chromium`).

## In progress
- (nothing)

## Next
- M1 leftover (needs Malcolm's machine): open the real single-tile bundle and confirm >= 30 fps; the viewer loads any manifest via `MapDataService`, so no code change expected.
- M2: `ViewerService` overlay API (points/lines/polygons, styles, highlight, events).
- Collision GLB is not rendered yet; `ViewerData` carries render tiles only.

## Blockers / Requests to other modules
- Shell: confirm the panel `component` handle shape (`{ mount(container): dispose }`) is what the shell mounts; contracts types it as `unknown`.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-06 — M0 uses a dependency-free framework-agnostic mount handle and a 2D canvas placeholder; Three.js arrives in M1. Harness test is a bun unit test (no DOM); Playwright arrives with M1.

- 2026-10-06 — Camera pose is world-space `{target, yaw, pitch, distance}` shared by all modes; Map is pitch-clamped top-down perspective (not orthographic) so mode switches keep the eye. Pitch clamps at 1.55 rad to avoid lookAt degeneracy. `ViewerData` gained `tiles` (raw GLB bytes); `loadViewerData` fetches them. `three`/`playwright-core` added as deps.

## Open questions
- (see PLAN.md §9)
