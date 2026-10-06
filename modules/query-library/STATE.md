# query-library — state

- **Status:** M0 + M1 + M2 + M3 + M4 + M5 done
- **Version:** 0.1.0
- **Current milestone:** M6
- **Last updated:** 2026-10-06

## Done
- M0: scaffold; `bun run build` emits `dist/index.js` (worker-safe ESM), per-file `.d.ts` (extensionless imports for Monaco), `apiCatalog.json`, `package.json` with `apiVersion`.
- M1: `MapContext.fromBundle({manifest, entities})` with typed collections (`guardians`, `walkers`, `patrons`, `healingOrbs`, `creepCamps`, `ziplines`, `ofKind`, `entities`); `Vec3` (`distanceTo`, `crowFliesTo`); `EntityList` (`inLane`, `onTeam`, `within`, `closest`, `highGround` (absolute z placeholder)); lazy `Seq`/`OrderedSeq` LINQ helpers; `meters`/`units`/`vec`.
- Slice-1 query test: guardian -> nearest healing orb reproduces `expected/guardian-orb-distance.json` on the mini-map fixture.
- Docs gate: build and test fail if an export lacks summary/`@category`, or a function/class/method lacks `@example`.

- M2: API snapshot (`test/api.snapshot.json`, signatures only) checked by `test/api.test.ts`; `bun run api:update` regenerates and refuses removals/changes unless `package.json` version is bumped. `examples/*.ts` query files (TSDoc `@example`/`@category`) are typechecked and run on the mini-map by `test/examples.test.ts`. TSDoc coverage gate was already in M0 build/test.

- M3 (2026-10-06): fluent wrappers over spatial-core, via structural types (`RaycasterLike`, `SemanticsLike`, `SpatialInput`) so `dist/*.d.ts` stays free of spatial-core. `MapContext.fromBundle({..., spatial: {raycaster, semantics?, params?}})`. `Vec3.height()` (elevation above map-bounds min z), `isInterior()`, `nearestWall()`, `visibleFrom(p|iterable, opts)`; `EntityList.visibleFrom`; `map.sample.grid(spacing,{region})` (downward rays, walkable normals) and `map.sample.walls(spacing)` (owner `nearestWall` from grid points, deduped per cell); `map.provisional` mirrors `semantics.placeholder`. Tests use the real spatial-core `Raycaster` with stub semantics (wiring + determinism only).

- M4 (2026-10-06): navigation over spatial-core's `NavMesh` via structural `NavMeshLike`/`NavInput` (`spatial: {raycaster, nav: {mesh, heroSpeed?, linkSpeeds?, maxSnap?}}`). `Vec3.travelTimeTo/travelDistanceTo` (Infinity if unreachable/off-mesh), `EntityList.withinTravelTime(seconds(n), of)` (one multi-source field), `map.nav.path/timeFrom`, `seconds()`; `pairs()` was already in M1. Distance fields are memoised per (mode, source set) in a 256-entry LRU, so `a.travelDistanceTo(b)` over pairs costs one Dijkstra per distinct `a`. Distance mode is the same Dijkstra with unit speeds. Tests use a hand-computable 9x9 grid navmesh (`test/navFixture.ts`) and assert hop lengths, zipline shortcuts, caching, determinism; examples `orbs-within-10s` (query 1) and `orb-detours` (query 2 shape).

- M5 (2026-10-06): headline query 3 as `examples/camps-visible-from-high-ground.ts` (`map.creepCamps.visibleFrom(map.sample.grid(400).where(p => p.height() >= 800))`). Golden test on a hand-computable plateau fixture (`test/plateauFixture.ts`: floor z=0 plus a 2000x2000 plateau at z=1000, stub semantics "visible if < 1500 units apart in XY") expects `["camp-1","camp-2"]`. Helpers: `EntityList.closestN`, `EntityList.groupByRegion(cell)`, `regionOf(p, cell)` / `Region`, `map.sample.density(points, cell)` (`HeatCell`; non-empty cells only, ordered by `ix` then `iy`), example `camp-density`. `EntityList.highGround(h)` now uses `height()` when a spatial backend is loaded (absolute z otherwise). Examples tagged `@requires spatial` run on the plateau map. API snapshot gained symbols only (no version bump).

## In progress
- (nothing)

## Next
- M6: metadata merge (camps/sacrifices/nav overrides) with provenance (needs map-metadata / contracts shape; check blockers there first).
- Still open from M4/M5: query 2 on the real map in < 30 s (needs the real bake and a spatial index for `NavMesh.nearestPoint`, below); golden results for queries 1-3 on the real bundle; owner semantics (spatial-core M2) are not in yet, so query 3 is provisional (`map.provisional`).
- Real data is local-only; run via a `contracts` `check:real`-style script once extractor output exists.

## Blockers / Requests to other modules
- spatial-core: grid/spatial index for `NavMesh.nearestPoint` (used by `distanceField().costAt` for every lookup) before the real-map benchmark; the bundle's navmesh must be loaded via `NavMesh.load` by the builder worker and passed as `spatial.nav.mesh`.

## Decisions log
- 2026-10-06 — Travel model defaults are proposals for the owner: hero speed 7 m/s, zipline 15 m/s, `maxSnap` 200 units (points farther than that from the mesh, e.g. elevated pickups, are unreachable). Costs are polygon-centroid hops, so error is about one polygon; no funnel smoothing yet (spatial-core). `seconds(n)` is the identity (fields are already in seconds); `heroSpeed` lives in `NavInput`, not `MapSettings`, to keep the settings signature stable.
- 2026-10-06 — Directed costs: `a.travelTimeTo(b)` is the field from `a`; one-way links make it asymmetric.
- 2026-10-06 — The active spatial backend is module-global (set by `fromBundle`; one map per worker) so `vec(...)` globals and entity positions can call `height()` etc. without carrying a context. Tests rebuild the map per test.
- 2026-10-06 — `height()` is elevation above the map bounds' min z (not height above local floor), matching the plan's `grid(300).filter(p => p.height() > 800)`. `SemanticsParams` is a plain numeric record forwarded unchanged until spatial-core M2 fixes its shape. `EntityList.highGround` still uses absolute z (switch to `height()` when a backend is guaranteed).
- 2026-10-06 — Lane numbers 1/2/3 stay yellow/blue/purple as the `laneColors` setting (per Malcolm via coordinator); still to verify on the real map.
- 2026-10-06 — API snapshot is signature-only; adding symbols needs just `api:update`, removing/changing needs a `version` bump.
- 2026-10-05 — `isInterior`/`isVisible`/`nearestWall` are owner-authored in spatial-core/semantics; this module only wraps them.
- 2026-10-06 — Public types are structural (`RawEntity`, `BundleInput`) so `dist/*.d.ts` never imports contracts (Monaco only needs this library's `.d.ts`). Contracts is a dev dependency (tests/fixtures).
- 2026-10-06 — `Lane = "yellow" | "blue" | "purple"` (names from the extractor's `subclass_name`); lane number -> colour default 1 yellow, 2 blue, 3 purple is a **proposal for the owner to confirm** (`MapSettings.laneColors`). `inLane` also accepts 1-3.
- 2026-10-06 — `seconds()` deferred to M4 (needs the hero-speed/travel model).

## Open questions
- Confirm lane number -> colour mapping on the real map (see above).
- (see PLAN.md §9)
