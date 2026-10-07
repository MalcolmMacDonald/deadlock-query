import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { NavMesh, Raycaster } from "@deadlock-query/spatial-core"
import { MapContext, seconds, type NavMeshLike, type RaycasterLike } from "../src/index.ts"

/** Headline queries 1 and 2 on the real published bundle, only when `DL_BUNDLE_DIR` points at the extracted release (never in CI). */
const dir = process.env.DL_BUNDLE_DIR
describe.skipIf(!dir || !existsSync(`${dir}/baked/navmesh.bin`))("real dl_midtown bundle (build 25763945)", () => {
  const ab = (f: string) => { const b = readFileSync(`${dir}/${f}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
  const map = () => MapContext.fromBundle({
    manifest: JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")),
    entities: JSON.parse(readFileSync(`${dir}/entities.json`, "utf8")).entities,
    spatial: { raycaster: Raycaster.deserialize(ab("baked/collision.bvh")) as RaycasterLike, nav: { mesh: NavMesh.load(ab("baked/navmesh.bin")) as NavMeshLike } }
  } as never)

  test("entities and reachability", () => {
    const m = map()
    expect([m.guardians.count(), m.walkers.count(), m.patrons.count(), m.healingOrbs.count(), m.creepCamps.count()]).toEqual([6, 6, 2, 36, 52])
    const p = m.patrons.first()!.position
    expect(m.guardians.all((g) => Number.isFinite(p.travelTimeTo(g.position)))).toBe(true)
    expect(m.healingOrbs.count((o) => Number.isFinite(p.travelTimeTo(o.position)))).toBe(20)
  })
  test("query 1 returns orbs near guardians", () => {
    const m = map()
    expect(m.healingOrbs.withinTravelTime(seconds(10), m.guardians).count()).toBe(7)
  })
  test("query 2 (orb detour pairs) finishes well inside 30 s", () => {
    const m = map()
    const t = performance.now()
    const n = m.healingOrbs.select((o) => o.position).pairs().where(([a, b]) => a.travelDistanceTo(b) > 1.5 * a.crowFliesTo(b)).count()
    expect(performance.now() - t).toBeLessThan(30_000)
    expect(n).toBe(553)
  })
  const example = async (f: string) => ((await import(`../examples/${f}.ts`)).default as (m: MapContext) => unknown)(map())
  test("example queries on the real map", async () => {
    expect(await example("unreachable-camps")).toEqual(["1380394:88987:9", "14781:1797", "14781:2501", "14781:2535", "14781:2762"])
    const trip = (await example("guardian-travel-times")) as { id: string; lane: string; seconds: number }[]
    expect(trip.map((r) => r.lane)).toEqual(["green", "blue", "yellow", "yellow", "green", "blue"])
    expect(trip[0]).toEqual({ id: "14781:72", lane: "green", seconds: 23 })
    const nearest = (await example("camp-nearest-orb")) as { camp: string; orb: string | null; seconds: number | null }[]
    expect(nearest.length).toBe(52)
    expect(nearest.filter((r) => r.orb === null).length).toBe(4)
    expect(nearest.find((r) => r.camp === "14781:1755")).toEqual({ camp: "14781:1755", orb: "1380425:99", seconds: 2.1 })
    expect(await example("camps-in-sight-of-patrons")).toEqual(["14781:1800", "14781:3432", "14781:3445", "14781:3581", "14781:3583"])
    expect(await example("path-chokepoints")).toEqual([["-3,0", 6], ["0,0", 6], ["2,-1", 6], ["3,0", 6], ["-1,0", 5]])
  })
})
