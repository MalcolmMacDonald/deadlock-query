# query-library — state

- **Status:** M0 + M1 + M2 + M3 done
- **Version:** 0.1.0
- **Current milestone:** M4 (needs spatial-core NavMesh)
- **Last updated:** 2026-10-06

## Done
- M0: scaffold; `bun run build` emits `dist/index.js` (worker-safe ESM), per-file `.d.ts` (extensionless imports for Monaco), `apiCatalog.json`, `package.json` with `apiVersion`.
- M1: `MapContext.fromBundle({manifest, entities})` with typed collections (`guardians`, `walkers`, `patrons`, `healingOrbs`, `creepCamps`, `ziplines`, `ofKind`, `entities`); `Vec3` (`distanceTo`, `crowFliesTo`); `EntityList` (`inLane`, `onTeam`, `within`, `closest`, `highGround` (absolute z placeholder)); lazy `Seq`/`OrderedSeq` LINQ helpers; `meters`/`units`/`vec`.
- Slice-1 query test: guardian -> nearest healing orb reproduces `expected/guardian-orb-distance.json` on the mini-map fixture.
- Docs gate: build and test fail if an export lacks summary/`@category`, or a function/class/method lacks `@example`.

- M2: API snapshot (`test/api.snapshot.json`, signatures only) checked by `test/api.test.ts`; `bun run api:update` regenerates and refuses removals/changes unless `package.json` version is bumped. `examples/*.ts` query files (TSDoc `@example`/`@category`) are typechecked and run on the mini-map by `test/examples.test.ts`. TSDoc coverage gate was already in M0 build/test.

- M3 (2026-10-06): fluent wrappers over spatial-core, via structural types (`RaycasterLike`, `SemanticsLike`, `SpatialInput`) so `dist/*.d.ts` stays free of spatial-core. `MapContext.fromBundle({..., spatial: {raycaster, semantics?, params?}})`. `Vec3.height()` (elevation above map-bounds min z), `isInterior()`, `nearestWall()`, `visibleFrom(p|iterable, opts)`; `EntityList.visibleFrom`; `map.sample.grid(spacing,{region})` (downward rays, walkable normals) and `map.sample.walls(spacing)` (owner `nearestWall` from grid points, deduped per cell); `map.provisional` mirrors `semantics.placeholder`. Tests use the real spatial-core `Raycaster` with stub semantics (wiring + determinism only).

## In progress
- (nothing)

## Next
- M4 needs spatial-core NavMesh. Owner semantics (spatial-core M2) are not in yet: `isInterior`/`nearestWall`/`visibleFrom`/`sample.walls` throw until a `semantics` is passed.
- Not yet verified on a real bundle (real data is local-only; run via `contracts` `check:real` style script once extractor output exists).

## Blockers / Requests to other modules
- (none)

## Decisions log
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
