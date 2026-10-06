import { beforeEach, describe, expect, test } from "bun:test"
import { MapContext, vec } from "../src/index.ts"
import { buildMiniMap } from "@deadlock-query/contracts"
import queryThree from "../examples/camps-visible-from-high-ground.ts"
import campDensity from "../examples/camp-density.ts"
import { buildPlateauMap } from "./plateauFixture.ts"

let map = buildPlateauMap()
beforeEach(() => { map = buildPlateauMap() })

describe("headline query 3: camps visible from high ground", () => {
  test("golden: only camps within 1500 units (XY) of the plateau are visible from it", () => {
    // Plateau grid points (spacing 400) cover x,y in [-800, 800] at height 1000.
    // camp-1 (-1000,-1000) and camp-2 (1000,1000) are ~283 away; camp-3 (0,-2500) is >= 1700 away.
    expect(queryThree(map)).toEqual(["camp-1", "camp-2"])
    expect(map.provisional).toBe(true)
  })
  test("high-ground points are exactly the plateau cells", () => {
    const high = map.sample.grid(400).where((p) => p.height() >= 800).toArray()
    expect(high.length).toBe(25)
    expect(high.every((p) => p.z === 1000)).toBe(true)
  })
  test("highGround uses height() when a backend is loaded", () => {
    // Absolute z of every camp is 20, which never reaches 800, but absolute z is not used here.
    expect(map.creepCamps.highGround(800).count()).toBe(0)
    expect(map.creepCamps.highGround(-4000).count()).toBe(3) // height() = z - min z (0)
    MapContext.fromBundle(buildMiniMap())
    expect(map.creepCamps.highGround(10).count()).toBe(3) // no backend: absolute z (20)
  })
  test("deterministic", () => {
    expect(JSON.stringify(queryThree(map))).toBe(JSON.stringify(queryThree(map)))
  })
})

describe("helpers", () => {
  const m = MapContext.fromBundle(buildMiniMap())
  const origin = vec(0, 0, 0)
  test("closestN returns nearest first and agrees with closest", () => {
    const camps = m.creepCamps.closestN(origin, 2)
    expect(camps.map((c) => c.id)).toEqual(["camp-1", "camp-2"])
    expect(m.creepCamps.closestN(origin, 1)[0]).toBe(m.creepCamps.closest(origin)!)
    expect(m.creepCamps.closestN(origin, 0)).toEqual([])
    expect(m.creepCamps.closestN(origin, 99).length).toBe(3)
  })
  test("groupByRegion groups into XY cells, ordered by ix then iy", () => {
    const groups = m.creepCamps.groupByRegion(1000).toArray()
    expect(groups.map((g) => g.region.key)).toEqual(["-1,-1", "0,-3", "1,1"])
    expect(groups.flatMap((g) => g.items.map((c) => c.id)).sort()).toEqual(["camp-1", "camp-2", "camp-3"])
    expect(() => m.creepCamps.groupByRegion(0).toArray()).toThrow()
  })
  test("density counts entities per cell and returns only non-empty cells", () => {
    const cells = m.sample.density(m.creepCamps, 2000).toArray()
    expect(cells.reduce((n, c) => n + c.count, 0)).toBe(3)
    expect(cells.every((c) => c.count > 0)).toBe(true)
    expect(m.sample.density([origin, vec(1, 1, 5), vec(2500, 0, 0)], 2000).select((c) => c.count).toArray()).toEqual([2, 1])
    expect(m.sample.density(origin, 2000).count()).toBe(1)
    expect(() => m.sample.density([], 0)).toThrow()
  })
  test("camp-density example is deterministic", () => {
    expect(campDensity(m)).toEqual(campDensity(m))
  })
})

