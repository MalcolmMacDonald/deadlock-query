import { beforeEach, describe, expect, test } from "bun:test"
import { buildMiniMap } from "@deadlock-query/contracts"
import { NavMesh } from "@deadlock-query/spatial-core"
import { linkSpeedsOf } from "../src/nav.ts"
import { MapContext, UNITS_PER_METER, seconds, vec, type NavMeshLike, type RaycasterLike } from "../src/index.ts"

import { S, SPEED, buildNavMap as build, floor, grid, manhattan } from "./navFixture.ts"

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
  test("floating points up to 1500 units above the mesh snap to it (orbs hover 1,000+ above their platforms)", () => {
    const a = vec(-3750, -3750, 0)
    expect(a.travelDistanceTo(vec(-2750, -3750, 1400))).toBeCloseTo(1000, 3)
    expect(a.travelDistanceTo(vec(-2750, -3750, 1600))).toBe(Infinity)
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
  test("navConnection links (the game's own nav) are walkable at hero speed by default", () => {
    const a = vec(-3750, -3750, 0), b = vec(3750, 3750, 0)
    const link = { from: [-3750, -3750, 0] as [number, number, number], to: [3750, 3750, 0] as [number, number, number], kind: "navConnection" }
    const nav = build([link]) // fixture sets linkSpeeds { zipline } only: navConnection comes from the defaults
    expect(a.travelTimeTo(b)).toBeCloseTo((7500 * Math.SQRT2) / SPEED, 3)
    expect(a.travelDistanceTo(b)).toBeCloseTo(7500 * Math.SQRT2, 3)
    expect(nav.nav.path(a, b)!.time).toBeLessThan(14000 / SPEED)
  })
  test("link speeds merge over the defaults; 0 switches a kind off", () => {
    const nav = (linkSpeeds?: Record<string, number>, heroSpeed?: number) =>
      MapContext.fromBundle({ ...mini, spatial: { raycaster: floor as RaycasterLike, nav: { mesh: NavMesh.fromPolygons(grid(), [{ from: [-3750, -3750, 0], to: [3750, 3750, 0], kind: "navConnection" }]) as NavMeshLike, ...(heroSpeed ? { heroSpeed } : {}), ...(linkSpeeds ? { linkSpeeds } : {}) } } })
    const a = vec(-3750, -3750, 0), b = vec(3750, 3750, 0)
    nav()
    expect(a.travelTimeTo(b)).toBeCloseTo((7500 * Math.SQRT2) / (7 * UNITS_PER_METER), 3)
    nav({ zipline: 1 }, 1000) // an explicit map without navConnection keeps its default (hero speed)
    expect(a.travelTimeTo(b)).toBeCloseTo((7500 * Math.SQRT2) / 1000, 3)
    nav({ navConnection: 2500 })
    expect(a.travelTimeTo(b)).toBeCloseTo((7500 * Math.SQRT2) / 2500, 3)
    nav({ navConnection: 0 }, 1000) // switched off: walk the long way
    expect(a.travelTimeTo(b)).toBeCloseTo(14000 / 1000, 3)
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

test("distance-field cache is bounded by bytes, not only by entry count", () => {
  // 20 fields of 2M polygons (16 MB each) cannot all stay cached; the newest ones must.
  let calls = 0
  const costs = new Float64Array(2_000_000)
  const mesh: NavMeshLike = {
    findPath: () => null,
    distanceField: () => { calls++; return { costAt: () => 1, costs } }
  }
  const m = MapContext.fromBundle({ ...mini, spatial: { raycaster: floor as RaycasterLike, nav: { mesh } } })
  const a = Array.from({ length: 20 }, (_, i) => vec(i * 10, 0, 0))
  for (const p of a) p.travelTimeTo(vec(0, 0, 0))
  expect(calls).toBe(20)
  a[19]!.travelTimeTo(vec(5, 5, 0)) // newest is still cached
  expect(calls).toBe(20)
  a[0]!.travelTimeTo(vec(5, 5, 0)) // oldest was evicted by the byte budget
  expect(calls).toBe(21)
  void m
})

test("line of sight uses collision only; walkable follows the navmesh; path takes a radius", () => {
  const a = vec(-3750, -3750, 0), b = vec(3750, 3750, 0)
  expect(a.hasLineOfSightTo(b)).toBe(true) // open floor: the ray stays above z=0
  expect(a.hasLineOfSightTo(vec(3750, 3750, -200), { targetHeight: 0 })).toBe(false) // target under the floor
  expect(map.healingOrbs.withLineOfSightTo(map.guardians).count()).toBe(map.healingOrbs.count())
  expect(map.nav.walkable(a, b)).toBe(true)
  expect(map.nav.walkable(a, vec(3750, 90000, 0))).toBe(false)
  const plain = map.nav.path(a, b)!, wide = map.nav.path(a, b, { radius: 100 })!
  expect(wide.time).toBe(plain.time)
})

test("mantle links default to half the walking speed and can be overridden or switched off", () => {
  expect(linkSpeedsOf({ heroSpeed: 500 }).mantle).toBe(250)
  expect(linkSpeedsOf({}).mantle).toBe(3.5 * UNITS_PER_METER)
  expect(linkSpeedsOf({ heroSpeed: 500, linkSpeeds: { mantle: 0 } }).mantle).toBe(0)
  expect(linkSpeedsOf({ heroSpeed: 500, linkSpeeds: { zipline: 1 } }).mantle).toBe(250) // an explicit map keeps the default
  const a = vec(-3750, -3750, 0), b = vec(3750, 3750, 0)
  const link = { from: [-3750, -3750, 0] as [number, number, number], to: [3750, 3750, 0] as [number, number, number], kind: "mantle" }
  const time = (linkSpeeds?: Record<string, number>) => {
    MapContext.fromBundle({ ...mini, spatial: { raycaster: floor as RaycasterLike, nav: { mesh: NavMesh.fromPolygons(grid(), [link]) as NavMeshLike, heroSpeed: SPEED, ...(linkSpeeds ? { linkSpeeds } : {}) } } })
    return a.travelTimeTo(b)
  }
  const len = Math.hypot(7500, 7500)
  expect(time()).toBeCloseTo(14000 / SPEED, 3) // at half speed the diagonal (42 s) loses to the 28 s walk
  expect(time({ mantle: SPEED * 4 })).toBeCloseTo(len / (SPEED * 4), 3)
  expect(time({ mantle: 0 })).toBeCloseTo(14000 / SPEED, 3)
})

test("climbRope links default to half the walking speed, work both ways, and can be overridden or switched off", () => {
  expect(linkSpeedsOf({ heroSpeed: 500 }).climbRope).toBe(250)
  expect(linkSpeedsOf({}).climbRope).toBe(3.5 * UNITS_PER_METER)
  expect(linkSpeedsOf({ heroSpeed: 500, linkSpeeds: { climbRope: 0 } }).climbRope).toBe(0)
  const a = vec(-3750, -3750, 0), b = vec(3750, 3750, 0)
  const link = { from: [-3750, -3750, 0] as [number, number, number], to: [3750, 3750, 0] as [number, number, number], kind: "climbRope", bidirectional: true }
  const times = (linkSpeeds?: Record<string, number>) => {
    MapContext.fromBundle({ ...mini, spatial: { raycaster: floor as RaycasterLike, nav: { mesh: NavMesh.fromPolygons(grid(), [link]) as NavMeshLike, heroSpeed: SPEED, ...(linkSpeeds ? { linkSpeeds } : {}) } } })
    return [a.travelTimeTo(b), b.travelTimeTo(a)]
  }
  const len = Math.hypot(7500, 7500)
  const [ab, ba] = times({ climbRope: SPEED * 4 })
  expect(ab).toBeCloseTo(len / (SPEED * 4), 3)
  expect(ba).toBeCloseTo(ab!, 3) // two-way
  for (const t of times()) expect(t).toBeCloseTo(14000 / SPEED, 3) // at half speed the walk (28 s) wins
  for (const t of times({ climbRope: 0 })) expect(t).toBeCloseTo(14000 / SPEED, 3)
})
