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
  expect(p.points.map((q) => q[0])).toEqual([5, 10, 20, 30, 40, 45])
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
