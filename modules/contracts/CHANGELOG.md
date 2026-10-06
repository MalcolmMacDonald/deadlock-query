# contracts changelog

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
