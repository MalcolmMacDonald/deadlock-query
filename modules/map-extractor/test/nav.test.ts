import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildMiniMap } from "@deadlock-query/contracts"
import { NavMesh, SampleGrid } from "@deadlock-query/spatial-core"
import { bakeBundle } from "../src/bake.ts"
import { extract } from "../src/extract.ts"
import { inspectBundle } from "../src/inspect.ts"
import { Kv3Error, parseKv3 } from "../src/kv3.ts"
import { flowLinks, parseFlowMap } from "../src/navFlow.ts"
import { NavFileError, parseNavFile } from "../src/navFile.ts"
import { bakeNavmesh, polygonComponents } from "../src/navmesh.ts"
import { cleanNavFaces, stitchTJunctions, triangulate } from "../src/walkable.ts"
import type { S2VRunner } from "../src/s2v.ts"
import { encodeKv3, encodeNavFile } from "./navFixtures.ts"

const rd = (p: string) => new Uint8Array(readFileSync(p)).buffer.slice(0) as ArrayBuffer

// ---- KV3 ------------------------------------------------------------------------------------------------------------

test("kv3 v5 reader round-trips objects, arrays, numbers, strings, booleans and null", () => {
  const v = { version: 1, name: "a b", pi: 3.25, ok: true, no: false, nothing: null, list: [1, -2, 3.5, "x"], nested: { deep: [{ i: 0 }, { i: 1 }] }, empty: [] }
  const r = parseKv3(encodeKv3(v))
  expect(r.value).toEqual(v)
  expect(r.end).toBe(encodeKv3(v).length)
})

test("kv3 reader reads a block in the middle of a file and reports where it ends", () => {
  const block = encodeKv3(null)
  const bytes = Uint8Array.from([9, 9, 9, ...block, 7, 7])
  const r = parseKv3(bytes, 3)
  expect(r.value).toBeNull()
  expect(r.end).toBe(3 + block.length)
})

test("kv3 reader rejects other versions, compression and truncation", () => {
  const good = encodeKv3({ a: 1 })
  const wrongMagic = good.slice(); wrongMagic[0] = 0x04
  expect(() => parseKv3(wrongMagic)).toThrow(Kv3Error)
  const compressed = good.slice(); compressed[20] = 1 // compression method
  expect(() => parseKv3(compressed)).toThrow(/compression method 1/)
  expect(() => parseKv3(good.slice(0, 60))).toThrow(Kv3Error)
  expect(() => parseKv3(good.slice(0, good.length - 8))).toThrow(Kv3Error)
})

// ---- .nav ------------------------------------------------------------------------------------------------------------

type P3 = readonly [number, number, number]
/** Mini-map walkable surface (Z up): lane floor split around the wall at x = 0, plus the high ledge. Every face has its own vertices. */
const MINI_FACES: ReadonlyArray<ReadonlyArray<P3>> = [
  [[-4000, -3000, 0], [-20, -3000, 0], [-20, 3000, 0], [-4000, 3000, 0]], // L
  [[20, -3000, 0], [4000, -3000, 0], [4000, 3000, 0], [20, 3000, 0]], // R
  [[-20, 300, 0], [20, 300, 0], [20, 3000, 0], [-20, 3000, 0]], // TOP: meets L and R along T-junctions (their edges are longer)
  [[-20, -3000, 0], [20, -3000, 0], [20, -300, 0], [-20, -300, 0]], // BOTTOM
  [[1300, -1200, 600], [1700, -1200, 600], [1700, -800, 600], [1300, -800, 600]], // LEDGE: an island
  [[20, 3000, 0], [20, 300, 0], [-20, 300, 0], [-20, 3000, 0]] // repeat of TOP, other winding start
]
const nonIndexed = (faces: ReadonlyArray<ReadonlyArray<P3>>) => {
  const vertices: number[] = []
  const idx: number[][] = []
  for (const f of faces) idx.push(f.map((p) => { vertices.push(...p); return vertices.length / 3 - 1 }))
  return { vertices, faces: idx }
}
const miniNav = () => { const n = nonIndexed(MINI_FACES); return encodeNavFile(n.vertices, n.faces) }

test("parseNavFile reads the vertex pool and face list and reports where the undecoded data starts", () => {
  const n = nonIndexed(MINI_FACES)
  const bytes = miniNav()
  const nav = parseNavFile(bytes)
  expect(nav.version).toBe(36)
  expect(Array.from(nav.vertices)).toEqual(n.vertices)
  expect(nav.faces).toEqual(n.faces)
  expect(bytes.length - nav.restOffset).toBe(4) // the fixture's 4 byte tail
})

test("parseNavFile rejects foreign, truncated and inconsistent files", () => {
  const bytes = miniNav()
  const bad = bytes.slice(); bad[0] = 0
  expect(() => parseNavFile(bad)).toThrow(NavFileError)
  expect(() => parseNavFile(bytes.slice(0, 40))).toThrow(NavFileError)
  expect(() => parseNavFile(bytes.slice(0, 400))).toThrow(/truncated/)
  expect(() => parseNavFile(encodeNavFile([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 5]]))).toThrow(/references vertex 5 of 3/)
  expect(() => parseNavFile(encodeNavFile([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1]]))).toThrow(/has 2 vertices/)
})

test("cleanNavFaces welds pooled vertices, drops repeated faces, stitches T-junctions and maps faces to polygons", () => {
  const n = nonIndexed(MINI_FACES)
  const w = cleanNavFaces({ vertices: Float32Array.from(n.vertices), faces: n.faces })
  expect(w.stats).toMatchObject({ faces: 6, polygons: 5, duplicateFaces: 1, degenerateFaces: 0, stitchedEdges: 2 })
  expect(Array.from(w.faceToPolygon)).toEqual([0, 1, 2, 3, 4, 2]) // the repeat shares TOP's polygon
  // The 4 floor polygons are one connected surface only because the T-junctions were stitched; the ledge is an island.
  expect(polygonComponents(w.soup).sizes).toEqual([4, 1])
  const raw = polygonComponents({ vertices: Float64Array.from(n.vertices), polys: n.faces.map((f) => [...f]) })
  expect(raw.sizes.length).toBe(6) // pooled, unwelded: nothing shares an edge
  expect(triangulate(w.soup).indices.length / 3).toBe(14) // L and R gained two vertices each from the stitching: 4 + 4 + 2 + 2 + 2
})

test("stitchTJunctions leaves vertices that are off the edge or on another level alone", () => {
  const soup = {
    vertices: Float64Array.from([
      0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, // a: square
      10, 5, 50, 20, 5, 50, 20, 8, 50, 10, 8, 50, // b: 50 above a's edge x = 10
      10, 2, 0, 15, 2, 0, 15, 4, 0 // c: touches a's edge at (10,2,0)
    ]),
    polys: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10]]
  }
  const { soup: s, stitched } = stitchTJunctions(soup, 1)
  expect(stitched).toBe(1)
  expect(s.polys[0]).toEqual([0, 1, 8, 2, 3]) // (10,2,0) inserted into edge 1 -> 2
  expect(s.polys[1]).toEqual([4, 5, 6, 7]) // the level-50 vertices are untouched
})

// ---- flow map --------------------------------------------------------------------------------------------------------

const miniFlow = () => encodeKv3({
  version: 1,
  hulls: [
    {
      hull_index: 0,
      nodes: [
        { i: 0, center: [0.5, 0.5, 0.5], nav_ids: [1, 2, 3, 4], connections: [{ cost: 100.5, node_index: 1, nav_id: 5 }, { cost: 10.5, node_index: 0, nav_id: 2 }], flow_map: [15, 1] },
        { i: 1, center: [1500.5, -1000.5, 600.5], nav_ids: [5], connections: null, flow_map: [15] }
      ]
    },
    { hull_index: 1, nodes: [{ i: 0, center: [0.5, 0.5, 0.5], nav_ids: [1], connections: null, flow_map: [15] }] }
  ]
})

test("parseFlowMap reads hulls, nodes and connections", () => {
  const hulls = parseFlowMap(miniFlow())
  expect(hulls.map((h) => [h.hullIndex, h.nodes.length])).toEqual([[0, 2], [1, 1]])
  expect(hulls[0]!.nodes[0]).toEqual({
    index: 0, center: [0.5, 0.5, 0.5], navIds: [1, 2, 3, 4],
    connections: [{ cost: 100.5, nodeIndex: 1, navId: 5 }, { cost: 10.5, nodeIndex: 0, navId: 2 }]
  })
  expect(hulls[0]!.nodes[1]!.connections).toEqual([])
})

test("flowLinks keeps only connections that polygon adjacency does not already provide", () => {
  const n = nonIndexed(MINI_FACES)
  const w = cleanNavFaces({ vertices: Float32Array.from(n.vertices), faces: n.faces })
  const { component } = polygonComponents(w.soup)
  const r = flowLinks(parseFlowMap(miniFlow())[0]!, { component, faceToPolygon: w.faceToPolygon, soup: w.soup })
  expect(r.skipped).toEqual({ sameComponent: 1, unresolved: 0 })
  expect(r.links).toHaveLength(1)
  const l = r.links[0]!
  expect(l.kind).toBe("navConnection")
  expect(l.bidirectional).toBe(false)
  expect(l.to).toEqual([1500, -1000, 600]) // ledge face centre
  expect(l.from[2]).toBe(0) // a floor face of node 0
})

// ---- bake on the mini map --------------------------------------------------------------------------------------------

const miniBundle = (opts: { nav?: boolean; flow?: boolean } = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-walk-"))
  const m = buildMiniMap()
  mkdirSync(join(dir, "collision"), { recursive: true })
  writeFileSync(join(dir, "collision/physics.glb"), m.collisionGlb)
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m.manifest, tiles: [] }, null, 2))
  writeFileSync(join(dir, "entities.json"), JSON.stringify({ schemaVersion: m.manifest.schemaVersion, entities: m.entities }))
  if (opts.nav !== false) writeFileSync(join(dir, "collision/walkable.nav"), miniNav())
  if (opts.flow) writeFileSync(join(dir, "collision/walkable.navflowmap"), miniFlow())
  return dir
}

test("bake takes floorHeight from the walkable nav faces and keeps the semantics on the collision BVH", async () => {
  const dir = miniBundle()
  const r = await bakeBundle(dir)
  expect(r.errors).toEqual([])
  expect(r.ok).toBe(true)
  const b = r.baked!
  expect(b.floorSource).toBe("game-nav")
  expect(b.walkable).toMatchObject({ file: "collision/walkable.nav", polygons: 5, triangles: 14 })
  expect(b.walkable!.coveredCells).toBeGreaterThan(0)
  expect(b.walkable!.coveredCells).toBeLessThanOrEqual(b.walkable!.totalCells)
  const grid = SampleGrid.deserialize(rd(join(dir, b.sampleGrid.file)))
  expect(grid.get("floorHeight", [-1968, -24])).toBeCloseTo(0, 3) // lane
  expect(grid.get("floorHeight", [1520, -1000])).toBeCloseTo(600, 3) // ledge top
  // Under the building roof (collision top 420) the nav floor is the street: the collision-only floor would be the roof.
  expect(grid.get("floorHeight", [-200, 1000])).toBeCloseTo(0, 3)
  expect(grid.get("interior", [-200, 1000])).toBe(1) // roof overhead, found by the collision BVH
  expect(grid.get("interior", [-1968, -24])).toBe(0)
  expect(grid.get("floorHeight", [5000, 0])).toBeNull()
  expect(b.bvh.triangles).toBe(120) // the collision BVH is still the whole collision GLB
})

test("bake --floor-source collision keeps the topmost collision surface; game-nav without a file is an error", async () => {
  const dir = miniBundle()
  const r = await bakeBundle(dir, { floorSource: "collision" })
  expect(r.baked!.floorSource).toBe("collision")
  expect(r.baked!.walkable).toBeUndefined()
  const grid = SampleGrid.deserialize(rd(join(dir, r.baked!.sampleGrid.file)))
  expect(grid.get("floorHeight", [-200, 1000])).toBeCloseTo(420, 3) // roof
  const none = miniBundle({ nav: false })
  const auto = await bakeBundle(none)
  expect(auto.baked!.floorSource).toBe("collision") // no nav file: falls back
  const bad = await bakeBundle(none, { floorSource: "game-nav" })
  expect(bad.ok).toBe(false)
  expect(bad.errors.join()).toContain("walkable.nav")
})

test("bake is cached until the nav file changes", async () => {
  const dir = miniBundle()
  const first = await bakeBundle(dir)
  expect((await bakeBundle(dir)).cached).toBe(true)
  const n = nonIndexed(MINI_FACES.slice(0, 2))
  writeFileSync(join(dir, "collision/walkable.nav"), encodeNavFile(n.vertices, n.faces))
  const second = await bakeBundle(dir)
  expect(second.cached).toBe(false)
  expect(second.baked!.inputKey).not.toBe(first.baked!.inputKey)
})

test("navmesh is built from the game nav faces, joins the island with flow connections and routes around the wall", async () => {
  const dir = miniBundle({ flow: true })
  await bakeBundle(dir)
  const r = await bakeNavmesh(dir, { qaDir: false })
  expect(r.errors).toEqual([])
  expect(r.ok).toBe(true)
  const n = r.navmesh!
  expect(n).toMatchObject({ source: "game-nav", polygons: 5, components: 2, tiles: 0, stitchedEdges: 2, componentsWithLinks: 1 })
  expect(n.largestComponentShare).toBeCloseTo(0.8, 5)
  expect(n.largestComponentShareWithLinks).toBe(1)
  expect(n.links.byKind["navConnection"]).toBe(1)
  expect(n.walkable).toMatchObject({ file: "collision/walkable.nav", flowFile: "collision/walkable.navflowmap", flowHull: 0, duplicateFaces: 1 })
  const nm = NavMesh.load(rd(join(dir, n.file)))
  const walk = { speed: 1 }
  const across = nm.findPath([-2000, 0, 0], [2000, 0, 0], walk)
  expect(across).not.toBeNull()
  // The wall blocks x = 0 between y = -300 and 300: the polygon route goes through TOP or BOTTOM, not straight across.
  expect(across!.cost).toBeGreaterThan(4100)
  expect(across!.cost).toBeLessThan(6000)
  expect(across!.points.some((p) => Math.abs(p[1]) >= 299)).toBe(true)
  expect(nm.findPath([-2000, 0, 0], [1500, -1000, 600], walk)).toBeNull() // the ledge needs the link
  expect(nm.findPath([-2000, 0, 0], [1500, -1000, 600], { speed: 1, linkSpeeds: { navConnection: 1 } })).not.toBeNull()
  // The manifest still decodes for contracts (the extra fields are raw-only) and inspect accepts it.
  expect((await inspectBundle(dir)).errors).toEqual([])
  // Cached on a second run, re-keyed when the flow hull changes.
  expect((await bakeNavmesh(dir, { qaDir: false })).cached).toBe(true)
  const other = await bakeNavmesh(dir, { qaDir: false, flowHull: 1 })
  expect(other.cached).toBe(false)
  expect(other.navmesh!.links.byKind["navConnection"]).toBeUndefined()
})

test("navmesh --nav-source recast ignores the nav file; game without a file is an error; a broken file is reported; missing flow map only warns", async () => {
  const dir = miniBundle()
  await bakeBundle(dir)
  const noFlow = await bakeNavmesh(dir, { qaDir: false })
  expect(noFlow.ok).toBe(true)
  expect(noFlow.warnings.join()).toContain("navflowmap")
  const recast = await bakeNavmesh(dir, { qaDir: false, source: "recast", cellSize: 20, tileSize: 64 })
  expect(recast.navmesh!.source).toBeUndefined() // Recast records carry no `source`
  const none = miniBundle({ nav: false })
  const bad = await bakeNavmesh(none, { qaDir: false, source: "game" })
  expect(bad.ok).toBe(false)
  expect(bad.errors.join()).toContain("walkable.nav")
  writeFileSync(join(dir, "collision/walkable.nav"), new Uint8Array(100))
  const broken = await bakeNavmesh(dir, { qaDir: false, force: true, source: "game" })
  expect(broken.ok).toBe(false)
  expect(broken.errors.join()).toContain("cannot read")
})

// ---- extract ---------------------------------------------------------------------------------------------------------

const VENTS = `
====0====
classname  "info_super_trooper_spawn"
bossname  "boss_rebel_t1_blue"
origin  [ 0, 0, 0 ]
`

const extractRunner = (calls: string[][], nav: "folder" | "single" | "none"): S2VRunner => async (a) => {
  calls.push([...a])
  const out = a[a.indexOf("-o") + 1]!
  const inner = a[a.indexOf("-f") + 1]!
  if (inner.endsWith(".vents_c")) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, VENTS) }
  else if (inner.endsWith("world_physics.vmdl_c")) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(`${out}.glb`, new Uint8Array(0)); writeFileSync(`${out}_physics.glb`, buildMiniMap().collisionGlb) }
  else if (inner.endsWith(".vwnod_c")) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify({ asset: { version: "2.0" }, nodes: [], meshes: [], accessors: [] })) }
  else if (inner.endsWith(".nav")) {
    if (nav === "folder") {
      // The CLI prefix-matches `.nav`, `.navspace` and `.navflowmap`: `-o` becomes a folder holding the maps/ tree.
      mkdirSync(join(out, "maps"), { recursive: true })
      writeFileSync(join(out, "maps/dl_midtown.nav"), miniNav())
      writeFileSync(join(out, "maps/dl_midtown.navflowmap"), miniFlow())
      writeFileSync(join(out, "maps/dl_midtown.navspace"), new Uint8Array(8))
    } else if (nav === "single") {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, miniNav())
    }
  }
  return { code: 0, stdout: "", stderr: "" }
}

const baseOpts = () => ({ vpk: "m.vpk", map: "dl_midtown", buildId: "1", s2vVersion: "20.0", tier: "lite" as const, outRoot: mkdtempSync(join(tmpdir(), "dlq-")) })

test("extract copies the game's nav and flow map into the bundle and bake uses them", async () => {
  const calls: string[][] = []
  const opts = { ...baseOpts(), runner: extractRunner(calls, "folder") }
  const r = await extract(opts)
  expect(r.warnings.filter((w) => w.startsWith("nav:"))).toEqual([])
  expect(calls.some((c) => c.includes("maps/dl_midtown.nav"))).toBe(true)
  expect(readFileSync(join(r.dir, "collision/walkable.nav"))).toEqual(Buffer.from(miniNav()))
  expect(existsSync(join(r.dir, "collision/walkable.navflowmap"))).toBe(true)
  expect(existsSync(join(r.dir, "collision/walkable.navspace"))).toBe(false) // 55 MB and not needed
  const n = calls.length
  await extract(opts)
  expect(calls.length).toBe(n) // every stage cached, including nav
  const baked = await bakeBundle(r.dir)
  expect(baked.baked!.floorSource).toBe("game-nav")
})

test("extract accepts a map whose only nav file is the .nav, and warns (not fails) when the map has none", async () => {
  const single = await extract({ ...baseOpts(), runner: extractRunner([], "single") })
  expect(existsSync(join(single.dir, "collision/walkable.nav"))).toBe(true)
  expect(existsSync(join(single.dir, "collision/walkable.navflowmap"))).toBe(false)
  const none = await extract({ ...baseOpts(), runner: extractRunner([], "none") })
  expect(existsSync(join(none.dir, "collision/walkable.nav"))).toBe(false)
  expect(none.warnings.some((w) => w.startsWith("nav:") && w.includes("collision surface"))).toBe(true)
})
