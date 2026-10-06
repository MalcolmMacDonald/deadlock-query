# spatial-core — state

- **Status:** M0 + M1 raycaster done
- **Version:** 0.1.0
- **Current milestone:** M1 done; next M2 (semantics scaffold)
- **Last updated:** 2026-10-05

## Done
- **S5 spike: GO** (2026-10-05). `bun run bench` (`bench/s5.ts`) on a deterministic 1.0M-triangle heightfield, three@0.170 + three-mesh-bvh@0.8.x, default CENTER strategy, maxLeafTris 10:

| Metric | Gate | Bun main | Bun Worker | Chromium Worker |
|---|---|---|---|---|
| Build | < 5 s (Bun) | 0.4 s | 0.5 s | 0.7 s |
| 100k first-hit rays | < 300 ms (Worker) | 425 ms | 460 ms | **286 ms** |
| Deserialise | < 500 ms | 0.2 ms | 0.2 ms | 0.4 ms |
| 1000 sphere `intersectsSphere` | n/a | 19 ms | 18 ms | 19 ms |

  Serialised BVH is 10 MB (`MeshBVH.serialize`, excludes geometry). Deserialise is zero-copy, so it excludes loading geometry buffers. The ray gate passes only in the browser Worker (what the gate targets) and with little margin (rays are vertical onto a heightfield; real collision will differ), so M1 should add `raycastFirstMany` batch APIs and re-measure on real collision. Not benchmarked yet: Dijkstra (M4).

- **M0 + M1** (2026-10-06): `src/math.ts` (tuple Vec3/Aabb helpers), `src/raycaster.ts` (`Raycaster` over three-mesh-bvh: `raycastFirst/All`, `occluded`, `closestPoint`, `overlapsSphere/Capsule`, `raycastFirstMany`, `serialize`/`deserialize`). Serialised bytes embed geometry and are byte-deterministic; brute-force oracle tests for rays. Not done: sphereCast/capsuleCast sweeps (only overlap tests), AbortSignal/progress options (M5).

## In progress
- (nothing)

## Next
- M2: `semantics/` scaffold (signatures, params, placeholders, cases.json harness). Then M3 SampleGrid, M4 NavMesh (query-library M4 needs it).

## Blockers / Requests to other modules
- (none)

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — Raycasting backend = three-mesh-bvh (D15); `semantics/` is owner-authored; spike S5 is the first task.

## Open questions
- (see PLAN.md §9)

- 2026-10-05 — S5 follow-up: added a real capsule shapecast to `bench/s5.ts` (segment z -150..150, radius 30, `bvh.shapecast` with AABB prune + `triangle.closestPointToSegment`). 1000 queries: ~32-38 ms in Bun main and Bun Worker (~0.035 ms each), on this slower CI-class sandbox where 100k rays took 585-800 ms (the 286 ms Chromium number above is from a faster machine; ray gate margin stays thin, so M1 batch API advice stands). Gates unchanged: go.
- 2026-10-05 — S5 result: keep three-mesh-bvh (D15); no fallback ADR needed. Bench scene lives in `bench/scene.ts`.

- 2026-10-06 — Serialise format: 16-byte header (vertexCount, triCount, bvhIndexLen, rootBytes) + positions + indices + BVH index + root; single-root only. `Raycaster.fromGeometry` copies nothing and BVH reorders the given index in place.
