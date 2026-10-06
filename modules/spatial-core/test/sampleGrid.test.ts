import { expect, test } from "bun:test"
import { Raycaster, SampleGrid } from "../src/index.ts"
import { makeScene } from "../bench/scene.ts"

const rc = () => {
  const g = makeScene(4_000)
  return Raycaster.fromGeometry(g.getAttribute("position").array as Float32Array, g.index!.array as Uint32Array)
}

test("floorHeight matches a direct downward ray; custom channels see floorZ", () => {
  const r = rc()
  const grid = SampleGrid.build(r, r.bounds, 40, {
    above: (c) => c.floorZ + 1,
    flag: { type: "u8", gen: (c) => (c.ix % 2) }
  })
  expect(grid.channelNames).toEqual(["floorHeight", "above", "flag"])
  const p: [number, number] = [r.bounds.min[0] + 60, r.bounds.min[1] + 100]
  const cy = r.bounds.min[1] + 100
  const direct = r.raycastFirst([p[0] + 20 - (p[0] - r.bounds.min[0]) % 40, p[1] + 20 - (p[1] - r.bounds.min[1]) % 40, r.bounds.max[2] + 1], [0, 0, -1], { backfaces: true })!
  const f = grid.get("floorHeight", p)!
  expect(f).toBeCloseTo(direct.point[2], 3)
  expect(Number.isFinite(f)).toBe(true)
  expect(grid.get("above", p)).toBeCloseTo(f + 1, 3)
  expect(grid.get("flag", p)).toBe(1)
  expect(grid.get("floorHeight", [r.bounds.min[0] - 1, cy])).toBeNull()
})

test("serialise round-trips deterministically and reports progress/abort", () => {
  const r = rc()
  const mk = () => SampleGrid.build(r, r.bounds, 50, { k: { type: "u8", gen: (c) => c.iy & 255 } })
  const a = mk().serialize(), b = mk().serialize()
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  const g = SampleGrid.deserialize(a)
  expect(Buffer.from(g.serialize()).equals(Buffer.from(a))).toBe(true)
  expect(g.get("k", [r.bounds.min[0] + 1, r.bounds.min[1] + 120])).toBe(2)
  let last = 0
  SampleGrid.build(r, r.bounds, 100, {}, { onProgress: (d) => (last = d) })
  expect(last).toBeGreaterThan(0)
  const ac = new AbortController(); ac.abort()
  expect(() => SampleGrid.build(r, r.bounds, 100, {}, { signal: ac.signal })).toThrow()
})
