# map-viewer — state

- **Status:** M3 partly done (layers panel, annotation tools, undo/redo); import/export + autosave blocked on contracts `Annotation`; M1 real-bundle perf check pending
- **Version:** 0.3.0
- **Current milestone:** M3 (finish)
- **Last updated:** 2026-10-06

## Done
- M0: package scaffold; `makeViewerModule(data)` returns a `ModuleDefinition` with one `viewer.main` panel whose component is `{ mount(container) => dispose }` rendering a 2D top-down canvas of mini-map entities; `loadViewerData` reads `MapDataService` (tested against contracts' `MockMapDataService`).

- M1: Three.js scene (`src/scene.ts`) loads fixture tile GLBs with `worldToThree * glbToWorld` and draws entity markers; Map/Orbit/Fly cameras over one world-space pose (`src/camera.ts` pure math, `src/controls.ts` input; keys 1/2/3 or toolbar buttons switch mode, WASD/QE + wheel speed in Fly); URL-hash camera state `#cam=<mode>:<tx>,<ty>,<tz>,<yaw>,<pitch>,<dist>` (`src/hashState.ts`), restored on load; render-on-demand. Tests: bun unit (camera math, hash codec, fixture lands inside manifest bounds) and `bun run test:e2e` Playwright smoke (pan/zoom/orbit/fly, reload restores camera) using software GL; e2e is not in `verify` (needs Chromium, `CHROMIUM_PATH` overrides `/opt/pw-browsers/chromium`).

- M2: `ViewerService` overlay API. `src/overlays.ts` (`OverlayScene`: points = one `THREE.Points` draw call with screen-space size, polylines/segments = `LineSegments`, polygons = triangulated translucent fill + outline; highlight layer; CPU picking `pickFeature` in screen space) and `src/viewerService.ts` (`ViewerController` remembers overlays/highlight/pose and replays them when a panel mounts; `makeViewerService(controller)` is the `ViewerService` layer; events `pick`/`hover`/`camera` via a sliding `PubSub`; `captureImage` = PNG of the canvas; `loadBundle(url)` fetches manifest/entities/tiles over HTTP and reframes). Feature ids are `"<layerId>:<index>"`; a bare `Vec3[]` is a point layer. Tests: bun unit (picking, scene objects, service replay, `MockViewerService` parity) and e2e (10k points visible, pick/hover/camera events, PNG capture).

- 2026-10-06 — Collision GLB is drawn (`ViewerData.collision`, `buildScene` uses `manifest.collision.glbToWorld`; `loadBundle` fetches it). Checked against the real dl_midtown lite bundle: mesh bounds equal manifest bounds in Three space.

- 2026-10-06 — M3 (part 1): `viewer.layers` and `viewer.tools` panels (`src/panels.ts`) over state held on `ViewerController`, so they survive remounts and work with the shell's shared controller. `LayerStore` (`src/layers.ts`): every overlay layer, including query layers, gets visibility, colour override, opacity and draw order; `OverlayScene.setAppearance` applies it, hidden layers are not picked. Annotations (`src/annotations.ts`): point, label, polyline, polygon, measure kinds, `AnnotationStore` with undo/redo history (200 steps), rendered as overlay layers `ann.points|labels|lines|polygons|measures`. Tools (`src/tools.ts`): `ToolMachine` (select/point/label/polyline/polygon/measure), rubber-band draft, double-click/Enter finishes, Esc cancels, Ctrl+Z / Ctrl+Y / Delete on the canvas. Points land on the first terrain hit (Three raycaster, click only), else on the horizontal plane through the last placed point or the camera target. Tests: bun unit (`test/annotations.test.ts`) and e2e (draw, layer hide/show, undo/redo, measure, delete).

## In progress
- (nothing)

## Next
- M1 leftover (needs Malcolm's machine): open the real single-tile bundle and confirm >= 30 fps; the viewer loads any manifest via `MapDataService`, so no code change expected.
- M3 remainder: import/export as the contract `AnnotationDocument` (needs contracts), IndexedDB autosave (store the same document), snapping to surface/vertices/features and BVH picking (three-mesh-bvh; click raycast is brute force today and hover preview uses the plane only), vertex editing, multi-select, per-layer lock, text rendering for labels and measure results (shown only in the tools list for now; SDF labels are M7).
- M2 leftover: confirm 10k points at 60 fps on real hardware (software GL in CI measures ~15 fps for the whole scene, informational only).

## Blockers / Requests to other modules
- Contracts: add an `Annotation` / `AnnotationDocument` schema (`schemaVersion`, features with kind point/label/polyline/polygon/measure, world-space `Vec3` points, label text, optional properties). M3 acceptance ("export equals schema-valid document") needs it; the viewer's local `Annotation` type (`src/annotations.ts`) will be replaced by it.
- Shell: mount `viewer.layers` (`makeLayersPanel(controller)`) and `viewer.tools` (`makeToolsPanel(controller)`) next to `viewer.main`, using the same `ViewerController`. They are already listed in `makeViewerModule(...).panels`; `shell/src/viewer.ts` builds its own module and only lists `viewer.main`.
- Shell/contracts: `ModuleDefinition.layer` is typed `Layer<never>` and shell provides `MockViewerService` in its base layer, so the real service is not reachable by other modules yet. Shell should create one `ViewerController`, pass it to `makeViewerModule(data, controller)` and provide `makeViewerService(controller)` instead of the mock.
- Contracts: `ViewerEvent` pick/hover carry only `id`; style has only `color`/`size` (line width is not supported by WebGL lines; fat lines come later). Per-feature styling from columns needs an `OverlayStyle` extension.
- Shell: confirm the panel `component` handle shape (`{ mount(container): dispose }`) is what the shell mounts; contracts types it as `unknown`.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-06 — M0 uses a dependency-free framework-agnostic mount handle and a 2D canvas placeholder; Three.js arrives in M1. Harness test is a bun unit test (no DOM); Playwright arrives with M1.

- 2026-10-06 — Camera pose is world-space `{target, yaw, pitch, distance}` shared by all modes; Map is pitch-clamped top-down perspective (not orthographic) so mode switches keep the eye. Pitch clamps at 1.55 rad to avoid lookAt degeneracy. `ViewerData` gained `tiles` (raw GLB bytes); `loadViewerData` fetches them. `three`/`playwright-core` added as deps.

- 2026-10-06 — M2: feature ids are `layerId:index` (stable for a given `setOverlay` call). Lines use 1px `LineSegments` (fat-line shader deferred). Overlays render with depth test off so query results are never hidden by terrain. `ViewerService` is exposed via `makeViewerService(controller)` rather than `ModuleDefinition.layer` (see Blockers).

- 2026-10-06 — Terrain rendered solid black on the dev site: extracted GLBs carry POSITION only (no NORMAL), so `MeshStandardMaterial` lit to black. Fixed with `flatShading: true` (per-fragment derivative normals); e2e smoke now asserts lit terrain pixels.

- 2026-10-06 — M3: selecting an annotation reuses the viewer's single highlight slot, so it replaces any query highlight until cleared. Layer order is the draw order among overlay layers only; draft and highlight always draw above (render order 15 / 20). Annotation layers disappear (and their appearance resets) when their last annotation is deleted.

## Open questions
- (see PLAN.md §9)
