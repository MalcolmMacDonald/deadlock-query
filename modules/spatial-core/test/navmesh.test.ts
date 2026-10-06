import { expect, test } from "bun:test"
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
