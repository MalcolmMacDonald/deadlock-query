import type { Vec3 } from "@deadlock-query/contracts"

/** Left and right ends of a portal (edge crossed between two polygons), seen along the direction of travel. */
export type Portal = readonly [left: Vec3, right: Vec3]

/** (a - o) x (b - o) in the XY plane: > 0 when b is counter-clockwise (to the left) of a as seen from o. */
const cross = (o: Vec3, a: Vec3, b: Vec3) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
const same = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < 1e-8

/**
 * Shortest path through a corridor of portals (simple stupid funnel algorithm, decided in the XY plane;
 * corner points keep the Z of the portal vertex they sit on). The path starts at `start`, bends only at
 * portal ends and finishes at `end`. No clearance is kept: corners are exactly the portal vertices.
 */
export function funnelPath(start: Vec3, end: Vec3, portals: readonly Portal[]): Vec3[] {
  const P: Portal[] = [[start, start], ...portals, [end, end]]
  const out: Vec3[] = [start]
  let apex = start, left = start, right = start
  let leftIdx = 0, rightIdx = 0
  for (let i = 1; i < P.length; i++) {
    const [l, r] = P[i]!
    // Tighten the right side.
    if (cross(apex, right, r) >= 0) {
      if (same(apex, right) || cross(apex, left, r) < 0) { right = r; rightIdx = i }
      else {
        out.push(left); apex = left; right = left
        i = rightIdx = leftIdx; continue
      }
    }
    // Tighten the left side.
    if (cross(apex, left, l) <= 0) {
      if (same(apex, left) || cross(apex, right, l) > 0) { left = l; leftIdx = i }
      else {
        out.push(right); apex = right; left = right
        i = leftIdx = rightIdx; continue
      }
    }
  }
  if (!same(out[out.length - 1]!, end)) out.push(end)
  return out
}
