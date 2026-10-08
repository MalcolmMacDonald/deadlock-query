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

test("radius keeps funnel corners off portal ends; walkable follows the mesh", () => {
  // L-shaped: three squares east, then two squares north from the last one.
  const vertices = new Float32Array([0,0,0, 10,0,0, 20,0,0, 30,0,0, 0,10,0, 10,10,0, 20,10,0, 30,10,0, 20,20,0, 30,20,0, 20,30,0, 30,30,0])
  const quads = [[0,1,5,4],[1,2,6,5],[2,3,7,6],[6,7,9,8],[8,9,11,10]]
  const nm = NavMesh.fromPolygons({ vertices, offsets: new Uint32Array([0,4,8,12,16,20]), indices: new Uint32Array(quads.flat()) })
  const plain = nm.findPath([2, 2, 0], [28, 28, 0], walk)!
  const wide = nm.findPath([2, 2, 0], [28, 28, 0], walk, { radius: 2 })!
  expect(wide.cost).toBe(plain.cost)
  expect(wide.polys).toEqual(plain.polys)
  // The plain path bends at the inner corner vertex (20,10); the wide one keeps 2 units away from it.
  const corner = (pts: readonly (readonly number[])[]) => Math.min(...pts.map((q) => Math.hypot(q[0]! - 20, q[1]! - 10)))
  expect(corner(plain.points)).toBeLessThan(1e-3)
  expect(corner(wide.points)).toBeGreaterThan(1.5)
  expect(nm.findPath([2, 2, 0], [28, 28, 0], walk, { radius: 100 })!.polys).toEqual(plain.polys)
  expect(nm.walkable([2, 5, 0], [28, 5, 0])).toBe(true)
  expect(nm.walkable([2, 5, 0], [2, 28, 0], { tol: 1 })).toBe(false)
  expect(nm.walkable([25, 2, 0], [25, 28, 0])).toBe(true)
})

test("added polygons join the mesh along shared vertices and take indices after the base polygons", () => {
  const base = NavMesh.fromPolygons(corridor(5))
  const ext = base.withOverrides({ addedPolygons: [[[50, 0, 0], [60, 0, 0], [60, 10, 0], [50, 10, 0]]] })
  expect(ext.polyCount).toBe(6)
  expect(ext.addedPolyStart).toBe(5)
  expect(base.polyCount).toBe(5)
  const p = ext.findPath([5, 5, 0], [55, 5, 0], walk)!
  expect(p.polys).toEqual([0, 1, 2, 3, 4, 5])
  expect(p.cost).toBeCloseTo(5)
  // Overrides replace rather than stack, and the base polygons are not duplicated.
  expect(ext.withOverrides({ blockedPolys: [2] }).polyCount).toBe(5)
  // A disjoint polygon is only reachable through an added link.
  const island = base.withOverrides({ addedPolygons: [[[100, 0, 0], [110, 0, 0], [110, 10, 0], [100, 10, 0]]] })
  expect(island.findPath([5, 5, 0], [105, 5, 0], { speed: 10, linkSpeeds: { bridge: 10 } })).toBeNull()
  const linked = base.withOverrides({ addedPolygons: [[[100, 0, 0], [110, 0, 0], [110, 10, 0], [100, 10, 0]]], addedLinks: [{ from: [45, 5, 0], to: [105, 5, 0], kind: "bridge" }] })
  expect(linked.findPath([5, 5, 0], [105, 5, 0], { speed: 10, linkSpeeds: { bridge: 10 } })!.cost).toBeCloseTo(10)
  expect(() => base.withOverrides({ addedPolygons: [[[0, 0, 0], [1, 0, 0]]] })).toThrow()
})

test("a link cost is a fixed travel time and needs no speed for its kind", () => {
  const base = NavMesh.fromPolygons(corridor(5))
  const link = { from: [5, 5, 0] as const, to: [45, 5, 0] as const, kind: "zipline", cost: 0.25 }
  const nm = base.withOverrides({ addedLinks: [link] })
  expect(nm.findPath([5, 5, 0], [45, 5, 0], walk)!.cost).toBeCloseTo(0.25) // 40 units would take 4 s on foot; kind is not in linkSpeeds
  expect(nm.distanceField([[5, 5, 0]], walk).costs[4]).toBeCloseTo(0.25)
  expect(nm.findPath([5, 5, 0], [45, 5, 0], { speed: 10, linkSpeeds: { zipline: 0 } })!.cost).toBeCloseTo(4) // speed 0 switches the kind off
  expect(nm.findPath([45, 5, 0], [5, 5, 0], walk)!.cost).toBeCloseTo(0.25) // bidirectional by default
  expect(base.withOverrides({ addedLinks: [{ ...link, bidirectional: false }] }).findPath([45, 5, 0], [5, 5, 0], walk)!.cost).toBeCloseTo(4)
  // The slower of two links is not preferred and the heuristic stays admissible (A* equals Dijkstra).
  const two = base.withOverrides({ addedLinks: [{ ...link, cost: 2 }, { from: [15, 5, 0], to: [45, 5, 0], kind: "zipline", cost: 0.1 }] })
  expect(two.findPath([5, 5, 0], [45, 5, 0], walk)!.cost).toBeCloseTo(two.distanceField([[5, 5, 0]], walk).costAt([45, 5, 0]), 6)
})

test("walkExact follows the polygons and stops at walls and blocked polygons", () => {
  const nm = NavMesh.fromPolygons(corridor(5))
  expect(nm.walkExact([5, 5, 0], [45, 5, 0])).toBe(true)
  expect(nm.walkExact([5, 2, 0], [45, 8, 0])).toBe(true) // diagonal through every polygon
  expect(nm.walkExact([5, 5, 0], [45, 15, 0])).toBe(false) // leaves through the side wall
  expect(nm.walkExact([5, 5, 0], [55, 5, 0])).toBe(false) // runs off the end
  expect(nm.walkExact([5, 5, 0], [5, 5, 0])).toBe(true)
  expect(nm.withOverrides({ blockedPolys: [2] }).walkExact([5, 5, 0], [45, 5, 0])).toBe(false)
  expect(nm.walkExact([5, 5, 100], [45, 5, 100])).toBe(false) // nowhere near the mesh in Z
  // Mesh height must follow the segment: a ramp up to z=100 is not walkable along a flat segment.
  const ramp = NavMesh.fromPolygons({ vertices: new Float32Array([0, 0, 0, 100, 0, 100, 100, 10, 100, 0, 10, 0]), offsets: new Uint32Array([0, 4]), indices: new Uint32Array([0, 1, 2, 3]) })
  expect(ramp.walkExact([5, 5, 5], [95, 5, 95])).toBe(true)
})

test("walkExact agrees with a dense-sample oracle on random segments over a mesh with holes", () => {
  const n = 12
  const vertices = new Float32Array((n + 1) * (n + 1) * 3)
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.set([i * 10, j * 10, 0], (j * (n + 1) + i) * 3)
  const indices: number[] = [], offsets = [0]
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if ((i * 7 + j * 13) % 5 === 0) continue // holes
    const a = j * (n + 1) + i
    indices.push(a, a + 1, a + n + 2, a + n + 1); offsets.push(indices.length)
  }
  const nm = NavMesh.fromPolygons({ vertices, offsets: new Uint32Array(offsets), indices: new Uint32Array(indices) })
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
  let agree = 0, total = 0, trues = 0
  for (let k = 0; k < 400; k++) {
    const a: [number, number, number] = [rnd() * 120, rnd() * 120, 0], b: [number, number, number] = [a[0] + (rnd() - 0.5) * 60, a[1] + (rnd() - 0.5) * 60, 0]
    const onMesh = (p: readonly number[]) => nm.nearestPoint([p[0]!, p[1]!, 0], { maxDist: 1e-6 }) !== null
    if (!onMesh(a)) continue
    let oracle = true
    for (let i = 0; i <= 600 && oracle; i++) oracle = onMesh([a[0] + ((b[0] - a[0]) * i) / 600, a[1] + ((b[1] - a[1]) * i) / 600])
    total++; trues += oracle ? 1 : 0
    if (nm.walkExact(a, b) === oracle) agree++
  }
  expect(total).toBeGreaterThan(100)
  expect(trues).toBeGreaterThan(10)
  expect(trues).toBeLessThan(total - 10)
  // Dense sampling can step over a hole corner, so allow a sliver of disagreement.
  expect(agree / total).toBeGreaterThan(0.97)
})

test("findPath radius keeps a smoothed path off an open border, not only off portal ends", () => {
  const nm = NavMesh.fromPolygons(corridor(5))
  const near = nm.findPath([5, 5, 0], [45, 5, 0], walk, { radius: 4 })!
  expect(near.points).toEqual([[5, 5, 0], [45, 5, 0]]) // already 5 from both walls: untouched
  // Hugging the y=0 wall: start and end are 1 from it, the middle must be pushed out to the radius.
  const hug = nm.findPath([5, 1, 0], [45, 1, 0], walk, { radius: 4 })!
  expect(hug.polys).toEqual([0, 1, 2, 3, 4])
  expect(hug.points.length).toBeGreaterThan(2)
  expect(Math.max(...hug.points.map((q) => q[1]))).toBeGreaterThanOrEqual(3.9)
  for (const q of hug.points) expect(q[1]).toBeLessThanOrEqual(10)
  expect(nm.findPath([5, 1, 0], [45, 1, 0], walk)!.points).toEqual([[5, 1, 0], [45, 1, 0]])
})
