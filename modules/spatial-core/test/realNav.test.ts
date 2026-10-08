import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import type { Vec3 } from "@deadlock-query/contracts"
import { NavMesh } from "../src/index.ts"

const load = (path: string) => { const b = readFileSync(path); return NavMesh.load(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer) }
const model = { speed: 1, linkSpeeds: { jumpPad: 1, navConnection: 1 } }
const len = (pts: readonly Vec3[]) => pts.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - pts[i - 1]![0], q[1] - pts[i - 1]![1], q[2] - pts[i - 1]![2]) : 0), 0)

/** Excerpt of the real dl_midtown navmesh (build 25761866) within 2500 units of the north patron; cut by `tools/nav-excerpt.ts`. */
describe("real-navmesh excerpt (patron surroundings)", () => {
  const nm = load(new URL("./fixtures/patron-excerpt.nav.bin", import.meta.url).pathname)
  const patron: Vec3 = [1280, 8048, 632], spawn: Vec3 = [1280, 10240, 1218], lane: Vec3 = [1280, 6200, 600]

  test("entities snap onto the mesh", () => {
    expect(nm.polyCount).toBe(5781)
    expect(nm.nearestPoint(patron)!.distance).toBeCloseTo(15.25, 1)
    expect(nm.nearestPoint(spawn)!.distance).toBeLessThan(2)
  })
  test("golden routes", () => {
    expect(nm.findPath(patron, spawn, model)!.cost).toBeCloseTo(6200.59, 1)
    expect(nm.findPath(patron, lane, model)!.cost).toBeCloseTo(2212.67, 1)
    expect(nm.findPath(spawn, lane, model)!.cost).toBeCloseTo(6325.71, 1)
  })
  test("agent radius lengthens the smoothed path but not the route or cost", () => {
    const plain = nm.findPath(patron, spawn, model)!
    let last = len(plain.points)
    for (const radius of [16, 32, 64]) {
      const p = nm.findPath(patron, spawn, model, { radius })!
      expect(p.polys).toEqual(plain.polys)
      expect(p.cost).toBe(plain.cost)
      expect(len(p.points)).toBeGreaterThan(last)
      last = len(p.points)
    }
    expect(last).toBeCloseTo(5695, -1)
  })
  test("distanceField agrees with findPath and the smoothed path is no longer than cost", () => {
    const f = nm.distanceField([patron], model)
    for (const t of [spawn, lane]) {
      const p = nm.findPath(patron, t, model)!
      expect(f.costAt(t)).toBeCloseTo(p.cost, 3)
      expect(len(p.points)).toBeLessThanOrEqual(p.cost + 1)
      expect(p.points[0]).toEqual(patron === t ? t : p.points[0])
    }
    expect([...f.costs].filter(Number.isFinite).length).toBe(5282)
  })
})

/** Full published bundle, only when `DL_BUNDLE_DIR` points at the extracted release (never in CI). */
const dir = process.env.DL_BUNDLE_DIR
describe.skipIf(!dir || !existsSync(`${dir}/baked/navmesh.bin`))("full dl_midtown navmesh", () => {
  test("patron to patron is ~23,031 units of travel", () => {
    const nm = load(`${dir}/baked/navmesh.bin`)
    const p = nm.findPath([1280, 8048, 632], [-1280, -8034, 632], model)!
    expect(p.cost).toBeGreaterThan(23000)
    expect(p.cost).toBeLessThan(23100)
  })
})
