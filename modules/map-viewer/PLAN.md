# map-viewer — plan

## 1. Purpose & scope
The 3D viewer of the map with camera controls and annotation tools, "like OpenStreetMap": pan/zoom a top-down map, drop into 3D, overlay layers of points/lines/polygons, add points of interest. It is also the **display surface** for query results (query-builder) and metadata (map-metadata) through `ViewerService`.

**Non-goals:** no query logic, no metadata review workflow, no file extraction. Window chrome/layout belongs to shell.

## 2. Ownership boundary
`modules/map-viewer/**`, exporting a `ModuleDefinition` from `src/index.ts`.

## 3. Published surface
- **`ViewerService`** (tag defined in contracts) implementation: `loadBundle`, camera get/set/flyTo, `setOverlay`/`removeOverlay`, `highlight`, `events` stream (pick/hover/camera), `registerTool`, `captureImage`, annotation get/set.
- **Panels** (rearrangeable via shell): `viewer.main` (3D canvas), `viewer.layers` (layer list: visibility, colour, order, opacity), `viewer.tools` (annotation toolbar), `viewer.inspector` (selected feature properties, screenshot thumbnails), `viewer.minimap` (optional).
- Annotation import/export in the `Annotation` contract format; URL-hash camera state (`#cam=...`).

## 4. Uses
`contracts`: `MapBundle` (loads manifest/tiles/collision/entities), `ModuleDefinition`; later slices: `ScreenshotSet` (markers + image popups), `Annotation`, `MapMetadata` (optional built-in layers). Optional: `SelectionBus`.

## 5. Technical design
- **Rendering**: Three.js (`WebGLRenderer`; WebGPU later). Scene root applies `glbToWorld` from the bundle then `Space.worldToThree` so Z-up data appears upright. `three-mesh-bvh` on collision/render meshes for picking and surface snapping.
- **Streaming**: tile index from manifest → frustum + distance based tile selection, LOD switching, async GLB decode in a Worker (`GLTFLoader` + Draco/meshopt decoders as listed by map-extractor), LRU GPU memory budget (default 512 MB), loading progress as `Stream`.
- **Camera modes** (switchable, state preserved): *Map* (top-down orthographic-feeling pan/zoom with inertia, wheel zoom to cursor, optional tilt), *Orbit* (around picked point), *Fly* (WASD + mouse, speed control, collision optional). Bookmarks, "reset north", smooth `flyTo(bounds|point)`. Keyboard shortcuts & touch gestures.
- **Overlay renderer**: consumes `FeatureCollection` + style. Points → instanced sprites/meshes with screen-space size & clustering when dense (≥ 10 k points must stay 60 fps); lines → fat-line shader; polygons → draped/extruded at `zFloor` with outline; labels → SDF text, collision-avoiding. Per-feature colour/size from `properties` via style expressions (so query results can colour by a column). Layer ordering and depth-test options.
- **Annotation tools** (built on a `Tool` state machine, registered through the same `registerTool` API external modules use): point, polyline, polygon, rectangle, measure (3D & ground distance), text label. Snapping to mesh surface/vertices/existing features, vertex editing, delete, undo/redo (Effect `Ref` + command stack), multi-select, per-layer lock. Persistence: IndexedDB autosave + import/export `AnnotationDocument`.
- **Picking & events**: GPU-free CPU raycast via BVH; hover highlight; events published to `ViewerService.events` and `SelectionBus`.
- **Screenshots**: markers at shot positions with a frustum glyph (orientation + FOV); click opens image in inspector.
- **Export**: `captureImage()` (PNG incl. overlays, optional transparent background, fixed resolution multiplier) for query export.
- **State management**: all viewer state in Effect services/`SubscriptionRef`; React only subscribes. Rendering loop on demand (render when dirty) to save battery.
- **Performance budgets** (documented in `STATE.md`, measured in Playwright perf test on fixture + synthetic large map): 60 fps on integrated GPU at fixture scale; first tile visible < 3 s on broadband; ≤ 1.5 GB RAM.

## 6. Milestones
**Phasing:** M0–M2 (+ Fly camera from M4, single-tile load without LOD) are **Slice 1 / MVP** (see the map in 3D, navigate, show query results as overlays). M3 and M5 are Phase 2. M4 tiling/LOD follows extractor M3. M6–M7 are Phase 3.

| # | Deliverable | Acceptance |
|---|---|---|
| M0 | Scaffold package, `ModuleDefinition` with one panel rendering a canvas; mock `MapDataService` | Shell test harness mounts panel |
| M1 | Load mini-map fixture **and the real single-tile bundle**; Map (top-down), Orbit and Fly cameras; URL camera state | Playwright: load fixture, pan/zoom/orbit/fly, reload restores camera; real bundle opens at ≥ 30 fps on a mid laptop |
| M2 | `ViewerService` overlay API with points/lines/polygons, styles, highlight, events; used by a debug harness and by query-builder via the tag | Contract tests against `MockViewerService` parity; 10 k points at 60 fps (perf test) |
| M3 | Annotation tools (point/line/polygon/measure/label), snapping, undo/redo, layers panel, import/export, autosave | E2E: draw, undo, reload, export equals schema-valid document |
| M4 | Tile streaming + LOD + memory budget; Fly camera; Worker decode | Synthetic 500 MB map stays within memory budget |
| M5 | `registerTool` for external tool providers (used by map-metadata); `captureImage` | Sample external tool registered in test and used end-to-end |
| M6 | Screenshot markers/popups; metadata/entity built-in layers (guardians, camps…) with toggles | Fixture shows all entity types, togglable |
| M7 | Polish: labels collision, theming, touch, a11y (keyboard-only camera & tool use), docs | Checklist in `STATE.md` |

## 7. Test strategy
Unit (camera math, snapping, style expressions, tool state machines) with bun test; headless Playwright with software GL for smoke + screenshot-diff on fixture (tolerant thresholds); perf test harness; conformance suite from contracts.

## 8. Standalone mode
`bun run dev:standalone` serves only the viewer panel in a minimal dockview with the contracts fixture and a debug panel to push overlays by hand.

## 9. Risks & open questions
- Real map size/complexity vs. WebGL memory → relies on extractor LOD/tiling quality; define max triangle budget per tile jointly (requests via `STATE.md`).
- Picking against huge meshes → BVH built in worker, stored per tile.
- Accurate "interior" rendering (roofs hiding interiors): need a clip-plane / section tool (M7 stretch).
- Overlay semantic styling language should stay tiny (colour/size/shape by column), not become a DSL.

## 10. Definition of done
Viewer loads real extracted bundle, supports all three camera modes, overlay API used by query-builder and map-metadata with zero viewer code changes, annotation round-trip is lossless, perf budgets met, `ViewerService 1.0.0` frozen.
