import { beforeEach, describe, expect, test } from "bun:test"
import { buildMiniMap } from "@deadlock-query/contracts"
import { Raycaster } from "@deadlock-query/spatial-core"
import { MapContext, vec, type SemanticsLike, type RaycasterLike } from "../src/index.ts"

const mini = buildMiniMap()

// Flat 2000x2000 floor at z=100 as two triangles, plus the real Raycaster over it.
const floor = Raycaster.fromGeometry(
  new Float32Array([0, 0, 100, 2000, 0, 100, 2000, 2000, 100, 0, 2000, 100]),
  new Uint32Array([0, 1, 2, 0, 2, 3])
)

const calls: string[] = []
const stub: SemanticsLike = {
  placeholder: true,
  isInterior: (_rc, p) => (calls.push("interior"), p[0] > 1000),
  isVisible: (_rc, from, to) => (calls.push("visible"), Math.abs(from[0] - to[0]) < 500),
  nearestWall: (_rc, p) => ({ point: [0, p[1], p[2]], normal: [1, 0, 0], distance: p[0] }),
}
const build = () => MapContext.fromBundle({ ...mini, spatial: { raycaster: floor as RaycasterLike, semantics: stub, params: { eyeHeight: 64 } } })
let map = build()
// The active spatial backend is module-global (one map per worker), so rebuild per test.
beforeEach(() => { map = build() })

describe("spatial wrappers (real Raycaster, stub semantics)", () => {
  test("height is elevation above map bounds minimum", () => {
    expect(vec(5, 5, 160).height()).toBeCloseTo(60, 3)
  })
  test("isInterior / nearestWall / visibleFrom forward to semantics", () => {
    expect(vec(1500, 0, 0).isInterior()).toBe(true)
    expect(vec(300, 40, 100).nearestWall()!.distance).toBe(300)
    expect(vec(0, 0, 0).visibleFrom([vec(900, 0, 0), vec(100, 0, 0)])).toBe(true)
    expect(vec(0, 0, 0).visibleFrom(vec(900, 0, 0))).toBe(false)
    expect(calls).toContain("visible")
  })
  test("visibleFrom merges per-call overrides into params", () => {
    let seen: Record<string, number> = {}
    const m = MapContext.fromBundle({ ...mini, spatial: { raycaster: floor, semantics: { ...stub, isVisible: (_r, _f, _t, p) => ((seen = { ...p }), true) }, params: { eyeHeight: 64, maxRange: 5 } } })
    vec(0, 0, 0).visibleFrom(vec(1, 1, 1), { eyeHeight: 10 })
    expect(seen).toEqual({ eyeHeight: 10, maxRange: 5 })
    expect(m.provisional).toBe(true)
  })
  test("entities.visibleFrom filters", () => {
    const n = map.healingOrbs.visibleFrom(vec(-800, 400, 0)).count()
    expect(n).toBe(map.healingOrbs.where((o) => Math.abs(o.position.x + 800) < 500).count())
  })
  test("sample.grid finds floor points deterministically, honours region", () => {
    const g = map.sample.grid(500).toArray()
    expect(g.length).toBe(25)
    expect(g.every((p) => p.z === 100)).toBe(true)
    expect(map.sample.grid(500).toArray()).toEqual(g)
    expect(map.sample.grid(500, { region: { min: [0, 0], max: [500, 500] } }).count()).toBe(4)
    expect(() => map.sample.grid(0)).toThrow()
  })
  test("sample.walls dedupes wall points by cell", () => {
    const w = map.sample.walls(500).toArray()
    expect(w.length).toBe(5)
    expect(w.every((p) => p.x === 0)).toBe(true)
  })
  test("without a backend, spatial methods throw clearly", () => {
    MapContext.fromBundle(mini)
    expect(() => vec(0, 0, 0).height()).toThrow(/spatial backend/)
    expect(() => map.sample.grid(100)).toThrow(/spatial backend/)
  })
})
