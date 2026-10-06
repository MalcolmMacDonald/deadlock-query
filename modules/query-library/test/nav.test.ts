import { beforeEach, describe, expect, test } from "bun:test"
import { buildMiniMap } from "@deadlock-query/contracts"
import { MapContext, seconds, vec } from "../src/index.ts"

import { S, SPEED, buildNavMap as build, floor, manhattan } from "./navFixture.ts"

const mini = buildMiniMap()

let map = build()
beforeEach(() => { map = build() })

describe("travel time/distance on a hand-computed grid navmesh", () => {
  test("travelDistanceTo equals the hand-computed hop length", () => {
    const g = map.guardians.first()!
    for (const o of map.healingOrbs) {
      const d = g.position.travelDistanceTo(o.position)
      const want = manhattan(g.position.toArray(), o.position.toArray())
      if (want === Infinity) expect(d).toBe(Infinity)
      else expect(d).toBeCloseTo(want, 3)
      expect(g.position.travelTimeTo(o.position)).toBe(d / SPEED)
    }
  })
  test("one-cell and zero hops", () => {
    expect(vec(-3750, -3750, 0).travelDistanceTo(vec(-3750, -3750, 0))).toBe(0)
    expect(vec(-3750, -3750, 0).travelDistanceTo(vec(-2750, -3750, 0))).toBeCloseTo(1000, 3)
    expect(vec(-3750, -3750, 0).travelTimeTo(vec(-2750, -3750, 0))).toBeCloseTo(2, 6)
  })
  test("points far off the mesh are unreachable", () => {
    expect(vec(0, 0, 0).travelTimeTo(vec(0, 0, 0 + 5000))).toBe(Infinity)
    expect(vec(0, 0, 0).travelDistanceTo(vec(90000, 0, 0))).toBe(Infinity)
  })
  test("withinTravelTime (headline query 1) matches the hand model and is deterministic", () => {
    const yellow = map.guardians.inLane("yellow")
    const got = map.healingOrbs.withinTravelTime(seconds(10), yellow).select((o) => o.id).toArray()
    const want = map.healingOrbs.where((o) => yellow.any((g) => manhattan(g.position.toArray(), o.position.toArray()) / SPEED <= 10)).select((o) => o.id).toArray()
    expect(got).toEqual(want)
    expect(got.length).toBeGreaterThan(0)
    expect(map.healingOrbs.withinTravelTime(seconds(10), yellow).select((o) => o.id).toArray()).toEqual(got)
    expect(map.healingOrbs.withinTravelTime(seconds(0.5), yellow).count()).toBeLessThanOrEqual(got.length)
  })
  test("pair query (headline query 2 shape) detours vs crow-flies", () => {
    const pts = [vec(-3750, -3750, 0), vec(-2750, -2750, 0), vec(3750, 3750, 0)]
    const ratios = pts.flatMap((a, i) => pts.slice(i + 1).map((b) => a.travelDistanceTo(b) / a.crowFliesTo(b)))
    expect(ratios.every((r) => r >= 1)).toBe(true)
    expect(ratios[0]).toBeCloseTo(2000 / (1000 * Math.SQRT2), 3)
  })
  test("ziplines shorten travel; path exposes waypoints", () => {
    const a = vec(-3750, -3750, 0), b = vec(3750, 3750, 0)
    expect(map.nav.path(a, b)!.time).toBeCloseTo(14000 / SPEED, 3)
    // The active backend is module-global, so the zipline map replaces `map`'s.
    const zip = build([{ from: [-3750, -3750, 0], to: [3750, 3750, 0], kind: "zipline" }])
    const z = zip.nav.path(a, b)!
    expect(z.time).toBeLessThan(14000 / SPEED)
    expect(z.points[0]!.equals(a)).toBe(true)
    expect(z.points.at(-1)!.equals(b)).toBe(true)
    expect(a.travelTimeTo(b)).toBeCloseTo(z.time, 3) // active backend is the zipline map
  })
  test("timeFrom caches and takes the quickest source", () => {
    const t = map.nav.timeFrom([vec(-3750, -3750, 0), vec(3750, 3750, 0)])
    expect(t(vec(2750, 3750, 0))).toBeCloseTo(2, 6)
  })
  test("throws without a navmesh", () => {
    MapContext.fromBundle({ ...mini, spatial: { raycaster: floor } })
    expect(() => vec(0, 0, 0).travelTimeTo(vec(1, 1, 0))).toThrow(/navmesh/)
  })
})
