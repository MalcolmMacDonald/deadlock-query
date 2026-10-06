import { describe, expect, test } from "bun:test"
import { buildMiniMap } from "@deadlock-query/contracts"
import { MapContext, vec } from "../src/index.ts"
import { SPEED } from "./navFixture.ts"
import { buildMetadataMap, camp, link, orb, provenance, region, sacrifice } from "./metadataFixture.ts"

const mini = buildMiniMap()
const A = vec(-1000, 0, 0), B = vec(1000, 0, 0) // cells (3,4) and (5,4) of the 1000-unit grid; one cell (x -250..750) between them
// A wall over column 4 (x -250..750) from y -4250 to 3750, leaving only the top row (y 3750..4750) open.
const wall = region({ id: "wall", x: [-250, 750], y: [-4250, 3750], flag: "noGo" })

describe("entities from accepted metadata", () => {
  const map = buildMetadataMap([
    camp({ id: "c-far", at: [3000, 3000, 20], tier: "strong", by: "Alice" }),
    camp({ id: "c-dup", at: [10, -2490, 20] }), // 11 units from extractor camp-3 (0,-2500)
    camp({ id: "c-proposed", at: [-3000, -3000, 20], status: "proposed" }),
    camp({ id: "c-rejected", at: [-3000, -2000, 20], status: "rejected" }),
    camp({ id: "c-stale", at: [-3000, -1000, 20], status: "stale" }),
    sacrifice({ id: "s-1", at: [-3000, 2000, 20], by: "Bob" }),
    orb({ id: "o-new", at: [3500, -3500, 20] }),
  ])
  test("accepted records become entities with source and provenance", () => {
    const c = map.creepCamps.fromSource("metadata").toArray()
    expect(c.map((e) => e.id)).toEqual(["metadata:c-far"])
    expect(c[0]!.provenance).toEqual(provenance("Alice"))
    expect(c[0]!.properties.tier).toBe("strong")
    expect(c[0]!.position.toArray()).toEqual([3000, 3000, 20])
    expect(map.creepCamps.count()).toBe(mini.entities.filter((e) => e.kind === "creepCamp").length + 1)
    expect(map.creepCamps.fromSource("extractor").all((e) => e.provenance === undefined)).toBe(true)
  })
  test("sinnersSacrifices and healing orbs are merged", () => {
    expect(map.sinnersSacrifices.select((e) => e.id).toArray()).toEqual(["metadata:s-1"])
    expect(map.sinnersSacrifices.first()!.provenance!.submitter!.name).toBe("Bob")
    expect(map.healingOrbs.fromSource("metadata").select((e) => e.id).toArray()).toEqual(["metadata:o-new"])
  })
  test("duplicates of extractor entities are skipped and explained; non-accepted are ignored", () => {
    const o = map.metadata.outcomes
    expect(o.map((x) => x.id)).toEqual(["c-far", "c-dup", "s-1", "o-new"].sort()) // bundle order: kind then id
    const dup = o.find((x) => x.id === "c-dup")!
    expect(dup.applied).toBe(false)
    expect(dup.detail).toMatch(/duplicate of extractor entity camp-3/)
    expect(o.find((x) => x.id === "c-far")!.provenance).toEqual(provenance("Alice"))
    expect(map.metadata.loaded).toBe(true)
  })
  test("dedupe radius is a setting", () => {
    const m = MapContext.fromBundle({ ...mini, metadata: { ...mini.manifest, records: [camp({ id: "near", at: [10, -2490, 20] })] } }, { metadataDedupeRadius: 5 })
    expect(m.creepCamps.fromSource("metadata").count()).toBe(1)
  })
  test("metadata for another build is ignored with a warning", () => {
    const m = buildMetadataMap([camp({ id: "c", at: [3000, 3000, 20] })], { gameBuildId: "other-build" })
    expect(m.creepCamps.fromSource("metadata").count()).toBe(0)
    expect(m.metadata.loaded).toBe(false)
    expect(m.metadata.warnings[0]).toMatch(/other-build/)
    expect(buildMetadataMap([], { mapName: "elsewhere" }).metadata.warnings[0]).toMatch(/elsewhere/)
  })
  test("without metadata the report is empty and entities are unchanged", () => {
    const m = MapContext.fromBundle(mini)
    expect(m.metadata).toEqual({ loaded: false, gameBuildId: undefined, outcomes: [], warnings: [] })
    expect(m.sinnersSacrifices.count()).toBe(0)
  })
})

describe("navmesh overrides from accepted metadata", () => {
  test("baseline: the grid has a direct route", () => {
    const m = buildMetadataMap([])
    expect(A.travelDistanceTo(B)).toBe(2000)
    expect(A.travelTimeTo(B)).toBeCloseTo(2000 / SPEED, 6)
    expect(m.metadata.outcomes).toEqual([])
  })
  test("a noGo wall forces the detour through the gap", () => {
    const m = buildMetadataMap([wall])
    // 4 hops up to the open row, 2 across, 4 back down.
    expect(A.travelDistanceTo(B)).toBe(10_000)
    expect(m.metadata.outcomes[0]).toMatchObject({ id: "wall", applied: true, detail: "blocked 8 polygons" })
  })
  test("a zipline link over the wall shortcuts it", () => {
    const m = buildMetadataMap([wall, link({ id: "zip", from: [-1000, 0, 0], to: [1000, 0, 0], linkKind: "zipline" })])
    expect(A.travelTimeTo(B)).toBeCloseTo(2000 / 5000, 6)
    expect(m.metadata.outcomes.find((o) => o.id === "zip")!.applied).toBe(true)
  })
  test("a link of a kind with no speed is skipped and says what to set", () => {
    const m = buildMetadataMap([link({ id: "jp", from: [-1000, 0, 0], to: [1000, 0, 0], linkKind: "jumpPad" })])
    expect(m.metadata.outcomes[0]).toMatchObject({ applied: false })
    expect(m.metadata.outcomes[0]!.detail).toMatch(/nav\.linkSpeeds\.jumpPad/)
    expect(A.travelDistanceTo(B)).toBe(2000)
  })
  test("a walkable region with a costMultiplier re-costs the ground it covers", () => {
    const m = buildMetadataMap([region({ id: "mud", x: [-250, 750], y: [-250, 750], flag: "walkable", costMultiplier: 3 })])
    // Entering the polygon costs 3x: 2 s * 3 + 2 s, instead of 2 s + 2 s.
    expect(A.travelTimeTo(B)).toBeCloseTo(8, 6)
    expect(m.metadata.outcomes[0]!.detail).toBe("re-costed 1 polygons")
  })
  test("regions that cannot change navigation are skipped with a reason", () => {
    const m = buildMetadataMap([
      region({ id: "add", x: [-250, 750], y: [-250, 750], flag: "walkable" }),
      region({ id: "room", x: [-250, 750], y: [-250, 750], flag: "interior" }),
      region({ id: "upstairs", x: [-250, 750], y: [-250, 750], flag: "noGo", floorZ: 5000 }),
    ])
    const by = Object.fromEntries(m.metadata.outcomes.map((o) => [o.id, o]))
    expect(by.add).toMatchObject({ applied: false })
    expect(by.add!.detail).toMatch(/added polygons/)
    expect(by.room!.detail).toMatch(/only tag the surface/)
    expect(by.upstairs).toMatchObject({ applied: false })
    expect(by.upstairs!.detail).toMatch(/matches no navmesh polygon/)
    expect(A.travelDistanceTo(B)).toBe(2000)
  })
  test("nav records without a navmesh are skipped, entity records still apply", () => {
    const m = buildMetadataMap([wall, camp({ id: "c", at: [3000, 3000, 20] })], { nav: false })
    expect(m.metadata.outcomes.find((o) => o.id === "wall")).toMatchObject({ applied: false, detail: "no navmesh loaded" })
    expect(m.creepCamps.fromSource("metadata").count()).toBe(1)
  })
  test("merge is deterministic regardless of record order", () => {
    const rs = [wall, link({ id: "zip", from: [-1000, 0, 0], to: [1000, 0, 0], linkKind: "zipline" }), camp({ id: "c", at: [3000, 3000, 20] })]
    const a = buildMetadataMap(rs), t1 = A.travelTimeTo(B)
    const ao = JSON.stringify(a.metadata)
    const b = buildMetadataMap([...rs].reverse())
    expect(JSON.stringify(b.metadata)).toBe(ao)
    expect(A.travelTimeTo(B)).toBe(t1)
  })
})
