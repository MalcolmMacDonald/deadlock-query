# map-metadata — state

- **Status:** M0 done; M1 (editor panel + kind tools + IndexedDB drafts) next
- **Version:** 0.1.0
- **Current milestone:** M0 complete
- **Last updated:** 2026-10-06

## Done
- M0 (2026-10-06): package scaffold (`@deadlock-query/map-metadata`, depends on contracts only), feature kinds registry, validators, `metadata:validate` CLI, fixtures and tests. Consumes `MetadataRecord`, `MetadataFile`, `MetadataBundle`, `Submission`, `decodeVersioned`, `verifyMetadataBundle`, `validateMetadataRecords` from contracts M4; no contracts change was needed.
  - `src/kinds.ts`: `KINDS` registry, one entry per record kind (`walkableRegion`, `creepCamp`, `sinnersSacrifice`, `healingOrb`, `navLink`, `custom`): `{ id, label, geometryType, schema, validators[], tool, style, uniqueness? }`. `schema` is taken from `MetadataRecord.members`, so contracts stays the single source of truth; `tool` is a plain descriptor that M1 turns into a viewer `ExternalTool`. A new kind = one entry here plus its record in contracts.
  - `src/validate.ts`, `src/documents.ts`: `validateRecords`, `validateSubmissionRecords`, `checkDocument` (JSON text or parsed, file / bundle / submission, version gate, size limits, bundle hash). Reports are `{ issues, ok, degraded }` with stable issue codes (`polygon-self-intersects`, `duplicate-nearby`, `not-on-surface`, `inside-solid`, `regions-overlap` (warning), ...). Worker-safe: `src/index.ts` has no Node imports.
  - Rules: contracts' cross-field rules (unique ids, polygon area, bounds, link endpoints) plus simple polygon (no repeated vertex, no self-touching edges), max area (map footprint), duplicate points within a per-kind radius of another proposed/accepted record of the same kind or an `existing` accepted one, overlapping same-flag walkable regions at the same floor height (warning), build/map identity, submissions hold only `proposed`, per-kind files hold only their kind.
  - Collision-dependent checks (point on a surface within epsilon, point/link end not inside solid) run only when the caller passes a `CollisionProbe` (`groundZ`, `insideSolid`); without one the report says `degraded: true` and only bounds/shape checks run. M2 builds the probe from the loaded bundle in the editor.
  - `bun run metadata:validate -- <file|dir>... [--manifest manifest.json] [--json]` (`src/dataDir.ts` + `scripts/validate.ts`): a build directory `data/metadata/<gameBuildId>/` is checked per file and as a whole (ids unique across files, one map name, directory name = `gameBuildId`). Exit 0 ok, 1 invalid, 2 usage.
  - Fixtures: `fixtures/valid/0/` (a full mini-map build directory incl. a bundle), `fixtures/submissions/valid.json`, 17 crafted bad files in `fixtures/bad/`. 50 tests.

## In progress
- (nothing)

## Next
- M1: `metadata.editor` panel, per-kind tools through a mock `ViewerService` (`makeMockViewerServiceWithTools` in contracts), IndexedDB drafts, standalone harness.
- Tune the default radii (camp 200, sacrifice 200, orb 100), `surfaceEpsilon` (24) and overlap tolerance (64) on the real dl_midtown data.

## Blockers / Requests to other modules
- infra (root file, not editable from this module): NEXT.md row `screenshot-tool, map-metadata | Phase 3` can become `map-metadata | M1: editor panel (M0 done)`.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-06 — Duplicate points are errors, overlapping regions are warnings (a reviewer may legitimately accept an overlap; a duplicate camp is never right). Rejected and stale records never count as neighbours.
- 2026-10-06 — Validators take collision through a small `CollisionProbe` interface instead of the `MapBundle`, so the same code runs in the editor, the worker (degraded) and tests.

## Open questions
- (see PLAN.md §9)
