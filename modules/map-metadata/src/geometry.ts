import type { Vec3 } from "@deadlock-query/contracts"

/** Polygon helpers on the ground plane (x, y); Z is ignored. Pure and allocation-light: they also run in the submit worker. */

const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

/** Segments cross at a single interior point of both (touching endpoints and collinear overlaps do not count). */
export const segmentsCross = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean => {
  const d1 = cross(c[0], c[1], d[0], d[1], a[0], a[1])
  const d2 = cross(c[0], c[1], d[0], d[1], b[0], b[1])
  const d3 = cross(a[0], a[1], b[0], b[1], c[0], c[1])
  const d4 = cross(a[0], a[1], b[0], b[1], d[0], d[1])
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** Segments share at least one point (crossing, touching or overlapping). */
const segmentsTouch = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean => {
  if (segmentsCross(a, b, c, d)) return true
  const on = (p: Vec3, q: Vec3, r: Vec3) =>
    cross(p[0], p[1], q[0], q[1], r[0], r[1]) === 0 &&
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1])
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)
}

/**
 * First pair of non-adjacent edges that touch, as vertex indices of the edge starts, or `undefined` for a simple ring.
 * A repeated vertex shows up as two touching edges, so duplicates are caught too. O(n^2); rings are capped at 512.
 */
export const firstSelfIntersection = (ring: ReadonlyArray<Vec3>): readonly [number, number] | undefined => {
  const n = ring.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue
      if (segmentsTouch(ring[i]!, ring[(i + 1) % n]!, ring[j]!, ring[(j + 1) % n]!)) return [i, j]
    }
  }
  return undefined
}

/** Consecutive equal vertices (including last == first), as the index of the first of the pair. */
export const firstRepeatedVertex = (ring: ReadonlyArray<Vec3>): number | undefined => {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    if (a[0] === b[0] && a[1] === b[1]) return i
  }
  return undefined
}

/** Even-odd point-in-polygon test. */
export const pointInRing = (x: number, y: number, ring: ReadonlyArray<Vec3>): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** Two simple rings share area: an edge pair crosses, or one lies inside the other. */
export const ringsOverlap = (a: ReadonlyArray<Vec3>, b: ReadonlyArray<Vec3>): boolean => {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true
    }
  }
  // No edges cross: one ring lies inside the other (or they coincide). Vertex centroids settle the boundary cases.
  const centre = (r: ReadonlyArray<Vec3>): readonly [number, number] =>
    [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]
  const [ax, ay] = centre(a), [bx, by] = centre(b)
  return pointInRing(a[0]![0], a[0]![1], b) || pointInRing(b[0]![0], b[0]![1], a) || pointInRing(ax, ay, b) || pointInRing(bx, by, a)
}

export const distance2d = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1])
