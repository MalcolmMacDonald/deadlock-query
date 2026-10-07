# contracts changelog

## 0.6.0 — game-nav navmesh and floor (additive, schemaVersion stays 1.0.0)
- `BakedNavmesh`: the Recast-only fields `tiles`, `agent`, `recast`, `excludedLayers` and `inputTriangles` are now optional (a navmesh taken from the game's own `.nav` has none; the extractor writes zeros / empty for them, which readers should treat as absent). New optional `source` (`"game-nav" | "recast"`, absent = `recast`), `componentsWithLinks`, `largestComponentShareWithLinks` (components once links count as connections) and `walkable` (`WalkableStats` plus `flowFile` / `flowHull`).
- `Baked` gains optional `floorSource` (`"game-nav" | "collision"`, absent = `collision`) and `walkable` (`WalkableStats` plus `triangles`, `coveredCells`, `totalCells`, `multiLevelCells`).
- `CollisionRef` gains optional `walkableNav` / `walkableFlowmap` (bundle paths of the game's nav files, `collision/walkable.nav` / `.navflowmap`). The extractor does not write them to the manifest yet.
- New exports: `NavSource`, `WalkableStats`. `NavAgent` is unchanged. Existing bundles decode unchanged; code that read `navmesh.agent` etc. must handle `undefined`.

## 0.5.1 — OverlayFeature.properties (additive, schemaVersion stays 1.0.0)
- `OverlayFeature` gained an optional `properties` record on every variant. The viewer's inspector lists it when the feature is selected, so query results can show the other columns of a row. Existing features are unaffected.

## 0.5.0 — ViewerService.registerTool is required (schemaVersion stays 1.0.0)
- `ViewerService.registerTool` is now a required member: map-viewer's service, query-builder's standalone viewer and the mocks all provide it. Any other object typed as `ViewerService` must add it (a no-op `() => Effect.succeed(() => {})` is enough).
- `MockViewerService` now has a no-op `registerTool`; `makeMockViewerServiceWithTools()` stays for modules that want the registrations recorded (it also rejects duplicate ids).

## 0.4.0 — ScreenshotSet (additive, schemaVersion stays 1.0.0)
- Added `ScreenshotSet` (`gameBuildId`, `mapName`, `fov`, `hideHud`, optional `placeholder` for fake-console dry runs and `tool`, `shots[]`) and `Shot` (`id`, optional `group`, `requested` and read-back `actual` pose as `{ position, angles }` in Source units/degrees, optional `lookAt`, `file`, optional `thumbnail`, `bytes`, `sha256`, pixel `width`/`height`, `capturedAt`). File paths are relative to the set's `index.json`. JSON Schema `screenshot-set.schema.json` generated.
- Helpers: `makeScreenshotSet` (shots ordered by id), `poseError` (position units and largest angle error, wrap-around safe), `validateScreenshotSet` (unique ids and files, build/map match, read-back pose within tolerance; defaults 8 units and 1 degree) and `shotsNear` (shots around a world point, nearest first, for viewer markers).
- No fixture yet: PLAN.md has screenshot-tool generate it from its fake console.

## 0.3.0 — M4: MapMetadata (additive, schemaVersion stays 1.0.0)
- Added `MetadataRecord`, a union on `kind`: `walkableRegion` (ring, `floorZ`, `flag` walkable/noGo/interior/water, optional `costMultiplier`), `creepCamp` (position, optional `tier`), `sinnersSacrifice`, `healingOrb` (optional `respawnSeconds`), `navLink` (`from`, `to`, `linkKind`, `bidirectional`, optional `cost`) and `custom` (`label`, point/polyline/polygon `geometry`, scalar `properties`). Every record has `id`, `status` (proposed/accepted/rejected/stale), `provenance` (self-declared submitter, submission id, reviewer, timestamps, comment) and optional `name`/`note`. Strings are length-capped plain text.
- Documents: `MetadataFile` (`data/metadata/<build>/<kind>.json`), `MetadataBundle` (`metadata.bundle.json`, with `contentHash`), `Submission` (all records proposed, 1..500), `ReviewDecision` (accepted/rejected/changesRequested). JSON Schemas generated in `schemas/`.
- Helpers: `makeMetadataBundle` (records ordered by kind then id, hash filled in; input order never changes the output), `metadataContentHash`/`verifyMetadataBundle` (sha256 of canonical JSON of build, map and records), `canonicalJson`, `acceptedRecords` (what the library and viewer should use), `ringArea`, `validateMetadataRecords` (unique ids, no zero-area polygons, points inside map bounds, links that go somewhere) and `validateSubmission` (proposed-only, build/map match).
- Not here: geometry checks against collision (camp inside solid, duplicates near an accepted camp) and the review/merge/rebase tooling; they belong to map-metadata. `ScreenshotSet` follows in its own change.

## 0.2.1 — ViewerService.registerTool (additive, schemaVersion stays 1.0.0)
- Added the plain types `ExternalTool`, `ToolContext` and `NewAnnotation` (same shapes map-viewer shipped in `ViewerController.registerTool`).
- `ViewerService` gained `registerTool?: (tool: ExternalTool) => Effect<() => void>`; the value of the effect unregisters the tool. It is optional until map-viewer, shell and query-builder's standalone shape provide it, so no consumer breaks: call `viewer.registerTool?.(tool)`. `MockViewerService` is unchanged (map-viewer's parity test requires it to match the real service); `makeMockViewerServiceWithTools()` returns a mock layer whose `registerTool` records tools (`registeredTools()`).

## 0.2.0 — M3: baked-data specs (additive, schemaVersion stays 1.0.0)
- `Manifest.baked` is now typed (`Baked`): `bakeVersion`, `semanticsVersion`, `placeholder`, `inputKey`, `bvh` (`BakedBvh`), `sampleGrid` (`BakedSampleGrid`: `cellSize`, `nx`, `ny`, `origin`, `channels`, `params`) and optional `navmesh` (`BakedNavmesh`), each file with `file`/`bytes`/`sha256` (`BakedFile`). This is the shape map-extractor already writes (checked against the dl_midtown run in STATE.md), so existing bundles decode unchanged. The binary file formats stay owned by spatial-core; contracts only fixes where the files are and what they were built from. Consumers that cast `manifest.baked` to a local shape can use the typed field.
- `Tile` gains optional `lod` (integer >= 0, absent = 0) and `lodOf` (id of the LOD0 tile). Helpers `tileLod`, `tileBaseId`, `tilesAtLod` read both the fields and the legacy `<id>#lod<n>` id suffix, so current bundles keep working before the extractor writes the fields. Viewers should draw `tilesAtLod(manifest, 0)` unless they stream LODs.
- Added `checkTiles` / `checkFiles` (pure, used by `check:real`): LOD base/bounds/numbering consistency, existence, byte length and sha256 of tiles, collision, entities and baked files, sample grid description, navmesh/BVH counts.
- `check:real` now verifies baked files and LOD tiles (`--no-hash` skips sha256 for a quick pass) and reports what the fixture lacks.
- `fixtures/mini-map` gained one entity for each `EntityKind` it lacked (13 kinds, 19 entities). It stays unbaked and without LOD tiles on purpose: baked binaries need spatial-core, and viewers that draw every manifest tile would render a fixture LOD on top of its base.

## Unreleased — Annotation (additive, schemaVersion stays 1.0.0)
- Added `Annotation` (kinds point/label/polyline/polygon/measure, world-space `Vec3` points in Source units, optional `layer`/`color`/`properties`, `text` required for `label`), `AnnotationLayer`, `AnnotationDocument` (`schemaVersion`, optional `mapName`/`gameBuildId`/`layers`, `annotations`), `makeAnnotationDocument` and `validateAnnotationDocument` (unique ids, resolvable layers). Point counts are enforced per kind. `schemas/annotations.schema.json` generated; `query-result.schema.json` regenerated for `rowIds`.

## 0.1.0 — M1 (schemaVersion 1.0.0)
Slice-1 contract set, shaped by the S2 findings (`modules/map-extractor/STATE.md`).
- Added `MapBundle` schemas: `Manifest`, `EntitiesFile`/`Entity`, `EntityKind`, `decodeVersioned` + `UnsupportedSchemaVersion`.
  - `collision` has its own `glbToWorld` and `layers` (physics GLB nodes carry ~0.0254 scale + axis swap; render uses `coordinateSystem.glbToWorld`).
  - `Entity.class` preserves unknown classes; `kind` only for the mapped set.
- Added `QueryResult` schema, `makeResult`, pure `exportResult` (csv/json/geojson).
- Added services: `MapDataService`, `QueryEngine`; `ViewerService` gained `loadBundle`, `getCamera`/`setCamera`, `events`, `captureImage`, and `setOverlay` now also accepts `OverlayFeature[]` (point arrays still work).
- Added `MockMapDataService`, `MockQueryEngine`, `MockViewerService` extensions, and the synthetic `fixtures/mini-map` (`bun run gen:fixtures`, no Valve data).
- Added `bun run gen:schemas` (JSON Schema in `schemas/`) and `bun run check:real -- <bundle-dir>` (local only).
