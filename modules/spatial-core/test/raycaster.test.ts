import { expect, test } from "bun:test"
import { Raycaster } from "../src/index.ts"
import { Triangle, Vector3 } from "three"
import type { Vec3 } from "@deadlock-query/contracts"
import { makeScene } from "../bench/scene.ts"

const scene = () => {
  const g = makeScene(4_000)
  return { pos: g.getAttribute("position").array as Float32Array, idx: g.index!.array as Uint32Array }
}
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

/** Möller–Trumbore, double-sided; returns t or null. */
function bruteRay(pos: Float32Array, idx: Uint32Array, o: Vec3, d: Vec3): number | null {
  let best: number | null = null
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3]
    const e1 = [pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!]
    const e2 = [pos[c]! - pos[a]!, pos[c + 1]! - pos[a + 1]!, pos[c + 2]! - pos[a + 2]!]
    const p = [d[1] * e2[2]! - d[2] * e2[1]!, d[2] * e2[0]! - d[0] * e2[2]!, d[0] * e2[1]! - d[1] * e2[0]!]
    const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!
    if (Math.abs(det) < 1e-9) continue
    const s = [o[0] - pos[a]!, o[1] - pos[a + 1]!, o[2] - pos[a + 2]!]
    const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) / det
    if (u < 0 || u > 1) continue
    const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!]
    const v = (d[0] * q[0]! + d[1] * q[1]! + d[2] * q[2]!) / det
    if (v < 0 || u + v > 1) continue
    const tt = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det
    if (tt > 0 && (best === null || tt < best)) best = tt
  }
  return best
}

test("raycastFirst matches brute force (double-sided)", () => {
  const { pos, idx } = scene()
  const rc = Raycaster.fromGeometry(pos.slice(), idx.slice())
  for (let i = 0; i < 200; i++) {
    const o: Vec3 = [rnd() * 600, rnd() * 600, 600]
    const d: Vec3 = [rnd() - 0.5, rnd() - 0.5, -1]
    const n = Math.hypot(...d)
    const dn: Vec3 = [d[0] / n, d[1] / n, d[2] / n]
    const h = rc.raycastFirst(o, dn, { backfaces: true })
    const b = bruteRay(pos, idx, o, dn)
    if (b === null) expect(h).toBeNull()
    else expect(h!.distance).toBeCloseTo(b, 2)
  }
})

test("occluded, max distance and batch agree with raycastFirst", () => {
  const { pos, idx } = scene()
  const rc = Raycaster.fromGeometry(pos.slice(), idx.slice())
  const o: Vec3 = [300, 300, 600]
  const h = rc.raycastFirst(o, [0, 0, -1], { backfaces: true })!
  expect(rc.occluded(o, [300, 300, -600])).toBe(true)
  expect(rc.occluded(o, [300, 300, 600 - h.distance + 5])).toBe(false)
  expect(rc.raycastFirst(o, [0, 0, -1], { max: h.distance - 1, backfaces: true })).toBeNull()
  const out = rc.raycastFirstMany(new Float32Array(o), new Float32Array([0, 0, -1]), { backfaces: true })
  expect(out[0]).toBeCloseTo(h.distance, 3)
  expect(rc.raycastAll(o, [0, 0, -1], { backfaces: true })[0]!.distance).toBeCloseTo(h.distance, 3)
})

test("closestPoint and overlap tests", () => {
  const { pos, idx } = scene()
  const rc = Raycaster.fromGeometry(pos.slice(), idx.slice())
  const h = rc.raycastFirst([300, 300, 600], [0, 0, -1], { backfaces: true })!
  const above: Vec3 = [h.point[0], h.point[1], h.point[2] + 20]
  const c = rc.closestPoint(above)!
  expect(c.distance).toBeLessThanOrEqual(20 + 1e-3)
  expect(rc.closestPoint(above, { maxDist: 1 })).toBeNull()
  expect(rc.overlapsSphere({ center: h.point, radius: 5 })).toBe(true)
  expect(rc.overlapsSphere({ center: [h.point[0], h.point[1], h.point[2] + 500], radius: 5 })).toBe(false)
  expect(rc.overlapsCapsule({ a: above, b: [above[0], above[1], above[2] + 50], radius: 30 })).toBe(true)
  expect(rc.overlapsCapsule({ a: [0, 0, 5000], b: [0, 0, 5100], radius: 30 })).toBe(false)
})

test("serialise is deterministic and round-trips", () => {
  const { pos, idx } = scene()
  const a = Raycaster.fromGeometry(pos.slice(), idx.slice())
  const b = Raycaster.fromGeometry(pos.slice(), idx.slice())
  const ba = a.serialize(), bb = b.serialize()
  expect(Buffer.from(ba).equals(Buffer.from(bb))).toBe(true)
  const r = Raycaster.deserialize(ba)
  expect(Buffer.from(r.serialize()).equals(Buffer.from(ba))).toBe(true)
  const o: Vec3 = [250, 250, 600]
  expect(r.raycastFirst(o, [0, 0, -1], { backfaces: true })!.distance)
    .toBeCloseTo(a.raycastFirst(o, [0, 0, -1], { backfaces: true })!.distance, 5)
  expect(r.bounds).toEqual(a.bounds)
})

test("triangle(triIndex) returns the corners of the triangle a query reported", () => {
  const { pos, idx } = scene()
  const rc = Raycaster.fromGeometry(pos.slice(), idx.slice())
  expect(rc.triangleCount).toBe(idx.length / 3)
  const back = Raycaster.deserialize(rc.serialize())
  const tri = new Triangle(), t = new Vector3()
  for (let i = 0; i < 50; i++) {
    const o: Vec3 = [rnd() * 500, rnd() * 500, 600]
    const h = rc.raycastFirst(o, [0, 0, -1], { backfaces: true })
    if (!h) continue
    const c = rc.triangle(h.triIndex)
    tri.set(new Vector3(...c[0]), new Vector3(...c[1]), new Vector3(...c[2]))
    expect(tri.closestPointToPoint(new Vector3(...h.point), t).distanceTo(new Vector3(...h.point))).toBeLessThan(1e-3)
    expect(back.triangle(h.triIndex)).toEqual(c)
    const cp = rc.closestPoint(o)!
    expect(rc.triangle(cp.triIndex)).toEqual(back.triangle(cp.triIndex))
  }
  expect(() => rc.triangle(-1)).toThrow(RangeError)
  expect(() => rc.triangle(rc.triangleCount)).toThrow(RangeError)
})

test("occludedMany matches occluded", () => {
  const floor = Raycaster.fromGeometry(new Float32Array([-10, -10, 0, 10, -10, 0, 10, 10, 0, -10, 10, 0]), new Uint32Array([0, 1, 2, 0, 2, 3]))
  const a = new Float32Array([0, 0, 5, 0, 0, 5, 1, 1, 1]), b = new Float32Array([0, 0, -5, 3, 3, 5, 1, 1, 1])
  expect([...floor.occludedMany(a, b)]).toEqual([1, 0, 0])
  expect(() => floor.occludedMany(a, new Float32Array(3))).toThrow(RangeError)
})
