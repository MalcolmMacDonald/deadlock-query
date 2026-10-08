# spatial-core — state

- **Status:** M0–M5 done, nav leftovers done (semantics are placeholders)
- **Version:** 0.7.0
- **Current milestone:** M5 complete; next: owner-written semantics, then real-map checks
- **Last updated:** 2026-10-08 (override types, walkExact, wall clearance, SampleGrid cost report)

## Done
- **Override types, exact walk test, wall clearance, SampleGrid cost report** (2026-10-08, query-library's request). (1) `NavOverrides.addedPolygons`: convex ground polygons (3+ vertices, any winding) appended after the base polygons (indices from `NavMesh.addedPolyStart`); vertices within 0.5 units of existing ones are shared, so a polygon meeting the mesh along an edge is a neighbour, otherwise it needs an added link. Overrides still replace rather than stack, and `withOverrides` always starts from the base mesh. (2) `NavLink.cost`: fixed travel time in seconds for an override link; such a link is usable without a `linkSpeeds` entry for its kind, an explicit speed of 0 still switches the kind off, it is not serialised, and the A* heuristic accounts for it (stays admissible). (3) `NavMesh.walkExact(a, b, {zTol})`: polygon-by-polygon walk of the segment (convex clipping in XY); fails at an open border or blocked neighbour, or where mesh height at a crossing differs from the segment by more than `zTol` (24); tested against a dense-sample oracle on a mesh with holes (>97 % agreement; the rest are corner grazes the oracle steps over). `walkable` (sampled) stays. (4) `findPath(..., {radius})` now also keeps smoothed segments off the open borders (walls) of the corridor: at the worst grazing point a waypoint is pushed out to `radius` from the wall (skipped when that leaves the corridor; three splits per segment at most), still points only. Approximate: it does not re-run the funnel, link hops are untouched. Real excerpt, patron to north spawn: 4,516 / 4,771 / 4,972 / 5,695 units for radius 0 / 16 / 32 / 64 (was 4,516 / 4,672 / 4,839 / 5,181 with portal insets only); golden updated. (5) `bun run bench:grid` (`bench/grid.ts`), cost report on the published bundle (release `data-25763945`, `lite`), `Raycaster.deserialize` of `baked/collision.bvh` (103,077 triangles) 129 ms and the published `sample-grid.bin` (298 x 333 cells of 64, five channels, 1.4 MB) deserialises in 17 ms. `SampleGrid.build` over the whole manifest bounds (42,956 x 37,728 units) with `floorHeight` plus one extra ray channel, sandbox, single thread:

| Cell size | Cells | With a floor | Build | Per cell | Serialised |
|---|---|---|---|---|---|
| 256 | 24,864 | 6,801 | 154 ms | 6.2 us | 0.2 MB |
| 128 | 99,120 | 27,272 | 251 ms | 2.5 us | 0.8 MB |
| 64 | 396,480 | 109,136 | 1.2 s | 2.9 us | 3.2 MB |
| 32 | 1,584,740 | 436,614 | 4.3 s | 2.7 us | 12.7 MB |
| 16 | 6,333,915 | 1,745,945 | 16.7 s | 2.6 us | 50.7 MB |

  Cost is linear at ~2.7 us per cell for the floor ray plus one more ray (about 1.3 us per ray, 72 % of cells have no floor and cost one miss); an owner channel costing `k` rays per floor cell adds roughly `1.3 us * k * floor cells`. Memory is 4 bytes per cell per f32 channel (1 for u8), so 5 channels at 32 cells is ~32 MB. Takeaway: 64 is a fine runtime default; 32 and below belong in the bake, not in a page load.
- **Clearance, walkable, batch LOS** (2026-10-07): `findPath(..., { radius })` insets every portal by `radius` (clamped to its middle) before the funnel, so smoothed corners stay off polygon vertices (where walls are). It changes `points` only, not `polys` or `cost`; it is an approximation (no clearance along open polygon borders other than portals, none for link hops). On the real excerpt (patron to north spawn) the smoothed path is 4,516 / 4,672 / 4,839 / 5,181 units for radius 0 / 16 / 32 / 64. `NavMesh.walkable(a, b, {step, tol})` samples the segment against the mesh (default step 32, tol 24; link hops are not walkable, as expected). `Raycaster.occludedMany(a, b)` is a batch `occluded` over packed segments with `AbortSignal`/`onProgress`. (Exact polygon-walk test and open-border clearance: done 2026-10-08, see above.)
- **Real-navmesh validation** (2026-10-07, bundle `data-25761866`, 85,485 polygons, 2,468 links). Checked against the published release; no correctness or performance fixes were needed. Sandbox numbers (`DL_BUNDLE_DIR=<extracted> bun run bench:real`): `NavMesh.load` ~220-330 ms, index build + first `nearestPoint` <1-90 ms, `nearestPoint` 0.01 ms, `distanceField` 1 source ~99 ms, 30 sources ~78-88 ms, `findPath` ~15 ms for a random pair (~75 ms for the 23k-unit patron route). Patron (1280,8048,632) to patron (-1280,-8034,632): cost 23,030.8 (reverse 23,133.1: start/end snap to polygon centroids, so costs are not exactly symmetric). `distanceField.costAt` equals `findPath.cost` on 60 random pairs; 0 mismatches. From one patron, 83% of polygons are reachable with `jumpPad` and `navConnection` links at walk speed (no zipline links exist in the navmesh). Patrons, team spawns and barracks snap within 1-17 units; neutral camps within 6; `info_trooper_spawn` within ~255-313 (spawn points hover above the floor) and one team spawn (6136,-1,1737) is 841 from the mesh. Regression tests: `test/fixtures/patron-excerpt.nav.bin` (5,781 polygons within 2,500 of the north patron, cut by `tools/nav-excerpt.ts`) with goldens in `test/realNav.test.ts`; a patron-to-patron check on the full bundle runs only when `DL_BUNDLE_DIR` is set. Added `NavMesh.sourceLinks`. `Raycaster.deserialize` loads the published `baked/collision.bvh` (103,077 triangles) in ~70 ms, so line of sight against collision works; a funnel path's segments (lifted 40) were blocked by collision on 1 of 50 segments, which is a link/jump hop.
- **Known limits on the real mesh**: no agent radius/clearance (funnel corners sit on polygon vertices, so paths hug walls); path points can be up to ~17 units from `nearestPoint` where they are link end points rather than polygon vertices; only 74.9% of polygons are in the largest component (1,739 components), so unreachable pairs are common (13 of 60 random pairs); the bundle has no zipline links, only `jumpPad` and `navConnection`; the excerpt fixture is a region cut, not the whole map.

- **Nav leftovers** (2026-10-06): (1) `NavMesh.nearestPoint` uses an XY grid index (`src/navIndex.ts`, built on first use, shared by `withOverrides` copies; ties resolve to the lowest polygon like the old scan; oracle-tested against brute force on stacked floors). (2) `findPath` is funnel-smoothed by default (`src/funnel.ts`; `smooth: false` restores edge midpoints); stretches between off-mesh links are funnelled separately and a link contributes its two end points; `cost` is unchanged (centroid-hop graph cost, so it still equals `distanceField`; the smoothed polyline can be shorter than `cost` implies); no agent-radius clearance, corners sit on polygon vertices. (3) `bun run bench:nav` (`bench/nav.ts`): synthetic 53k-polygon rolling grid on this sandbox: index build 215 ms, `nearestPoint` 0.017 ms each (linear scan was ~8.8 ms on a similar-sized mesh), `distanceField` with 30 sources 69 ms, `costAt` 0.005 ms, `findPath` ~17 ms each. The real-map Dijkstra number is still to take once the real navmesh exists. (4) `Raycaster.triangle(triIndex)` and `triangleCount` (indices as reported by `Hit`/`ClosestPoint`, valid after `deserialize` too), so map-viewer no longer has to parse the serialised layout. (5) `SEMANTICS_VERSION`: generated `src/semanticsVersion.ts` = hash of `src/semantics/*.ts` (CRLF folded to LF; params defaults are part of that source). **After editing `src/semantics/**` run `bun run semantics-version` in this module**; `test/semanticsVersion.test.ts` fails when it is stale. The extractor still computes its own hash (which also mixes in the params object); it can switch to this export.

- **M5 hardening** (2026-10-06): Added `AbortSignal` and `onProgress` callbacks to long-running operations (`raycastFirstMany`, `distanceField`, `findPath`). Created `SEMANTICS.md` with comprehensive documentation and a worked example of `isVisible` implementation. Confirmed SAB (SharedArrayBuffer) readiness: serialised geometry and grids are zero-copy and safe for cross-worker transfer.

- **S5 spike: GO** (2026-10-05). `bun run bench` (`bench/s5.ts`) on a deterministic 1.0M-triangle heightfield, three@0.170 + three-mesh-bvh@0.8.x, default CENTER strategy, maxLeafTris 10:

| Metric | Gate | Bun main | Bun Worker | Chromium Worker |
|---|---|---|---|---|
| Build | < 5 s (Bun) | 0.4 s | 0.5 s | 0.7 s |
| 100k first-hit rays | < 300 ms (Worker) | 425 ms | 460 ms | **286 ms** |
| Deserialise | < 500 ms | 0.2 ms | 0.2 ms | 0.4 ms |
| 1000 sphere `intersectsSphere` | n/a | 19 ms | 18 ms | 19 ms |

  Serialised BVH is 10 MB (`MeshBVH.serialize`, excludes geometry). Deserialise is zero-copy, so it excludes loading geometry buffers. The ray gate passes only in the browser Worker (what the gate targets) and with little margin (rays are vertical onto a heightfield; real collision will differ), so M1 should add `raycastFirstMany` batch APIs and re-measure on real collision. Not benchmarked yet: Dijkstra (M4).

- **M0 + M1** (2026-10-06): `src/math.ts` (tuple Vec3/Aabb helpers), `src/raycaster.ts` (`Raycaster` over three-mesh-bvh: `raycastFirst/All`, `occluded`, `closestPoint`, `overlapsSphere/Capsule`, `raycastFirstMany`, `serialize`/`deserialize`). Serialised bytes embed geometry and are byte-deterministic; brute-force oracle tests for rays. Not done: sphereCast/capsuleCast sweeps (only overlap tests), AbortSignal/progress options (M5).

- **M3 SampleGrid** (2026-10-06): `src/sampleGrid.ts`. Built-in `floorHeight` (downward ray from above bounds, NaN if none) is always present and passed to generators as `cell.floorZ`; custom channels are `fn` or `{type: "f32"|"u8", gen}` so owner functions plug in unchanged. `get(channel, p)` is nearest-cell (XY), null outside. Deterministic binary `serialize`/`deserialize`; `onProgress`/`AbortSignal` on build. Cost report: see 2026-10-08.

- **M4 NavMesh** (2026-10-06): `src/navmesh.ts`. Convex polygon soup (`vertices`, `offsets`, `indices`); adjacency from shared edges; `nearestPoint`, `findPath` (A* over polygons, points via edge midpoints, no funnel smoothing yet), `distanceField(sources, MovementModel)` (multi-source Dijkstra, cost = travel time, `costAt(p)` at polygon resolution), `NavLink`s (cost = length / `linkSpeeds[kind]`, unlisted kinds unusable), `withOverrides` (blocked polys, added links, cost multipliers), deterministic `serialize`/`load`. Tests use a hand-computed corridor. Not done: Recast import (see request below), funnel smoothing, spatial acceleration for `nearestPoint` (linear scan, fine for tests, needs a grid before the 50k-polygon Dijkstra benchmark).

- **M2 semantics** (2026-10-06, written at Malcolm's request): `src/semantics/{params,index}.ts` with `isInterior` (ray up within `interiorCeiling`), `isVisible` (segment test eye→target, range-limited), `nearestWall` (ring of horizontal rays, steep-surface filter). `PLACEHOLDER_SEMANTICS = true` until Malcolm reviews. Harness: `test/semantics/cases.json` + `semantics.test.ts` on a synthetic room; two cases deliberately unlabelled (`expected: null`). Merge needs Malcolm (CODEOWNERS on `src/semantics/**`).

## In progress
- (nothing)

## Next
- Owner-written semantics (Malcolm). (SampleGrid cost report and the Dijkstra benchmark are done.) map-viewer can drop `bakedTriangles` in favour of `Raycaster.triangle`; map-extractor can import `SEMANTICS_VERSION`.

## Blockers / Requests to other modules
- Request to contracts/map-extractor: no navmesh binary spec exists in contracts yet. spatial-core defines one in `NavMesh.serialize` (polygon soup + links); extractor's Recast bake should emit `NavMeshData` (convex polygons) and links, or contracts should adopt this layout.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — Raycasting backend = three-mesh-bvh (D15); `semantics/` is owner-authored; spike S5 is the first task.

## Open questions
- (see PLAN.md §9)

- 2026-10-05 — S5 follow-up: added a real capsule shapecast to `bench/s5.ts` (segment z -150..150, radius 30, `bvh.shapecast` with AABB prune + `triangle.closestPointToSegment`). 1000 queries: ~32-38 ms in Bun main and Bun Worker (~0.035 ms each), on this slower CI-class sandbox where 100k rays took 585-800 ms (the 286 ms Chromium number above is from a faster machine; ray gate margin stays thin, so M1 batch API advice stands). Gates unchanged: go.
- 2026-10-05 — S5 result: keep three-mesh-bvh (D15); no fallback ADR needed. Bench scene lives in `bench/scene.ts`.

- 2026-10-06 — Serialise format: 16-byte header (vertexCount, triCount, bvhIndexLen, rootBytes) + positions + indices + BVH index + root; single-root only. `Raycaster.fromGeometry` copies nothing and BVH reorders the given index in place.
