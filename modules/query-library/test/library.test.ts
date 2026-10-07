import { describe, expect, test } from "bun:test"
import { buildMiniMap } from "@deadlock-query/contracts"
import { MapContext, Seq, meters, vec } from "../src/index.ts"

const mini = buildMiniMap()
const map = MapContext.fromBundle(mini)

describe("Slice-1 query on the mini-map fixture", () => {
  test("guardian -> nearest healing orb matches expected result", () => {
    const rows = map.guardians
      .select((g) => {
        const orb = map.healingOrbs.closest(g)!
        return [g.id, g.position.toArray(), orb.id, Math.round(g.distanceTo(orb) * 1000) / 1000]
      })
      .toArray()
    expect(rows).toEqual(mini.expectedGuardianOrbDistance.rows as never)
  })
})

describe("entities", () => {
  test("collections by kind", () => {
    expect(map.guardians.count()).toBe(6)
    expect(map.walkers.count()).toBe(2)
    expect(map.healingOrbs.count()).toBe(4)
    expect(map.creepCamps.count()).toBe(3)
    expect(map.entities.count()).toBe(mini.entities.length)
  })
  test("unmapped class has no kind", () => {
    expect(map.entities.first((e) => e.id === "prop-1")!.kind).toBeUndefined()
  })
  test("inLane by number and colour, team", () => {
    expect(map.guardians.inLane(1).count()).toBe(2)
    expect(map.guardians.inLane("yellow").toArray().map((e) => e.id)).toEqual(["guardian-1-2", "guardian-1-3"])
    expect(map.guardians.inLane("blue").onTeam(3).first()!.id).toBe("guardian-2-3")
  })
  test("lanes are yellow (1), blue (2) and green (3); there is no purple lane", () => {
    expect(map.guardians.inLane("green").toArray().map((e) => e.laneNumber)).toEqual([3, 3])
    expect(map.guardians.inLane("green").count()).toBe(map.guardians.inLane(3).count())
    expect(map.guardians.toArray().map((e) => e.lane)).not.toContain("purple" as never)
    // @ts-expect-error "purple" is not a lane; the game data's "purple" lane is Green
    expect(map.guardians.inLane("purple").count()).toBe(0)
  })
  test("within accepts entity, point and iterable; chains keep entity helpers", () => {
    const g = map.guardians.inLane("yellow").onTeam(2).first()!
    expect(map.healingOrbs.within(3000, g).count()).toBe(1)
    expect(map.healingOrbs.within(100, vec(-800, 400, 20)).first()!.id).toBe("orb-1")
    expect(map.healingOrbs.within(2000, map.guardians.inLane(3)).where((e) => e.id !== "orb-1").inLane(1).count()).toBe(0)
    expect(map.healingOrbs.within(meters(1), g).count()).toBe(0)
  })
  test("highGround", () => {
    expect(map.healingOrbs.highGround(500).first()!.id).toBe("orb-3")
  })
})

describe("Seq", () => {
  const s = new Seq([5, 3, 8, 3, 1])
  test("basics", () => {
    expect(s.where((n) => n > 2).toArray()).toEqual([5, 3, 8, 3])
    expect(s.distinct().toArray()).toEqual([5, 3, 8, 1])
    expect(s.take(2).toArray()).toEqual([5, 3])
    expect(s.skip(3).toArray()).toEqual([3, 1])
    expect(s.first()).toBe(5)
    expect(new Seq<number>([]).first()).toBeUndefined()
    expect(s.any()).toBe(true)
    expect(new Seq<number>([]).any()).toBe(false)
    expect(s.all((n) => n > 0)).toBe(true)
    expect(s.sum((n) => n)).toBe(20)
    expect(s.min((n) => n)).toBe(1)
    expect(s.max((n) => n)).toBe(8)
    expect(s.chunk(2).toArray()).toEqual([[5, 3], [8, 3], [1]])
  })
  test("ordering is stable with thenBy", () => {
    const rows = new Seq([{ a: 1, b: 2 }, { a: 0, b: 9 }, { a: 1, b: 1 }])
    expect(rows.orderBy((r) => r.a).thenBy((r) => r.b).toArray()).toEqual([{ a: 0, b: 9 }, { a: 1, b: 1 }, { a: 1, b: 2 }])
    expect(rows.orderByDescending((r) => r.a).thenByDescending((r) => r.b).toArray()[0]).toEqual({ a: 1, b: 2 })
  })
  test("pairs, zip, groupBy, selectMany are lazy and correct", () => {
    expect(new Seq([1, 2, 3]).pairs().toArray()).toEqual([[1, 2], [1, 3], [2, 3]])
    expect(new Seq([1, 2, 3]).zip(["a", "b"]).toArray()).toEqual([[1, "a"], [2, "b"]])
    expect(new Seq([1, 2, 3, 4]).groupBy((n) => n % 2).toArray()).toEqual([{ key: 1, items: [1, 3] }, { key: 0, items: [2, 4] }])
    expect(new Seq([1, 2]).selectMany((n) => [n, n * 10]).toArray()).toEqual([1, 10, 2, 20])
    let pulled = 0
    const big = new Seq({ *[Symbol.iterator]() { for (let i = 0; i < 1e6; i++) { pulled++; yield i } } })
    big.where((n) => n % 2 === 0).take(3).toArray()
    expect(pulled).toBeLessThan(10)
  })
})

describe("Vec3 / units", () => {
  test("distance and conversions", () => {
    expect(vec(0, 0, 0).distanceTo(vec(3, 4, 0))).toBe(5)
    expect(vec(0, 0, 0).crowFliesTo(vec(0, 0, 10))).toBe(10)
    expect(meters(1)).toBeCloseTo(52.49, 1)
  })
})
