# contracts — state

- **Status:** M1 done
- **Version:** 0.1.0
- **Current milestone:** M2 (real-data check) next
- **Last updated:** 2026-10-06

## Done
- M0: package scaffold, `Space`, module/service type skeletons (SelectionBus, ViewerService, DevAuth) + mock layers, tests; root workspace (package.json, tsconfig.base.json, root CLAUDE.md). `bun run verify:all` green.

- M1 (2026-10-05): `MapBundle` manifest/entities, `QueryResult` + `exportResult`, `MapDataService`/`QueryEngine`/extended `ViewerService`, mocks, `fixtures/mini-map`, `gen:schemas`, `check:real`, `CHANGELOG.md`.

## In progress
- Annotation schema (requested by map-viewer M3): added `Annotation`/`AnnotationDocument` (2026-10-06), see CHANGELOG. map-viewer can replace its local `Annotation` type (`src/annotations.ts`) with it for import/export and IndexedDB autosave; its local `id` is `a<N>`, which fits the non-empty string id.

## Next
- M2: run `bun run check:real -- <bundle-dir>` on the first real bundle from map-extractor M1/M2 and adjust schemas (e.g. `EntityKind` additions, render `glbToWorld`, tile material names).

## Blockers / Requests to other modules
- map-extractor: write `manifest.json`/`entities.json` with `schemaVersion` "1.0.0" and per-file `collision.glbToWorld`; entity `kind` mapping table is in `EntityKind` (S2 class list). Unverified: physics vs render frame agreement.
- consumers: use `Mock*` layers + `fixtures/mini-map`; do not depend on extractor output.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — M1: entities `kind` enum starts from S2 class list; `collision.glbToWorld` is per-file because S2 saw a 0.0254-scale axis-swapped node matrix in the physics GLB. Fixtures use a hand-rolled GLB writer and sync SHA-256 so mocks work in browsers.

- 2026-10-06 — M1 extension: added `rowIds` field to `QueryResult` schema (array of strings, one per row, derived from entity.id or row index). Enables row ↔ feature tracking for viewer integration. Fixtures regenerated with new field.

- 2026-10-06 — Annotation is a discriminated union on `kind` with per-kind point counts in the schema; unique ids and layer references are checked by `validateAnnotationDocument` (schema cannot express them). Added under schemaVersion 1.0.0 as it is purely additive.

## Open questions
- (see PLAN.md §9)
