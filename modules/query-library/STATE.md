# query-library — state

- **Status:** M0 + M1 + M2 done
- **Version:** 0.1.0
- **Current milestone:** M3 (blocked on spatial-core `Raycaster`/semantics)
- **Last updated:** 2026-10-06

## Done
- M0: scaffold; `bun run build` emits `dist/index.js` (worker-safe ESM), per-file `.d.ts` (extensionless imports for Monaco), `apiCatalog.json`, `package.json` with `apiVersion`.
- M1: `MapContext.fromBundle({manifest, entities})` with typed collections (`guardians`, `walkers`, `patrons`, `healingOrbs`, `creepCamps`, `ziplines`, `ofKind`, `entities`); `Vec3` (`distanceTo`, `crowFliesTo`); `EntityList` (`inLane`, `onTeam`, `within`, `closest`, `highGround` (absolute z placeholder)); lazy `Seq`/`OrderedSeq` LINQ helpers; `meters`/`units`/`vec`.
- Slice-1 query test: guardian -> nearest healing orb reproduces `expected/guardian-orb-distance.json` on the mini-map fixture.
- Docs gate: build and test fail if an export lacks summary/`@category`, or a function/class/method lacks `@example`.

- M2: API snapshot (`test/api.snapshot.json`, signatures only) checked by `test/api.test.ts`; `bun run api:update` regenerates and refuses removals/changes unless `package.json` version is bumped. `examples/*.ts` query files (TSDoc `@example`/`@category`) are typechecked and run on the mini-map by `test/examples.test.ts`. TSDoc coverage gate was already in M0 build/test.

## In progress
- (nothing)

## Next
- M3 needs spatial-core `Raycaster`/semantics; M4 needs navmesh.
- Not yet verified on a real bundle (real data is local-only; run via `contracts` `check:real` style script once extractor output exists).

## Blockers / Requests to other modules
- (none)

## Decisions log
- 2026-10-06 — Lane numbers 1/2/3 stay yellow/blue/purple as the `laneColors` setting (per Malcolm via coordinator); still to verify on the real map.
- 2026-10-06 — API snapshot is signature-only; adding symbols needs just `api:update`, removing/changing needs a `version` bump.
- 2026-10-05 — `isInterior`/`isVisible`/`nearestWall` are owner-authored in spatial-core/semantics; this module only wraps them.
- 2026-10-06 — Public types are structural (`RawEntity`, `BundleInput`) so `dist/*.d.ts` never imports contracts (Monaco only needs this library's `.d.ts`). Contracts is a dev dependency (tests/fixtures).
- 2026-10-06 — `Lane = "yellow" | "blue" | "purple"` (names from the extractor's `subclass_name`); lane number -> colour default 1 yellow, 2 blue, 3 purple is a **proposal for the owner to confirm** (`MapSettings.laneColors`). `inLane` also accepts 1-3.
- 2026-10-06 — `seconds()` deferred to M4 (needs the hero-speed/travel model).

## Open questions
- Confirm lane number -> colour mapping on the real map (see above).
- (see PLAN.md §9)
