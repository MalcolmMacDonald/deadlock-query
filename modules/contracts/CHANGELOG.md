# contracts changelog

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
