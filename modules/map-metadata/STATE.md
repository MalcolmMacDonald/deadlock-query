# map-metadata — state

- **Status:** M0, M1 done; M2 partly done (tool activation, accepted overlays); shell mount and collision probe left
- **Version:** 0.3.0
- **Current milestone:** M2 in progress
- **Last updated:** 2026-10-07

## Done
- M0 (2026-10-06): package scaffold (`@deadlock-query/map-metadata`, depends on contracts only), feature kinds registry, validators, `metadata:validate` CLI, fixtures and tests. Consumes `MetadataRecord`, `MetadataFile`, `MetadataBundle`, `Submission`, `decodeVersioned`, `verifyMetadataBundle`, `validateMetadataRecords` from contracts M4; no contracts change was needed.
  - `src/kinds.ts`: `KINDS` registry, one entry per record kind (`walkableRegion`, `creepCamp`, `sinnersSacrifice`, `healingOrb`, `navLink`, `custom`): `{ id, label, geometryType, schema, validators[], tool, style, uniqueness? }`. `schema` is taken from `MetadataRecord.members`, so contracts stays the single source of truth; `tool` is a plain descriptor that M1 turns into a viewer `ExternalTool`. A new kind = one entry here plus its record in contracts.
  - `src/validate.ts`, `src/documents.ts`: `validateRecords`, `validateSubmissionRecords`, `checkDocument` (JSON text or parsed, file / bundle / submission, version gate, size limits, bundle hash). Reports are `{ issues, ok, degraded }` with stable issue codes (`polygon-self-intersects`, `duplicate-nearby`, `not-on-surface`, `inside-solid`, `regions-overlap` (warning), ...). Worker-safe: `src/index.ts` has no Node imports.
  - Rules: contracts' cross-field rules (unique ids, polygon area, bounds, link endpoints) plus simple polygon (no repeated vertex, no self-touching edges), max area (map footprint), duplicate points within a per-kind radius of another proposed/accepted record of the same kind or an `existing` accepted one, overlapping same-flag walkable regions at the same floor height (warning), build/map identity, submissions hold only `proposed`, per-kind files hold only their kind.
  - Collision-dependent checks (point on a surface within epsilon, point/link end not inside solid) run only when the caller passes a `CollisionProbe` (`groundZ`, `insideSolid`); without one the report says `degraded: true` and only bounds/shape checks run. M2 builds the probe from the loaded bundle in the editor.
  - `bun run metadata:validate -- <file|dir>... [--manifest manifest.json] [--json]` (`src/dataDir.ts` + `scripts/validate.ts`): a build directory `data/metadata/<gameBuildId>/` is checked per file and as a whole (ids unique across files, one map name, directory name = `gameBuildId`). Exit 0 ok, 1 invalid, 2 usage.
  - Fixtures: `fixtures/valid/0/` (a full mini-map build directory incl. a bundle), `fixtures/submissions/valid.json`, 17 crafted bad files in `fixtures/bad/`. 50 tests.

- M1 (2026-10-07): `@deadlock-query/map-metadata/editor` entry (`src/editor/`, DOM code kept out of the worker-safe main entry).
  - `tools.ts`: one `ExternalTool` per kind, built from the registry. Clicks collect points (camp/orb/sacrifice 1, nav link 2, polygon/polyline until Enter), live preview through `setDraft`, Escape removes the last point then leaves the tool, tools stay active so several camps can be placed in a row. Options (region flag, custom shape/label) are read at click time.
  - `drafts.ts` / `idb.ts`: `DraftStore` writes every change through to a `DraftStorage` (IndexedDB database per map/build name, or memory). Stored drafts are re-decoded with the contracts schema on load; unreadable ones are skipped and counted. Storage failures never stop drawing.
  - `controller.ts`: registers the tools with a `ViewerService`, draws drafts as per-kind overlay layers (`metadata.drafts.<kind>`, kind colour) plus a white `metadata.selected` layer, validates drafts on every change with `validateRecords` (the `context` option is where M2 passes the `CollisionProbe`, `existing` accepted records and bounds), select/focus fly the camera.
  - `fields.ts`: per-kind form fields; `applyPatch` re-checks an edit against the kind's schema and refuses invalid values.
  - `panel.ts`: `mountEditorPanel(root, controller)`: kind legend with hints, options, the drafts list with error/warning badges and Delete, an edit form for the selected draft, a checks list (click a problem to fly to it), Delete all. All user text goes in as text nodes. "Review & submit" is a disabled placeholder until M3.
  - Standalone harness: `bun run dev:standalone` serves `harness/` (canvas mock viewer, 1 px = 4 units) on :4173. Tests: 12 controller tests with `makeMockViewerServiceWithTools` and a Playwright test (skipped without Chromium) that draws a camp and a polygon, reloads and finds both.

- M2 part (2026-10-07): kind buttons in the panel start the drawing tool through `ViewerService.activateTool` (falls back to a hint to pick it in the Tools panel when the viewer lacks it); `controller.setAccepted(records)` draws accepted records dimmed (`metadata.accepted.<kind>`) and adds them as `existing` for duplicate/overlap checks.

## In progress
- (nothing)

## Next
- M2 left: load `metadata.bundle.json` and call `setAccepted` (shell/library supplies the file); a `CollisionProbe` from the loaded bundle needs spatial-core, which this module may not import: request a probe from shell or contracts (see below).
- M2: mount the panel in the real viewer, pass a `CollisionProbe` from the loaded bundle (and `bounds`, `existing` accepted records) as the controller's `context`, snap/Z fill is already done by the viewer's tool feed; overlays of accepted data from `metadata.bundle.json`.
- Tune the default radii (camp 200, sacrifice 200, orb 100), `surfaceEpsilon` (24) and overlap tolerance (64) on the real dl_midtown data.

## Blockers / Requests to other modules
- shell: add the `metadata.editor` panel (`mountEditorPanel` + `createEditorController` from `@deadlock-query/map-metadata/editor`, storage `indexedDbDraftStorage(<gameBuildId>)`) to its module list; that is M2's integration work.
- infra (root file, not editable from this module): NEXT.md row `screenshot-tool, map-metadata | Phase 3` can become `map-metadata | M1: editor panel (M0 done)`.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-06 — Duplicate points are errors, overlapping regions are warnings (a reviewer may legitimately accept an overlap; a duplicate camp is never right). Rejected and stale records never count as neighbours.
- 2026-10-06 — Validators take collision through a small `CollisionProbe` interface instead of the `MapBundle`, so the same code runs in the editor, the worker (degraded) and tests.

- 2026-10-07 — Defaults picked for M1: drafts are keyed per build name in IndexedDB so a new game build starts clean; a new region's floor height is the mean Z of its clicks (editable); new nav links default to a one-way zipline; ids are `<kind>-<time><counter><random>` so drafts from several sessions never collide; the tool stays active after a record so several can be placed in a row.

## Open questions
- (see PLAN.md §9)
