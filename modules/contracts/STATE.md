# contracts — state

- **Status:** M2 real-data check done (no schema changes needed)
- **Version:** 0.1.0
- **Current milestone:** M3 (baked-data specs) next
- **Last updated:** 2026-10-06

## Done
- M0: package scaffold, `Space`, module/service type skeletons (SelectionBus, ViewerService, DevAuth) + mock layers, tests; root workspace (package.json, tsconfig.base.json, root CLAUDE.md). `bun run verify:all` green.

- M1 (2026-10-05): `MapBundle` manifest/entities, `QueryResult` + `exportResult`, `MapDataService`/`QueryEngine`/extended `ViewerService`, mocks, `fixtures/mini-map`, `gen:schemas`, `check:real`, `CHANGELOG.md`.

- M2 (2026-10-06): `check:real` on the first real bundle: `dl_midtown` lite, build 25738777, extractor 0.3.0 (extract + tile + bake + pack-lite; 6,076 entities, 126 tile files incl. LODs, `manifest.baked` present). **Passes** (exit 0, under 1 s); `Manifest`, `EntitiesFile` and `schemaVersion` 1.0.0 decode as they are, so no schema change was needed.
  - Real entity kinds the fixture lacks (all valid `EntityKind` values): `climbRope`, `laneMarker`, `interior`, `jumpPad`, `zipline`, `shop`, `spawn`, `trooperSpawn`, `barracks`, `crate`, `powerup`, `capturePoint`, `baseSentry`. Consumers should not assume the fixture's kind set is complete; the fixture could gain one entity per missing kind.
  - Real kind counts: zipline 129, creepCamp 52, healingOrb 36, trooperSpawn 24, interior 22, climbRope 17, jumpPad 17, spawn 13, barracks 12, laneMarker 12, shop 9, baseSentry 8, walker 6, guardian 6, crate 6, patron 2, powerup 2, capturePoint 2.
  - 5,701 of 6,076 entities have no normalised `kind` (lights, props, soundscapes...) and keep only their raw `class`.
  - The first run flagged "fixture covers kind guardian but real data has none". That was an extractor bug (the marker is in `bossname`, not `subclass_name`); fixed in map-extractor, and the warning is gone with 6 guardians.
  - `check:real` does not look at `manifest.baked`, the `#lod<n>` tile ids or file sizes. Real shape for M3: `baked` has `bakeVersion`, `semanticsVersion`, `placeholder`, `inputKey`, `bvh{file,bytes,sha256,triangles,vertices,excludedLayers,skippedNodes}`, `sampleGrid{file,bytes,sha256,cellSize,nx,ny,origin,channels,params}` (333 x 385 cells of 64, channels floorHeight/interior/wallDistance). LODs are separate tiles with the same bounds (63 LOD0 + 63 `#lod1`, largest tile 4.2 MB). Both are still untyped or by convention; M3 should adopt them.

## In progress
- Annotation schema (requested by map-viewer M3): added `Annotation`/`AnnotationDocument` (2026-10-06), see CHANGELOG. map-viewer can replace its local `Annotation` type (`src/annotations.ts`) with it for import/export and IndexedDB autosave; its local `id` is `a<N>`, which fits the non-empty string id.

## Next
- M3: baked-data specs. Adopt the real `manifest.baked` shape (above) and a `Tile.lod`/`lodOf` field instead of the `#lod<n>` id convention; extend `check:real` to verify `baked` files, tile sizes and LOD tiles; add one fixture entity per missing kind.

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
