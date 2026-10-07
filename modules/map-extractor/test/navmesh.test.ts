import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { buildMiniMap, type Entity } from "@deadlock-query/contracts"
import { NavMesh } from "@deadlock-query/spatial-core"
import { bakeBundle } from "../src/bake.ts"
import { inspectBundle } from "../src/inspect.ts"
import {
  bakeNavmesh, entityLinks, navmeshObj, nearTest, polygonComponents, snapLinks, stitchTileBorders, toNavMeshData, weldVertices,
  type PolygonSoup
} from "../src/navmesh.ts"

const miniBundle = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-nav-"))
  const m = buildMiniMap()
  mkdirSync(join(dir, "collision"), { recursive: true })
  writeFileSync(join(dir, "collision/physics.glb"), m.collisionGlb)
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m.manifest, tiles: [] }, null, 2))
  writeFileSync(join(dir, "entities.json"), JSON.stringify({ schemaVersion: m.manifest.schemaVersion, entities: m.entities }))
  return dir
}
const WALK = { speed: 1 }
const rd = (p: string) => new Uint8Array(readFileSync(p)).buffer.slice(0) as ArrayBuffer
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex")

// ---- pure polygon helpers -------------------------------------------------------------------------------------------

/** Two unit-ish squares side by side across the border x = 10, but the right side is split in two: T-junction. */
const tJunction = (): PolygonSoup => {
  const v = [
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, // left square: 0..3
    10, 0, 0, 20, 0, 0, 20, 5, 0, 10, 5, 0, // right lower: 4..7 (4 and 7 are on x=10)
    10, 5, 0, 20, 5, 0, 20, 10, 0, 10, 10, 0 // right upper: 8..11
  ]
  return { vertices: Float64Array.from(v), polys: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]] }
}

/** These bake real fixture geometry (0.5 to 1.3 s alone); bun's 5 s default fails them when `verify:all` runs every module at once. */
const BAKE_TIMEOUT_MS = 60_000

test("weldVertices merges border vertices that differ slightly in height but not distinct levels", () => {
  const pos = Float64Array.from([0, 0, 0, 0, 0, 5, 0, 0, 100, 1, 0, 0, 0, 1, 0])
  const w = weldVertices(pos, [[0, 3, 4], [1, 3, 4], [2, 3, 4]], 18)
  expect(w.vertices.length / 3).toBe(4) // 0 and 1 weld (dz 5 < 18); 2 stays (dz 100)
  expect(w.polys[0]![0]).toBe(w.polys[1]![0])
  expect(w.polys[2]![0]).not.toBe(w.polys[0]![0])
})

test("without stitching a T-junction leaves the tiles disconnected; stitching connects them", () => {
  const soup = tJunction()
  // Left square and right polys share vertex ids only after welding the corners; weld first like the bake does.
  const welded = weldVertices(soup.vertices, soup.polys, 18)
  expect(polygonComponents(welded).sizes.length).toBe(2) // right pair connected via (10,5)-(20,5); left separate
  const { soup: s, stitched } = stitchTileBorders(welded, { x: [10], y: [] }, 18)
  expect(stitched).toBe(1) // the left square's edge x=10 gains the (10,5) vertex
  expect(s.polys[0]!.length).toBe(5)
  expect(polygonComponents(s).sizes).toEqual([3])
})

test("stitching ignores border vertices on another level", () => {
  const soup = tJunction()
  // Lift the right-hand (10,5) vertices 100 units: a different floor, not the same surface.
  const v = Float64Array.from(soup.vertices)
  for (const i of [7, 8]) v[i * 3 + 2] = 100
  const welded = weldVertices(v, soup.polys, 18)
  const { stitched } = stitchTileBorders(welded, { x: [10], y: [] }, 18)
  expect(stitched).toBe(0)
})

test("navmeshObj groups polygons by component and the data round-trips through spatial-core", () => {
  const soup = tJunction()
  const { component } = polygonComponents(soup)
  const obj = navmeshObj(soup, component)
  expect(obj.split("\n").filter((l) => l.startsWith("v ")).length).toBe(12)
  expect(obj).toContain("g component_0")
  const nm = NavMesh.load(NavMesh.fromPolygons(toNavMeshData(soup), [{ from: [1, 1, 0], to: [19, 9, 0], kind: "zipline" }]).serialize())
  expect(nm.polyCount).toBe(3)
})

test("entityLinks resolves zipline and jump pad targets and ignores dangling ones", () => {
  const e = (id: string, kind: Entity["kind"], position: [number, number, number], properties: Record<string, unknown>): Entity =>
    ({ id, class: "x", ...(kind ? { kind } : {}), position, properties })
  const links = entityLinks([
    // a three-node path (listed out of order) plus a lone node, as in the real lump (path_uniqueid / path_index)
    e("z2", "zipline", [500, 0, 600], { path_uniqueid: "p1", path_index: 1 }),
    e("z3", "zipline", [1000, 0, 500], { path_uniqueid: "p1", path_index: 2 }),
    e("z1", "zipline", [0, 0, 500], { path_uniqueid: "p1", path_index: 0 }),
    e("z4", "zipline", [5, 5, 5], { path_uniqueid: "p2", path_index: 0 }),
    e("j1", "jumpPad", [0, 100, 0], { target: "land" }),
    e("j2", "jumpPad", [0, 200, 0], { target: "missing" }),
    e("l", undefined, [0, 900, 300], { targetname: "land" })
  ])
  expect(links).toEqual([
    { from: [0, 100, 0], to: [0, 900, 300], kind: "jumpPad", bidirectional: false },
    { from: [0, 0, 500], to: [500, 0, 600], kind: "zipline", bidirectional: true },
    { from: [500, 0, 600], to: [1000, 0, 500], kind: "zipline", bidirectional: true }
  ])
  const v = Float64Array.from([0, 0, 480, 1000, 0, 480, 0, 100, 0])
  const s = snapLinks(links, v, 100)
  expect(s.kept.length).toBe(0) // the middle node is 120 up: each segment loses an end, and the jump pad's landing is 900 units away
  expect(s.dropped).toBe(3)
})

test("entityLinks chains only the zipline stops that can be boarded", () => {
  const z = (id: string, i: number, p: [number, number, number]): Entity => ({ id, class: "x", kind: "zipline", position: p, properties: { path_uniqueid: "p", path_index: i } })
  const v = Float64Array.from([0, 0, 480, 1000, 0, 480])
  const links = entityLinks([z("a", 0, [0, 0, 500]), z("b", 1, [500, 0, 3000]), z("c", 2, [1000, 0, 500])], nearTest(v, 100))
  expect(links).toEqual([{ from: [0, 0, 500], to: [1000, 0, 500], kind: "zipline", bidirectional: true }])
  expect(snapLinks(links, v, 100).kept.length).toBe(1)
})

// ---- Recast on the contracts mini-map -------------------------------------------------------------------------------

test("navmesh bake on the mini-map: lane is one connected region, paths cross tile borders and detour the wall", async () => {
  const dir = miniBundle()
  // Small tiles (32 voxels = 256 units) force dozens of tile borders along the 8000-unit lane.
  const r = await bakeNavmesh(dir, { tileSize: 32, qaDir: join(dir, "qa") })
  expect(r.errors).toEqual([])
  expect(r.ok).toBe(true)
  const n = r.navmesh!
  expect(n.tiles).toBeGreaterThan(20)
  expect(n.stitchedEdges).toBeGreaterThanOrEqual(0) // flat open floor: tile borders already share vertices; see the T-junction unit tests
  expect(n.polygons).toBeGreaterThan(100)
  expect(sha(join(dir, n.file))).toBe(n.sha256)
  expect(readFileSync(join(dir, n.file)).length).toBe(n.bytes)
  expect(existsSync(join(dir, "qa/navmesh.obj"))).toBe(true)
  expect(r.qaFile).toBe(join(dir, "qa/navmesh.obj"))
  // The open arena is the dominant region; the enclosed building interior, roof and ledge are separate islands.
  expect(n.components).toBeGreaterThan(1)
  expect(n.largestComponentShare).toBeGreaterThan(0.8)

  const nm = NavMesh.load(rd(join(dir, n.file)))
  expect(nm.polyCount).toBe(n.polygons)
  const a = nm.nearestPoint([-3500, 0, 0], { maxDist: 100 })!, b = nm.nearestPoint([3500, 0, 0], { maxDist: 100 })!
  expect(Math.abs(a.point[2])).toBeLessThanOrEqual(4) // walkable surface is the floor (Z up), within one voxel height
  const path = nm.findPath(a.point, b.point, WALK)
  expect(path).not.toBeNull()
  expect(path!.cost).toBeGreaterThan(7000) // lane 2 is blocked at x=0 by the wall: the path has to leave y in [-300, 300]
  expect(path!.cost).toBeLessThan(8500)
  expect(path!.points.some((p) => Math.abs(p[1]) > 300)).toBe(true)
  // Straight across lane 1 (no wall): close to the Euclidean distance.
  const c = nm.nearestPoint([-3500, -2000, 0], { maxDist: 100 })!, d = nm.nearestPoint([3500, -2000, 0], { maxDist: 100 })!
  const flat = nm.findPath(c.point, d.point, WALK)!
  expect(flat.cost).toBeGreaterThan(7000)
  expect(flat.cost).toBeLessThan(7600)
  // The ledge (z=600) is not reachable from the floor.
  const ledge = nm.nearestPoint([1500, -1000, 600], { maxDist: 100 })
  expect(ledge).not.toBeNull()
  expect(nm.findPath(a.point, ledge!.point, WALK)).toBeNull()
}, BAKE_TIMEOUT_MS)

test("navmesh bake is deterministic, cached, recorded in the manifest and validated by inspect", async () => {
  const dir = miniBundle()
  expect((await bakeBundle(dir)).ok).toBe(true) // inspect expects the collision/grid stage next to the navmesh
  const first = await bakeNavmesh(dir, { qaDir: false })
  expect(first.ok).toBe(true)
  const h = sha(join(dir, "baked/navmesh.bin"))
  const again = await bakeNavmesh(dir, { qaDir: false })
  expect(again.cached).toBe(true)
  const forced = await bakeNavmesh(dir, { qaDir: false, force: true })
  expect(forced.cached).toBe(false)
  expect(sha(join(dir, "baked/navmesh.bin"))).toBe(h)
  // A different agent changes the key and the mesh.
  const wide = await bakeNavmesh(dir, { qaDir: false, agent: { radius: 48 } })
  expect(wide.cached).toBe(false)
  expect(wide.navmesh!.inputKey).not.toBe(first.navmesh!.inputKey)
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  expect(manifest.baked.navmesh.inputKey).toBe(wide.navmesh!.inputKey)
  const rep = await inspectBundle(dir)
  expect(rep.errors).toEqual([])
  expect((rep.info["navmesh"] as { polygons: number }).polygons).toBe(wide.navmesh!.polygons)
}, BAKE_TIMEOUT_MS)

test("bake keeps baked.navmesh when the collision/grid stage re-runs", async () => {
  const dir = miniBundle()
  expect((await bakeBundle(dir)).ok).toBe(true)
  expect((await bakeNavmesh(dir, { qaDir: false })).ok).toBe(true)
  expect((await bakeBundle(dir, { force: true })).ok).toBe(true)
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  expect(manifest.baked.navmesh.file).toBe("baked/navmesh.bin")
  expect(manifest.baked.bvh.file).toBe("baked/collision.bvh")
  expect((await bakeNavmesh(dir, { qaDir: false })).cached).toBe(true)
}, BAKE_TIMEOUT_MS)

test("navmesh bake error paths", async () => {
  const dir = miniBundle()
  expect((await bakeNavmesh(join(dir, "nope"))).ok).toBe(false)
  const noGeom = await bakeNavmesh(dir, { excludeLayers: ["solid", "window"], qaDir: false })
  expect(noGeom.ok).toBe(false)
  expect(noGeom.errors[0]).toContain("no collision triangles")
  expect((await bakeNavmesh(dir, { cellSize: 0, qaDir: false })).ok).toBe(false)
  // An agent too tall for anything to be walkable yields no polygons, with a clear message.
  const tall = await bakeNavmesh(dir, { agent: { height: 100000 }, qaDir: false })
  expect(tall.ok).toBe(false)
  expect(tall.errors.join(" ")).toMatch(/no polygons|Recast failed/)
})
