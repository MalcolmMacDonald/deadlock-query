# spatial-core — plan

## 1. Purpose & scope
Spatial primitives with **no UI**, shared by the extractor's bake step (Bun) and the query library (Web Worker): a **raycasting backend** (three-mesh-bvh behind a `Raycaster` interface), a sample grid, navmesh runtime with pathfinding, and a protected **`semantics/`** folder holding the functions the **project owner writes** (`isInterior`, `isVisible`, `nearestWall`, …).

**Non-goals:** no bundle manifest formats (contracts), no mesh extraction or navmesh *generation* (extractor), no query API surface (query-library), no rendering.

## 2. Ownership boundary
`modules/spatial-core/**` → `@deadlock-query/spatial-core` (ESM; no DOM/Node-only APIs; `three` is a dependency only because three-mesh-bvh operates on `BufferGeometry` — no renderer is ever created).

**Owner-authored area:** `src/semantics/**` is listed in `CODEOWNERS` (owner review required) and agents must **not** implement or edit function bodies there. Agents may edit only `src/semantics/index.ts` wiring, the `.d.ts`-visible signatures **after owner agreement**, and the test harness (`test/semantics/**`).

## 3. Published surface (Phase 2)

**Backend (agent-owned)**
```ts
interface Raycaster {                                 // backend-agnostic; implemented over three-mesh-bvh
  raycastFirst(origin: Vec3, dir: Vec3, opts?: {max?: number, backfaces?: boolean}): Hit | null
  raycastAll(origin, dir, opts?): Hit[]
  occluded(a: Vec3, b: Vec3): boolean                // segment test
  closestPoint(p: Vec3, opts?: {maxDist?: number}): { point: Vec3, normal: Vec3, distance: number, triIndex: number } | null
  sphereCast / capsuleCast(shape, from, to): Hit | null   // via shapecast
  overlapsSphere / overlapsCapsule(shape): boolean
  bounds: Aabb
}
Raycaster.fromGeometry(positions, indices) · Raycaster.deserialize(bytes) · serialize(): ArrayBuffer   // deterministic bytes
```
- `SampleGrid`: generic 2-D grid over the map bounds with named float/uint8 channels; `build(raycaster, bounds, cellSize, channels: Record<string, (cell: CellCtx) => number>)`, `get(channel, p)`, `serialize/deserialize`. Includes the built-in `floorHeight` channel (downward ray) and accepts **owner functions** as channel generators (e.g. `interior`, `wallDistance`).
- `NavMesh`: `load(bytes)` (Recast export, format spec in contracts), `findPath`, `nearestPoint`, **`distanceField(sources, movementModel)`** (multi-source Dijkstra over the polygon graph; `costAt(p)`), `Links` (ziplines/jump links from entities/metadata), `MovementModel{ speed, linkSpeeds }`, override application (blocked polygons, added links, cost multipliers).
- Math helpers: `Vec3`, `Aabb`, segments/polygons, plain typed-array code.

**Owner-authored (`src/semantics/`)** — signatures stable, bodies written by the owner:
```ts
isInterior(rc: Raycaster, p: Vec3, params: SemanticsParams): boolean
isVisible(rc: Raycaster, from: Vec3, to: Vec3, params: SemanticsParams): boolean
nearestWall(rc: Raycaster, p: Vec3, params: SemanticsParams): { point: Vec3, normal: Vec3, distance: number } | null
// future: isHighGround, isWalkableSpot, hasLineOfFire ... (added by the owner as needed)
SemanticsParams = { eyeHeight, targetHeight, maxRange, wallMinSlope, ... }  // documented defaults live in semantics/params.ts (owner)
```
Until the owner replaces them, each function ships as a **clearly-marked placeholder** (`PLACEHOLDER_SEMANTICS` flag in results metadata; first-hit/segment-test naive version) so the rest of the pipeline can be developed and tested end-to-end; the placeholder is **never** presented as final in the UI (builder shows a "provisional semantics" banner when the flag is set).

## 4. Uses
`contracts` (type aliases, baked-format specs, `Space`). `three` + `three-mesh-bvh` (spike S5 confirms versions). `recast-navigation` is **not** a dependency here (extractor only).

## 5. Technical design
- **Why three-mesh-bvh** (IMPLEMENTATION_PLAN D15): best-in-class static-triangle BVH raycast/shapecast in JS, serialisable, Worker/Bun-friendly; a physics engine (Rapier/Jolt) adds WASM weight and simulation features not needed for static queries. The `Raycaster` interface keeps it swappable; a Rapier-backed implementation can be added later for capsule-movement simulation.
- Float32 geometry; one BVH per bundle built at bake time and loaded via `deserialize` (no rebuild in the browser). Multiple geometries (static collision layers, e.g. "world" vs "vision-blockers") supported via named `Raycaster`s.
- **Throughput**: batch APIs (`raycastFirstMany(origins, dirs) → Float32Array`) to avoid per-call allocation; reusable `Hit` buffers; all long operations accept `{ signal, onProgress }`.
- **Determinism**: same input → byte-identical serialisation (bundle hashing, caching).
- **Semantics test harness** (agent-owned, owner fills expectations): `test/semantics/cases.json` — labelled probe points/pairs on the contracts fixture (window wall, closed room, ledge, open sky) with `expected` left `null` for the owner to fill; harness reports pass/fail/unlabelled. This lets the owner define behaviour by example, and gives the bake/library a regression net.
- Benchmarks tracked in `STATE.md`: BVH build, deserialise, 100 k rays, capsule shapecast, Dijkstra from 30 sources over 50 k polygons.

## 6. Milestones
| # | Deliverable | Acceptance |
|---|---|---|
| **S5** (spike, first) | Benchmark three-mesh-bvh in Bun + Worker (build, serialise, deserialise, rays, capsule shapecast) on 1 M triangles | Gates: build < 5 s (Bun), 100 k first-hit < 300 ms (Worker), deserialise < 500 ms; else fallback ADR |
| M0 | Scaffold, math, `Raycaster` interface + three-mesh-bvh impl, serialise/deserialise, tests | `verify` green; round-trip determinism test |
| M1 | Batch/shape APIs (segment occlusion, closest point, sphere/capsule casts), brute-force oracle tests | Property tests vs. brute force |
| M2 | `semantics/` scaffold: signatures, `SemanticsParams`, **placeholder** implementations, CODEOWNERS entry, `cases.json` + harness | Harness runs; placeholders flagged; owner can replace bodies without touching other files |
| M3 | `SampleGrid` with owner-function channels + `floorHeight` | Fixture grid round-trips; cost report |
| M4 | `NavMesh` load + pathfinding + distance fields + links + overrides | Paths match hand-computed fixture routes; budgets met |
| M5 | Hardening: cancellation/progress, SAB-ready buffers, docs & examples for writing semantics functions | Docs have a worked example (`isVisible`) that the owner can copy |

**Owner milestone (not an agent task):** write `semantics/*` bodies and fill `cases.json` expectations — target before extractor bake M4 and query-library M3.

## 7. Test strategy
Oracle tests vs. brute-force triangle loops; golden binary round-trips; benchmarks; semantics harness (owner-labelled cases).

## 8. Standalone mode
`bun test` using contracts fixtures (mini-map collision) — no game data needed.

## 9. Risks & open questions
- three-mesh-bvh API/bundle-size changes → pin version; wrapper isolates callers.
- Collision mesh may include non-gameplay clutter or lack vision-blocking volumes; separate "vision" geometry layer may be needed (extractor request).
- Memory for million-triangle BVHs in browser workers.
- Owner-authored semantics are a schedule dependency for headline query 3 and baked grid channels.

## 10. Definition of done
Backend + grid + navmesh implemented with oracle tests and benchmarks recorded; `semantics/` placeholder → owner-written versions in place with filled `cases.json`; extractor bake and query-library use them unchanged.
