# spatial-core — state

- **Status:** S5 spike done (go)
- **Version:** 0.0.0
- **Current milestone:** S5 done; next M0
- **Last updated:** 2026-10-05

## Done
- **S5 spike: GO** (2026-10-05). `bun run bench` (`bench/s5.ts`) on a deterministic 1.0M-triangle heightfield, three@0.170 + three-mesh-bvh@0.8.x, default CENTER strategy, maxLeafTris 10:

| Metric | Gate | Bun main | Bun Worker | Chromium Worker |
|---|---|---|---|---|
| Build | < 5 s (Bun) | 0.4 s | 0.5 s | 0.7 s |
| 100k first-hit rays | < 300 ms (Worker) | 425 ms | 460 ms | **286 ms** |
| Deserialise | < 500 ms | 0.2 ms | 0.2 ms | 0.4 ms |
| 1000 sphere `intersectsSphere` | n/a | 19 ms | 18 ms | 19 ms |

  Serialised BVH is 10 MB (`MeshBVH.serialize`, excludes geometry). Deserialise is zero-copy, so it excludes loading geometry buffers. The ray gate passes only in the browser Worker (what the gate targets) and with little margin (rays are vertical onto a heightfield; real collision will differ), so M1 should add `raycastFirstMany` batch APIs and re-measure on real collision. Not benchmarked yet: capsule shapecast (only sphere overlap) and Dijkstra (M4).

## In progress
- (nothing yet)

## Next
- M0: scaffold math, `Raycaster` interface + three-mesh-bvh impl, deterministic serialise tests.

## Blockers / Requests to other modules
- (none)

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — Raycasting backend = three-mesh-bvh (D15); `semantics/` is owner-authored; spike S5 is the first task.

## Open questions
- (see PLAN.md §9)

- 2026-10-05 — S5 result: keep three-mesh-bvh (D15); no fallback ADR needed. Bench scene lives in `bench/scene.ts`.
