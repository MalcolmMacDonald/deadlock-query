# contracts — state

- **Status:** M4 done (`MapMetadata`, `ScreenshotSet`, additive); `check:real` re-run on the real bundle still to do locally
- **Version:** 0.5.0
- **Current milestone:** M4 done; nothing queued (next: requests from other modules)
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

- M3 (2026-10-06): typed `Manifest.baked` (`Baked`, `BakedBvh`, `BakedSampleGrid`, `BakedNavmesh`, `BakedFile`) matching what map-extractor writes; `Tile.lod`/`lodOf` plus `tileLod`/`tileBaseId`/`tilesAtLod` (legacy `#lod<n>` ids still read); pure `checkTiles`/`checkFiles` in `BundleCheck.ts`; `check:real` verifies baked files (existence, bytes, sha256, grid/navmesh sanity) and LOD tiles; fixture has one entity per `EntityKind`. Everything is additive under schemaVersion 1.0.0, see CHANGELOG. Verified in the cloud with unit tests and a synthetic baked + LOD bundle; **not run against the real dl_midtown bundle** (it lives on Malcolm's machine): run `bun run check:real -- <bundle>` locally and record the result here. Expected: pass, with warnings for placeholder semantics, the fixture lacking baked/LOD, and ids-only LODs. If navmesh counts are 0 (clip-lid navmesh, see map-extractor "Collision finding") `checkFiles` errors with "baked navmesh has no polygons"; that would be a real extractor finding, not a contract bug.

- ViewerService.registerTool (2026-10-06, requested by map-viewer M5): `ExternalTool`, `ToolContext`, `NewAnnotation` moved into contracts as plain types; the `ViewerService` tag gained `registerTool(tool): Effect<() => void>` (optional first, required since 0.5.0) and `makeMockViewerServiceWithTools()` is a mock layer that records registrations. See CHANGELOG.

- M4 (2026-10-06): `MapMetadata` (`src/MapMetadata.ts`): record union (walkableRegion, creepCamp, sinnersSacrifice, healingOrb, navLink, custom), `MetadataFile`/`MetadataBundle`/`Submission`/`ReviewDecision`, deterministic `makeMetadataBundle` + content hash, `acceptedRecords`, `validateMetadataRecords`/`validateSubmission`; JSON Schemas generated. Details in CHANGELOG. map-metadata M0 and query-library M6 can start against it.

- ScreenshotSet (2026-10-06, requested by screenshot-tool): `src/ScreenshotSet.ts` with `ScreenshotSet`/`Shot`, `makeScreenshotSet`, `poseError`, `validateScreenshotSet`, `shotsNear`; JSON Schema generated. Details in CHANGELOG.

- 0.5.0 (2026-10-06): `ViewerService.registerTool` is required now (map-viewer #107 and query-builder #109 provide it); `MockViewerService` has a no-op, `makeMockViewerServiceWithTools()` records. Details in CHANGELOG.

## In progress
- Annotation schema (requested by map-viewer M3): added `Annotation`/`AnnotationDocument` (2026-10-06), see CHANGELOG. map-viewer can replace its local `Annotation` type (`src/annotations.ts`) with it for import/export and IndexedDB autosave; its local `id` is `a<N>`, which fits the non-empty string id.

## Next
- Run `check:real` on the real bundle (Malcolm's machine) and note the outcome.
- M4 is complete. Remaining contracts work arrives as requests from map-metadata, query-library, screenshot-tool and map-viewer (see below). `ViewerService.registerTool` is already required.

## Blockers / Requests to other modules
- screenshot-tool (M1+): write `index.json` as a `ScreenshotSet` (`makeScreenshotSet`), fill `actual` from the `getpos` read-back, and generate the fake-console fixture (`placeholder: true`); `validateScreenshotSet` is what `verify` can call for the shared rules (checking files and hashes on disk stays in the tool).
- map-viewer: street-view markers can use `shotsNear(set, annotationPoint, radius)`.
- map-metadata (M0): consume `MetadataRecord`/`Submission`/`MetadataBundle` from contracts for the kinds registry and validators; add the collision-dependent geometry checks there. Tell contracts if a kind needs another field.
- query-library (M6): load `metadata.bundle.json` with `decodeVersioned(MetadataBundle, 1)` + `verifyMetadataBundle`, use `acceptedRecords`, and carry `record.provenance` into merged entities. `navLink`/`walkableRegion` are applied at query-load time over the baked navmesh, not by re-baking. Sinner's Sacrifice has no `EntityKind` yet; add one here if the library wants it as an entity.
- map-extractor: write `lod` and `lodOf` on LOD tiles (`tiling.ts` `lodId`/`lodFile` sites) alongside the `#lod<n>` id; the id convention can stay until consumers move. `BakedRecord`/`NavmeshRecord` could become `Baked`/`BakedNavmesh` from contracts instead of local interfaces.
- map-viewer: draw `tilesAtLod(manifest, 0)` rather than every manifest tile (the real bundle has LOD tiles sharing the base bounds), and replace the `bakedBvhFile` cast with `manifest.baked?.bvh.file`.
- infra: NEXT.md contracts row can move to M4 / "run check:real on the real bundle" (root file, so not in this module's PR).
- map-extractor: write `manifest.json`/`entities.json` with `schemaVersion` "1.0.0" and per-file `collision.glbToWorld`; entity `kind` mapping table is in `EntityKind` (S2 class list). Unverified: physics vs render frame agreement.
- consumers: use `Mock*` layers + `fixtures/mini-map`; do not depend on extractor output.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — M1: entities `kind` enum starts from S2 class list; `collision.glbToWorld` is per-file because S2 saw a 0.0254-scale axis-swapped node matrix in the physics GLB. Fixtures use a hand-rolled GLB writer and sync SHA-256 so mocks work in browsers.

- 2026-10-06 — M1 extension: added `rowIds` field to `QueryResult` schema (array of strings, one per row, derived from entity.id or row index). Enables row ↔ feature tracking for viewer integration. Fixtures regenerated with new field.

- 2026-10-06 — Annotation is a discriminated union on `kind` with per-kind point counts in the schema; unique ids and layer references are checked by `validateAnnotationDocument` (schema cannot express them). Added under schemaVersion 1.0.0 as it is purely additive.

- 2026-10-06 — M3: `params` of the sample grid is `Record<string, number>` rather than a fixed struct so spatial-core can add a semantics parameter without a contracts bump; `Tile.lod` is optional with helpers reading the legacy id suffix, so no schemaVersion bump; fixture left unbaked and without LOD tiles (reasons in CHANGELOG).

- 2026-10-06 — `registerTool` was added to the `ViewerService` tag as optional (additive) and made required in 0.5.0 once every implementation had it; its value is `Effect<() => void>` as map-viewer suggested. `captureImage` options (`{ scale, transparent }`) and `OverlayStyle` extensions are not added yet (changing `captureImage` from an Effect value to a function would break callers); still on `ViewerController.capture(opts)`.

- 2026-10-06 — M4: one record union keyed by `kind` rather than a registry of per-kind schemas, so a new kind is one additive union member; nav overrides are `walkableRegion.flag` (noGo/walkable) + `costMultiplier` and `navLink`, as the plan's override list (blocked polygons, added links, area costs) needs; `contentHash` covers build, map and records only (not `schemaVersion`), so a pure schema-version bump does not look like a data change.

## Open questions
- (see PLAN.md §9)
