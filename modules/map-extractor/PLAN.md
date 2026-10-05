# map-extractor — plan

## 1. Purpose & scope
Local-only CLI (`dlq-extract`) that turns an installed copy of Deadlock into a **MapBundle** using the Source2Viewer CLI (https://s2v.app/, built on ValveResourceFormat), then **bakes** derived spatial data (collision BVH, navmesh, height/interior grid, wall distance field) so the browser never has to compute them.

**Non-goals:** no web UI; never uploads anything (publishing a `lite` bundle is a separate, human-triggered step via infra's data workflow); no screenshots.

## 2. Ownership boundary
`modules/map-extractor/**`. Output: `data/bundles/<gameBuildId>/<tier>/` (git-ignored).

## 3. Published surface
CLI (`@effect/cli`), stable exit codes, `--json` output:

| Command | Purpose |
|---|---|
| `doctor [--fix]` | Find Deadlock (Steam `libraryfolders.vdf`, `--game-dir`/`DEADLOCK_DIR`), game build id, Source2Viewer CLI (pinned version+sha in `tools.lock.json`, optional download with confirmation) **[VERIFY** Steam AppID, VPK layout, main map name**]** |
| `list-maps` | Maps present in the game paks |
| `extract --map <name> [--tier full\|lite] [--force]` | Geometry + collision + entities → bundle |
| `bake <bundle-dir>` | Derived data: collision BVH (three-mesh-bvh via spatial-core), navmesh, sample grid with `floorHeight` plus channels produced by the owner-authored semantics functions (e.g. `interior`, `wallDistance`) |
| `pack-lite <bundle-dir>` | Produce publishable `lite` tier + archive for the data Release |
| `inspect <bundle-dir>` | Validate against contracts schemas, print sizes/budgets |
| `diff <bundleA> <bundleB>` | Entity/geometry changes between game builds |

Output formats are contracts' `MapBundle` + baked-data specs; `schemaVersion` on all manifests.

## 4. Uses
`contracts` (schemas, `Space`), `spatial-core` (BVH/grid/serialisers used by `bake`). External: Source2Viewer CLI binary, `@gltf-transform/*`, `recast-navigation` (Node WASM, **bake only**).

## 5. Technical design
Idempotent cached stages keyed by `(gameBuildId, stage, toolVersion, inputHash)`:
1. **Locate** install + build id → `GameInstall` service.
2. **Export render geometry** with the S2V CLI → GLB **[VERIFY** flags, whether world geometry is exportable per map**]**. `S2VCli` service wraps `@effect/platform` `Command`, streams progress.
3. **Collision**: export physics mesh; this is authoritative for rays/nav. Optionally filter non-gameplay clutter (props below size threshold) with documented rules.
4. **Entities**: decompile/read the map entity lump (KV3), map classes to contracts `kind` (guardian, walker, patron, healingOrb, creepCamp, zipline…); unknown classes preserved. **[VERIFY** which gameplay entities live in the map file**]**.
5. **Normalise coordinates** (D5): JSON stays Source Z-up units; GLBs carry `glbToWorld`.
6. **Slice 1 stops here**: single tile, no LOD, `full` + a crude `lite` (no textures).
7. **Tiling/LOD/compression** (Phase 2): spatial tiles ≤ 20 MB, ≥ 2 LODs, meshopt/Draco (the viewer's supported decoders are fixed in the viewer's `STATE.md`).
8. **Bake** (Phase 2): BVH (spatial-core, serialised), navmesh (Recast with agent params documented: radius, height, max slope, step height; ziplines/jump pads added as links from entities), sample grid (`floorHeight` + owner-function channels — `bake` calls `spatial-core/semantics`, so channels are provisional until the owner replaces the placeholders; the manifest records `semanticsVersion` + `placeholder: boolean` and `bake` is re-run when semantics change). Heavy work in worker threads; progress stream.
9. **Lite tier**: untextured/flat-colour decimated render mesh + collision + entities + baked data, size budget ≤ 150 MB with report.
10. **Manifest + sha256 + validation**.

Errors are `Data.TaggedError`s (`GameNotFound`, `ToolMissing`, `ExportFailed{stage,stderr}`, `SchemaMismatch`) with remediation text. Windows primary.

## 6. Milestones
| # | Deliverable | Acceptance |
|---|---|---|
| **S2** (spike, first) | Run S2V CLI manually on the Deadlock map; document commands, outputs, sizes, which entities / collision / nav data exist | Findings in `STATE.md`; contracts agent unblocked for M1 |
| M0 | Scaffold CLI, `doctor`, tool lock/download, `GameInstall` | `doctor` correct on dev machine, helpful on failure |
| M1 | **Slice 1**: `extract` → render GLB + entities + collision (single tile) + manifest | `inspect` passes; contracts real-data check passes; viewer renders it |
| M2 | `pack-lite` (no textures), size report | Lite bundle < budget; no texture files (tested) |
| M3 | Tiling + LOD + compression | Largest tile ≤ 20 MB |
| M4 | `bake`: collision BVH + sample grid (`floorHeight` + semantics channels, placeholder-aware) | Round-trips via spatial-core; manifest records semantics version/placeholder flag; golden checks on fixture |
| M5 | `bake`: Recast navmesh + links; visual QA export (OBJ/GLB of navmesh) for human review | Human sign-off on navmesh in `STATE.md` |
| M6 | Caching/resume/`diff`, README, game-update runbook | Re-run unchanged < 5 s |

## 7. Test strategy
Unit tests with synthetic inputs (KV3 parser, entity mapping, tiler, manifest writer, bake on contracts fixture). Opt-in integration test when `DEADLOCK_DIR` set. CI runs unit tests only.

## 8. Standalone mode
`dlq-extract extract --fixture` builds the contracts mini-map through the same writer; `bake` runs on it.

## 9. Risks & open questions
- What S2V can actually export for Deadlock (collision/entities/nav) — S2 decides scope.
- Recast on raw collision: stairs, props, ziplines, jump pads, one-way drops → navmesh needs QA and metadata overrides (map-metadata).
- Map size → `lite` decimation strategy.
- Game updates change formats → pin tool version; warn when game build is newer than last tested.
- Legal: IMPLEMENTATION_PLAN D8.

## 10. Definition of done
One command sequence (`extract` → `bake` → `pack-lite`) on a clean machine produces valid bundles consumed unchanged by viewer, library and the data-release workflow; navmesh signed off; docs and `STATE.md` current.
