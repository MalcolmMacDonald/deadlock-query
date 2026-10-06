# Writing Semantics Functions

This document explains how to implement spatial-semantic functions in `src/semantics/`. The functions here are **owner-authored** and define the map-specific behavior for visibility, interior detection, and other spatial predicates.

## Architecture

Semantics functions take a `Raycaster` (the static-geometry ray/shape query backend) and produce boolean or geometric results. They are used by:

- **Query library** — user queries like `isVisible(point, target)` as library methods
- **Sample grid** — custom channels for map metadata (e.g. `interior` flag per grid cell)
- **Bake pipeline** — offline generation of cached metadata in the map bundle

## Function Signatures

All functions receive a `Raycaster` (backend-agnostic, operates on baked collision) and `SemanticsParams` (configurable thresholds):

```ts
// src/semantics/index.ts
export function isInterior(rc: Raycaster, p: Vec3, params: SemanticsParams): boolean
export function isVisible(rc: Raycaster, from: Vec3, to: Vec3, params: SemanticsParams): boolean
export function nearestWall(rc: Raycaster, p: Vec3, params: SemanticsParams): { point: Vec3, normal: Vec3, distance: number } | null
```

**Extension:** Add custom functions here as the query library grows (e.g. `isHighGround`, `isWalkableSpot`). The test harness accepts cases for each function.

## Parameters

`SemanticsParams` defines configurable thresholds, documented in `src/semantics/params.ts`:

```ts
export interface SemanticsParams {
  eyeHeight: number           // Height offset of the "eye" (e.g. player camera) above ground
  targetHeight: number        // Height offset of the target (e.g. aim point)
  maxRange: number            // Max range for visibility checks (e.g. ability range in units)
  wallMinSlope: number        // Min slope (degrees) to count as a "wall" (vs. floor/ceiling)
  interiorCeiling: number     // Max distance upward to still be "indoors"
}
```

Defaults are reasonable for Deadlock gameplay; see `params.ts` for values.

## Worked Example: `isVisible`

This example shows how to implement a line-of-sight check, accounting for cover and range:

```ts
/**
 * True if there is an unobstructed line-of-sight from `from` to `to`.
 * 
 * Implementation:
 * 1. Adjust for eye and target heights: `from` is the eye position (origin + eyeHeight),
 *    `to` is adjusted by targetHeight.
 * 2. Check range: abandon if distance > maxRange.
 * 3. Perform a segment test (raycaster.occluded) from eye to target.
 * 4. If fully occluded, false; if clear, true.
 *
 * This is a **simplified LOS**:
 * - Does not account for dynamic game entities (only static collision).
 * - Assumes a straight line (does not trace down to floor/wall corners for peeks).
 * - Culls at maxRange (ability range, not player knowledge).
 */
export function isVisible(rc: Raycaster, from: Vec3, to: Vec3, params: SemanticsParams): boolean {
  const eyePos: Vec3 = [from[0], from[1], from[2] + params.eyeHeight]
  const targetPos: Vec3 = [to[0], to[1], to[2] + params.targetHeight]
  
  // Check range
  const dx = targetPos[0] - eyePos[0], dy = targetPos[1] - eyePos[1], dz = targetPos[2] - eyePos[2]
  const dist = Math.hypot(dx, dy, dz)
  if (dist > params.maxRange) return false
  
  // Segment test: true if nothing blocks the ray
  return !rc.occluded(eyePos, targetPos)
}
```

## Testing Your Implementation

Place test cases in `test/semantics/cases.json`. Each case specifies a probe location/pair and expected result:

```json
{
  "cases": [
    {
      "name": "open_area",
      "type": "visibility",
      "from": [100, 200, 0],
      "to": [150, 250, 0],
      "expected": true
    },
    {
      "name": "blocked_by_wall",
      "type": "visibility",
      "from": [100, 200, 0],
      "to": [100, 300, 0],
      "expected": false,
      "note": "wall between x=200 and x=250"
    }
  ]
}
```

Run tests with:
```bash
bun run verify  # includes test/semantics.test.ts
```

Unlabelled cases (`expected: null`) are preserved for you to fill in after spot-checking the actual map; this prevents the harness from enforcing placeholder behavior.

## Notes on the Raycaster

The `Raycaster` interface provides:

- **`raycastFirst(origin, dir, opts?)`** — first hit along a ray; use for simple LOS
- **`occluded(a, b)`** — segment test; true if a line from a→b hits any triangle
- **`closestPoint(p, opts?)`** — nearest point on collision, distance, triangle index
- **`overlapsSphere(shape)`** / **`overlapsCapsule(shape)`** — shape/geometry overlap tests
- **`raycastFirstMany(origins, dirs)`** — batch rays for grid generation
- **`bounds: Aabb`** — geometry bounds (for range checks, culling)

All methods are **deterministic** and carry no state; they're safe to call from workers.

## Cancellation & Progress

When running on large grids or expensive semantic channels, pass `AbortSignal` and `onProgress` callbacks to `SampleGrid.build()`:

```ts
const controller = new AbortController()
const grid = SampleGrid.build(rc, bounds, cellSize, {
  interior: (cell) => isInterior(rc, [cell.x, cell.y, cell.floorZ ?? 0], params)
}, {
  signal: controller.signal,
  onProgress: (done, total) => console.log(`${done}/${total} cells`)
})
```

Abort a long-running grid build by calling `controller.abort()`.

## SAB (SharedArrayBuffer) Readiness

Serialised geometry (raycaster buffers) and grids are **zero-copy**: the buffer backing is never mutated after creation. This makes them safe to pass to workers via `SharedArrayBuffer`:

```ts
// Bake thread
const raycaster = Raycaster.fromGeometry(positions, indices)
const bytes = raycaster.serialize()  // frozen buffer

// Main thread
const sab = new SharedArrayBuffer(bytes.byteLength)
new Uint8Array(sab).set(new Uint8Array(bytes))
worker.postMessage({ geometryBuffer: sab })

// Worker thread
const raycaster = Raycaster.deserialize(geometryBuffer)  // zero-copy
```

## Placeholders

Until you implement these functions, a `PLACEHOLDER_SEMANTICS` flag marks results as provisional:

```ts
// src/semantics/index.ts excerpt
const PLACEHOLDER_SEMANTICS = true

export function isVisible(...): boolean {
  // naive first-hit raycast (not realistic, just for testing)
  return !rc.occluded(from, to)
}
```

The query builder will show a "provisional semantics" banner while placeholders are in use. Remove the flag when you've written real implementations.

## Common Pitfalls

1. **Forgetting to offset by `eyeHeight` / `targetHeight`** — geometry is floor-level; "eye position" is some distance above.
2. **Ignoring `maxRange`** — query results should not leak beyond an ability's range, even if LOS is clear.
3. **Using the raycaster on the main thread during bake** — raycasts on large collision can be slow; do them in a worker or bake offline.
4. **Not testing on the real map** — synthetic test cases may not cover edge cases (stairs, tight geometry, overhangs).
