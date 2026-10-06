import { expect, test } from "bun:test"
import { Triangle, Vector3 } from "three"
import { NavMesh, type NavMeshData } from "../src/index.ts"

/** `n` unit-10 squares in a row along +X at z=0. Polygon i spans x in [10i, 10i+10]. */
const corridor = (n: number): NavMeshData => {
  const vertices = new Float32Array((n + 1) * 2 * 3)
  for (let i = 0; i <= n; i++) vertices.set([i * 10, 0, 0, i * 10, 10, 0], i * 6)
  const indices = new Uint32Array(n * 4), offsets = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) { indices.set([i * 2, i * 2 + 2, i * 2 + 3, i * 2 + 1], i * 4); offsets[i + 1] = (i + 1) * 4 }
  return { vertices, offsets, indices }
}
const walk = { speed: 10 }

test("nearestPoint snaps to the mesh", () => {
  const nm = NavMesh.fromPolygons(corridor(5))
  expect(nm.polyCount).toBe(5)
  const r = nm.nearestPoint([25, 5, 30])!
  expect(r.poly).toBe(2)
  expect(r.point).toEqual([25, 5, 0])
  expect(r.distance).toBeCloseTo(30)
  expect(nm.nearestPoint([25, 5, 30], { maxDist: 10 })).toBeNull()
})

test("findPath matches the hand-computed corridor route", () => {
  const nm = NavMesh.fromPolygons(corridor(5))
  const p = nm.findPath([5, 5, 0], [45, 5, 0], walk)!
  expect(p.polys).toEqual([0, 1, 2, 3, 4])
  expect(p.cost).toBeCloseTo(4) // 40 units at 10 u/s
  expect(p.points).toEqual([[5, 5, 0], [45, 5, 0]]) // funnel-smoothed: a straight corridor is a straight line
  expect(nm.findPath([5, 5, 0], [45, 5, 0], walk, { smooth: false })!.points.map((q) => q[0])).toEqual([5, 10, 20, 30, 40, 45])
  expect(nm.withOverrides({ blockedPolys: [2] }).findPath([5, 5, 0], [45, 5, 0], walk)).toBeNull()
})

test("links, cost multipliers and distance fields", () => {
  const base = NavMesh.fromPolygons(corridor(5))
  const zip = { from: [5, 5, 0] as const, to: [45, 5, 0] as const, kind: "zipline" }
  const nm = NavMesh.fromPolygons(corridor(5), [zip])
  const m = { speed: 10, linkSpeeds: { zipline: 40 } }
  expect(nm.findPath([5, 5, 0], [45, 5, 0], m)!.cost).toBeCloseTo(1) // 40 units at 40 u/s
  expect(nm.findPath([5, 5, 0], [45, 5, 0], walk)!.cost).toBeCloseTo(4) // link unusable without a speed
  const f = base.distanceField([[5, 5, 0]], walk)
  expect(Array.from(f.costs)).toEqual([0, 1, 2, 3, 4].map((c) => expect.closeTo(c) as unknown as number))
  expect(f.costAt([35, 5, 0])).toBeCloseTo(3)
  const both = base.distanceField([[5, 5, 0], [45, 5, 0]], walk)
  expect(both.costAt([25, 5, 0])).toBeCloseTo(2)
  const slow = base.withOverrides({ costMultipliers: { 1: 3 } }).distanceField([[5, 5, 0]], walk)
  expect(slow.costs[1]).toBeCloseTo(3)
  const added = base.withOverrides({ addedLinks: [zip] }).distanceField([[5, 5, 0]], m)
  expect(added.costs[4]).toBeCloseTo(1)
})

test("serialise round-trips with links", () => {
  const zip = { from: [5, 5, 0] as const, to: [45, 5, 0] as const, kind: "zipline" }
  const nm = NavMesh.fromPolygons(corridor(5), [zip])
  const bytes = nm.serialize()
  const back = NavMesh.load(bytes)
  expect(Buffer.from(back.serialize()).equals(Buffer.from(bytes))).toBe(true)
  expect(back.findPath([5, 5, 0], [45, 5, 0], { speed: 10, linkSpeeds: { zipline: 40 } })!.cost).toBeCloseTo(1)
})

/** Brute-force reference for `nearestPoint`: closest point over every fan triangle, first polygon wins ties. */
const bruteNearest = (d: NavMeshData, p: readonly [number, number, number]) => {
  const tri = new Triangle(), t = new Vector3(), q = new Vector3(...p)
  let bd = Infinity, bp = -1
  for (let poly = 0; poly < d.offsets.length - 1; poly++) {
    const s = d.offsets[poly]!, e = d.offsets[poly + 1]!
    for (let k = s + 1; k + 1 < e; k++) {
      tri.a.fromArray(d.vertices, d.indices[s]! * 3); tri.b.fromArray(d.vertices, d.indices[k]! * 3); tri.c.fromArray(d.vertices, d.indices[k + 1]! * 3)
      tri.closestPointToPoint(q, t)
      const dd = t.distanceTo(q)
      if (dd < bd) { bd = dd; bp = poly }
    }
  }
  return { poly: bp, distance: bd }
}

/** Two stacked `n`x`n` grids of quads (z=0 and z=300) with a few large polygons mixed in, for index tests. */
const stacked = (n: number): NavMeshData => {
  const vertices: number[] = [], indices: number[] = [], offsets = [0]
  for (const z of [0, 300]) {
    const base = vertices.length / 3
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push(i * 10, j * 10, z + (i * 7 + j * 13) % 5)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = base + j * (n + 1) + i
      if ((i * 31 + j * 17) % 11 === 0) continue // holes
      indices.push(a, a + 1, a + n + 2, a + n + 1); offsets.push(indices.length)
    }
  }
  return { vertices: new Float32Array(vertices), offsets: new Uint32Array(offsets), indices: new Uint32Array(indices) }
}

test("nearestPoint index agrees with a brute-force scan on stacked floors", () => {
  const data = stacked(30), nm = NavMesh.fromPolygons(data)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  for (let i = 0; i < 400; i++) {
    // Includes points far outside the mesh footprint and between the floors.
    const p: [number, number, number] = [rnd() * 500 - 100, rnd() * 500 - 100, rnd() * 500 - 100]
    const want = bruteNearest(data, p), got = nm.nearestPoint(p)!
    expect(got.distance).toBeCloseTo(want.distance, 3)
    expect(got.poly).toBe(want.poly)
  }
})

test("nearestPoint maxDist, empty meshes and shared index across overrides", () => {
  const nm = NavMesh.fromPolygons(corridor(5))
  expect(nm.nearestPoint([1e6, 1e6, 0], { maxDist: 100 })).toBeNull()
  expect(nm.nearestPoint([1e6, 5, 0])!.poly).toBe(4)
  expect(nm.withOverrides({ blockedPolys: [2] }).nearestPoint([25, 5, 30])!.poly).toBe(2) // blocking does not hide polygons from snapping
  const empty = NavMesh.fromPolygons({ vertices: new Float32Array(0), offsets: new Uint32Array([0]), indices: new Uint32Array(0) })
  expect(empty.nearestPoint([0, 0, 0])).toBeNull()
})

/** Squares of side 10 placed at the given integer cells (x, y); CCW, vertices shared by position. */
const cells = (at: ReadonlyArray<readonly [number, number]>, flip = false): NavMeshData => {
  const vid = new Map<string, number>(), vertices: number[] = [], indices: number[] = [], offsets = [0]
  const v = (x: number, y: number) => {
    const k = `${x},${y}`
    if (!vid.has(k)) { vid.set(k, vertices.length / 3); vertices.push(x * 10, y * 10, 0) }
    return vid.get(k)!
  }
  for (const [x, y] of at) {
    const q = [v(x, y), v(x + 1, y), v(x + 1, y + 1), v(x, y + 1)]
    indices.push(...(flip ? q.reverse() : q)); offsets.push(indices.length)
  }
  return { vertices: new Float32Array(vertices), offsets: new Uint32Array(offsets), indices: new Uint32Array(indices) }
}

test("funnel bends at the inner corner of an L-shaped corridor, for either winding", () => {
  for (const flip of [false, true]) {
    const nm = NavMesh.fromPolygons(cells([[0, 0], [1, 0], [1, 1]], flip))
    const p = nm.findPath([2, 2, 0], [12, 18, 0], walk)!
    expect(p.polys).toEqual([0, 1, 2])
    expect(p.points).toEqual([[2, 2, 0], [10, 10, 0], [12, 18, 0]])
    expect(nm.findPath([12, 18, 0], [2, 2, 0], walk)!.points).toEqual([[12, 18, 0], [10, 10, 0], [2, 2, 0]])
  }
})

test("funnel path routes through a link's end points", () => {
  const zip = { from: [8, 2, 0] as const, to: [42, 8, 0] as const, kind: "zipline" }
  const nm = NavMesh.fromPolygons(corridor(5), [zip])
  const p = nm.findPath([5, 5, 0], [45, 5, 0], { speed: 10, linkSpeeds: { zipline: 40 } })!
  expect(p.polys).toEqual([0, 4])
  expect(p.points).toEqual([[5, 5, 0], [8, 2, 0], [42, 8, 0], [45, 5, 0]])
})

test("smoothed paths are never longer than midpoint paths and stay on the mesh", () => {
  // 16x16 flat grid with a comb of walls, so shortest paths have to bend around several corners.
  const open: [number, number][] = []
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (!(x % 4 === 2 && y < 12) && !(x === 9 && y > 3)) open.push([x, y])
  const nm = NavMesh.fromPolygons(cells(open))
  const len = (pts: readonly (readonly number[])[]) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(q[0]! - pts[i]![0]!, q[1]! - pts[i]![1]!), 0)
  let seed = 99, bends = 0
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  for (let i = 0; i < 60; i++) {
    const a = nm.nearestPoint([rnd() * 160, rnd() * 160, 0])!.point, b = nm.nearestPoint([rnd() * 160, rnd() * 160, 0])!.point
    const smooth = nm.findPath(a, b, walk), mid = nm.findPath(a, b, walk, { smooth: false })
    if (!smooth || !mid) { expect(smooth).toBe(mid); continue }
    expect(len(smooth.points)).toBeLessThanOrEqual(len(mid.points) + 1e-3)
    if (smooth.points.length > 2) bends++
    for (let s = 0; s + 1 < smooth.points.length; s++) for (let t = 0; t <= 10; t++) {
      const u = smooth.points[s]!, w = smooth.points[s + 1]!, f = t / 10
      expect(nm.nearestPoint([u[0] + (w[0] - u[0]) * f, u[1] + (w[1] - u[1]) * f, 0])!.distance).toBeLessThan(1e-3)
    }
  }
  expect(bends).toBeGreaterThan(10)
})
