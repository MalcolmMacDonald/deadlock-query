import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { EntitiesFile, Manifest, decodeVersioned, type Entity, type Mat4 } from "@deadlock-query/contracts"
import { NavMesh, type NavLink } from "@deadlock-query/spatial-core"
import { init } from "recast-navigation"
import { generateTiledNavMesh } from "recast-navigation/generators"
import { loadCollisionMesh } from "./bake.ts"
import { flowLinks, parseFlowMap } from "./navFlow.ts"
import { WALKABLE_FLOW_FILE, WALKABLE_NAV_FILE, loadWalkable, type WalkableStats } from "./walkable.ts"

/**
 * M5: Recast navmesh baked from the collision GLB, written as spatial-core's `NavMesh.serialize()` format.
 *   baked/navmesh.bin   convex polygons in Source units (Z up) + off-mesh links from entities
 *   <qa dir>/navmesh.obj  one OBJ group per connected component, for eyeballing in Blender / MeshLab
 * The manifest's `baked.navmesh` records the file, counts, agent/Recast parameters and a cache key.
 *
 * When the bundle carries the game's own nav file (`collision/walkable.nav`, see `navFile.ts`) the mesh is taken from it instead of
 * Recast (`source: "game-nav"`): `world_physics` holds only clip volumes, so Recast over it describes clip lids, not the walkable map.
 */

export const NAVMESH_BAKE_VERSION = "1.3.0"

/** Source units. Provisional: these are Source-engine defaults, not measured from Deadlock heroes. */
export interface NavAgent { readonly radius: number; readonly height: number; readonly climb: number; readonly slopeDegrees: number }
export const DEFAULT_NAV_AGENT: NavAgent = { radius: 16, height: 72, climb: 18, slopeDegrees: 45 }

/** Collision layers that must not become walkable geometry: sky lid, foliage that players pass through, `NavIgnore` markup. */
export const DEFAULT_NAV_EXCLUDE_LAYERS: ReadonlyArray<string> = ["sky", "Citadel_Skyclip", "Citadel_Foliage", "NavIgnore"]

export interface NavmeshOptions {
  readonly agent?: Partial<NavAgent>
  /** Voxel size in the ground plane (default 8). */
  readonly cellSize?: number
  /** Voxel size vertically (default 4). */
  readonly cellHeight?: number
  /** Tile edge in voxels (default 128, i.e. 1024 units at the default cell size). */
  readonly tileSize?: number
  readonly excludeLayers?: ReadonlyArray<string>
  /** Off-mesh link endpoints farther than this from any navmesh vertex are dropped (default 256). */
  readonly maxLinkSnap?: number
  /** Directory for the OBJ QA export; `false` skips it. Default: `<bundle>.qa` next to the bundle. */
  readonly qaDir?: string | false
  /** `auto` (default): the game nav file when the bundle has one, else Recast over the collision GLB. */
  readonly source?: "auto" | "game" | "recast"
  /** Game nav only: which `.navflowmap` hull supplies the off-mesh connections (default 0, unverified to be the hero hull). */
  readonly flowHull?: number
  readonly force?: boolean
  readonly log?: ((m: string) => void) | undefined
}

export interface NavmeshRecord {
  readonly bakeVersion: string
  readonly inputKey: string
  readonly file: string
  readonly bytes: number
  readonly sha256: string
  readonly polygons: number
  readonly vertices: number
  readonly tiles: number
  /** Border edges split so neighbouring tiles share vertices (Recast tiles only meet by overlap). */
  readonly stitchedEdges: number
  readonly components: number
  /** Polygons of the largest connected component / all polygons. */
  readonly largestComponentShare: number
  readonly links: { readonly count: number; readonly dropped: number; readonly byKind: Readonly<Record<string, number>> }
  readonly agent: NavAgent
  readonly recast: { readonly cellSize: number; readonly cellHeight: number; readonly tileSize: number }
  readonly excludedLayers: ReadonlyArray<string>
  readonly inputTriangles: number
  /** Raw-only extras (not in the contracts schema yet): where the polygons came from. Absent on older bakes (= Recast). */
  readonly source?: "game-nav" | "recast"
  readonly walkable?: WalkableStats & { readonly file: string; readonly sha256: string; readonly flowFile?: string; readonly flowHull?: number }
  /** Components / largest share once off-mesh links count as connections. */
  readonly componentsWithLinks?: number
  readonly largestComponentShareWithLinks?: number
}

export interface NavmeshReport {
  readonly ok: boolean
  readonly cached: boolean
  readonly errors: string[]
  readonly warnings: string[]
  readonly navmesh?: NavmeshRecord
  readonly qaFile?: string
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")

let recastReady: Promise<void> | undefined
const ensureRecast = () => (recastReady ??= init())

export interface PolygonSoup {
  /** xyz triples, Source units. */
  readonly vertices: Float64Array
  readonly polys: number[][]
}

// ---------------------------------------------------------------------------------------------------------------------
// Polygon post-processing (pure, unit-tested)
// ---------------------------------------------------------------------------------------------------------------------

/** Welds vertices that share an xy cell and sit within `heightTol` of each other (tile borders rarely agree to the ulp). */
export const weldVertices = (positions: Float64Array, polys: ReadonlyArray<ReadonlyArray<number>>, heightTol: number, xyRes = 0.02): PolygonSoup => {
  const buckets = new Map<string, number[]>() // xy cell -> new vertex ids
  const out: number[] = []
  const remap = new Int32Array(positions.length / 3)
  for (let i = 0; i < remap.length; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!
    const key = `${Math.round(x / xyRes)},${Math.round(y / xyRes)}`
    const list = buckets.get(key) ?? []
    let id = list.find((j) => Math.abs(out[j * 3 + 2]! - z) <= heightTol)
    if (id === undefined) { id = out.length / 3; out.push(x, y, z); list.push(id); buckets.set(key, list) }
    remap[i] = id
  }
  const welded = polys.map((p) => {
    const q: number[] = []
    for (const v of p) { const n = remap[v]!; if (q[q.length - 1] !== n) q.push(n) }
    if (q.length > 1 && q[0] === q[q.length - 1]) q.pop()
    return q
  }).filter((q) => q.length >= 3)
  return { vertices: Float64Array.from(out), polys: welded }
}

const edgeKey = (a: number, b: number, vc: number) => (a < b ? a * vc + b : b * vc + a)

/**
 * Recast tiles meet by portal overlap, not by shared vertices, so polygons on either side of a tile border have
 * different vertex sets along it. For boundary edges lying on a border line, insert every border vertex that falls
 * strictly inside the edge (and at a matching height), so both sides end up with identical sub-edges and
 * spatial-core's shared-edge adjacency connects them. Returns the number of edges that were split.
 */
export const stitchTileBorders = (
  soup: PolygonSoup, lines: { readonly x: ReadonlyArray<number>; readonly y: ReadonlyArray<number> }, heightTol: number, eps = 0.05
): { soup: PolygonSoup; stitched: number } => {
  const { vertices: V, polys } = soup
  const vc = V.length / 3
  const count = new Map<number, number>()
  for (const p of polys) for (let k = 0; k < p.length; k++) {
    const key = edgeKey(p[k]!, p[(k + 1) % p.length]!, vc)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  type Ref = { poly: number; k: number; a: number; b: number }
  const inserts = new Map<number, Map<number, number[]>>() // poly -> edge index -> vertex ids (a to b order)
  let stitched = 0
  for (const axis of [0, 1] as const) {
    const along = axis === 0 ? 1 : 0
    for (const line of axis === 0 ? lines.x : lines.y) {
      const edges: Ref[] = []
      const ids = new Set<number>()
      polys.forEach((p, poly) => {
        for (let k = 0; k < p.length; k++) {
          const a = p[k]!, b = p[(k + 1) % p.length]!
          if (count.get(edgeKey(a, b, vc)) !== 1) continue
          if (Math.abs(V[a * 3 + axis]! - line) > eps || Math.abs(V[b * 3 + axis]! - line) > eps) continue
          edges.push({ poly, k, a, b }); ids.add(a); ids.add(b)
        }
      })
      if (edges.length < 2) continue
      const sorted = [...ids].sort((p, q) => V[p * 3 + along]! - V[q * 3 + along]!)
      const ts = sorted.map((v) => V[v * 3 + along]!)
      for (const e of edges) {
        const ta = V[e.a * 3 + along]!, tb = V[e.b * 3 + along]!
        const lo = Math.min(ta, tb), hi = Math.max(ta, tb)
        if (hi - lo <= 2 * eps) continue
        // First sorted vertex strictly after `lo`.
        let l = 0, r = ts.length
        while (l < r) { const m = (l + r) >> 1; if (ts[m]! <= lo + eps) l = m + 1; else r = m }
        const found: number[] = []
        for (let i = l; i < ts.length && ts[i]! < hi - eps; i++) {
          const w = sorted[i]!
          const f = (ts[i]! - ta) / (tb - ta)
          const expected = V[e.a * 3 + 2]! + f * (V[e.b * 3 + 2]! - V[e.a * 3 + 2]!)
          if (Math.abs(V[w * 3 + 2]! - expected) <= heightTol) found.push(w)
        }
        if (found.length === 0) continue
        if (tb < ta) found.reverse()
        const perPoly = inserts.get(e.poly) ?? new Map<number, number[]>()
        perPoly.set(e.k, found); inserts.set(e.poly, perPoly)
        stitched++
      }
    }
  }
  if (stitched === 0) return { soup, stitched }
  const out = polys.map((p, poly) => {
    const ins = inserts.get(poly)
    if (!ins) return p
    const q: number[] = []
    for (let k = 0; k < p.length; k++) { q.push(p[k]!); const extra = ins.get(k); if (extra) q.push(...extra) }
    return q
  })
  return { soup: { vertices: V, polys: out }, stitched }
}

/** Connected components over shared edges. `component[i]` is ordered by descending size (0 = largest). */
export const polygonComponents = (soup: PolygonSoup): { component: Int32Array; sizes: number[] } => {
  const { vertices: V, polys } = soup
  const vc = V.length / 3
  const parent = Int32Array.from({ length: polys.length }, (_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]! } return i }
  const seen = new Map<number, number>()
  polys.forEach((p, i) => {
    for (let k = 0; k < p.length; k++) {
      const key = edgeKey(p[k]!, p[(k + 1) % p.length]!, vc)
      const o = seen.get(key)
      if (o === undefined) seen.set(key, i)
      else { const a = find(o), b = find(i); if (a !== b) parent[a] = b }
    }
  })
  const rootSize = new Map<number, number>()
  for (let i = 0; i < polys.length; i++) { const r = find(i); rootSize.set(r, (rootSize.get(r) ?? 0) + 1) }
  const order = [...rootSize.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const rank = new Map(order.map(([r], i) => [r, i]))
  const component = new Int32Array(polys.length)
  for (let i = 0; i < polys.length; i++) component[i] = rank.get(find(i))!
  return { component, sizes: order.map(([, n]) => n) }
}

export const toNavMeshData = (soup: PolygonSoup) => {
  const offsets = new Uint32Array(soup.polys.length + 1)
  soup.polys.forEach((p, i) => { offsets[i + 1] = offsets[i]! + p.length })
  const indices = new Uint32Array(offsets[soup.polys.length]!)
  soup.polys.forEach((p, i) => indices.set(p, offsets[i]!))
  return { vertices: Float32Array.from(soup.vertices), offsets, indices }
}

/** OBJ with one group per connected component (largest first), fan-triangulated, Source units, Z up. */
export const navmeshObj = (soup: PolygonSoup, component: Int32Array): string => {
  const lines: string[] = ["# dlq-extract navmesh QA export: Source units, Z up, one group per connected component (0 = largest)"]
  for (let i = 0; i < soup.vertices.length; i += 3) lines.push(`v ${soup.vertices[i]!.toFixed(2)} ${soup.vertices[i + 1]!.toFixed(2)} ${soup.vertices[i + 2]!.toFixed(2)}`)
  const byComponent = new Map<number, number[]>()
  soup.polys.forEach((_, i) => { const c = component[i]!; const l = byComponent.get(c) ?? []; l.push(i); byComponent.set(c, l) })
  for (const c of [...byComponent.keys()].sort((a, b) => a - b)) {
    lines.push(`g component_${c}`)
    for (const i of byComponent.get(c)!) {
      const p = soup.polys[i]!
      for (let k = 1; k + 1 < p.length; k++) lines.push(`f ${p[0]! + 1} ${p[k]! + 1} ${p[k + 1]! + 1}`)
    }
  }
  return lines.join("\n") + "\n"
}

// ---------------------------------------------------------------------------------------------------------------------
// Links from entities
// ---------------------------------------------------------------------------------------------------------------------

/** Zipline stops may hang this far (Source units) above the navmesh: real nodes sit well above the street (47 of 129 are over 256 away). */
const ZIPLINE_SNAP = 640

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)

/**
 * Candidate off-mesh links, from the real dl_midtown entity lump (build 25738777):
 *   - ziplines: `citadel_zipline_path_node`s share a `path_uniqueid` and are ordered by `path_index`. The nodes hang in the air,
 *     so with `canBoard` only the nodes near the navmesh count as stops, and consecutive stops of a path (by `path_index`) are
 *     linked, bidirectional unless the first node has `one_way` (without `canBoard` every node is a stop);
 *   - jump pads: `trigger_catapult` whose `target` names an `info_target_server_only` landing point (one way; `launchTarget` is
 *     accepted as an alias).
 * Entities without a resolvable target produce no link.
 */
export const entityLinks = (entities: ReadonlyArray<Entity>, canBoard?: (p: readonly [number, number, number]) => boolean): NavLink[] => {
  const byName = new Map<string, Entity>()
  for (const e of entities) { const n = str(e.properties["targetname"]); if (n && !byName.has(n)) byName.set(n, e) }
  const out: NavLink[] = []
  const paths = new Map<string, Entity[]>()
  for (const e of entities) {
    if (e.kind === "zipline") {
      const p = str(e.properties["path_uniqueid"])
      if (p) (paths.get(p) ?? paths.set(p, []).get(p)!).push(e)
    } else if (e.kind === "jumpPad") {
      const t = str(e.properties["target"]) ?? str(e.properties["launchTarget"]), dest = t ? byName.get(t) : undefined
      if (dest && dest !== e) out.push({ from: e.position, to: dest.position, kind: "jumpPad", bidirectional: false })
    }
  }
  const idx = (e: Entity) => Number(e.properties["path_index"] ?? 0)
  for (const nodes of paths.values()) {
    if (nodes.length < 2) continue
    nodes.sort((a, b) => idx(a) - idx(b))
    const oneWay = str(nodes[0]!.properties["one_way"]) === "1" || nodes[0]!.properties["one_way"] === true
    // Nodes that hang too high to step on or off are skipped, and the rest are chained in order, so a path whose middle is
    // in the air still joins the ground stops at both ends (and any stop in between).
    const stops = canBoard ? nodes.filter((n) => canBoard(n.position)) : nodes
    for (let i = 0; i + 1 < stops.length; i++) out.push({ from: stops[i]!.position, to: stops[i + 1]!.position, kind: "zipline", bidirectional: !oneWay })
  }
  return out
}

/** Predicate: is a point within `maxSnap` of some navmesh vertex (uniform xy grid, no polygon tests). */
export const nearTest = (vertices: Float64Array, maxSnap: number): ((p: readonly [number, number, number]) => boolean) => {
  const cell = Math.max(maxSnap, 1)
  const grid = new Map<string, number[]>()
  for (let i = 0; i < vertices.length; i += 3) {
    const key = `${Math.floor(vertices[i]! / cell)},${Math.floor(vertices[i + 1]! / cell)}`
    const l = grid.get(key) ?? []; l.push(i); grid.set(key, l)
  }
  return (p) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (Math.hypot(vertices[i]! - p[0], vertices[i + 1]! - p[1], vertices[i + 2]! - p[2]) <= maxSnap) return true
      }
    }
    return false
  }
}

/** Keeps links whose both endpoints lie within `maxSnap` of some navmesh vertex. */
export const snapLinks = (links: ReadonlyArray<NavLink>, vertices: Float64Array, maxSnap: number): { kept: NavLink[]; dropped: number } => {
  const near = nearTest(vertices, maxSnap)
  const kept = links.filter((l) => near(l.from) && near(l.to))
  return { kept, dropped: links.length - kept.length }
}

// ---------------------------------------------------------------------------------------------------------------------
// Recast
// ---------------------------------------------------------------------------------------------------------------------

interface BuiltTiles { readonly positions: number[]; readonly polys: number[][]; readonly tiles: number; readonly lines: { x: number[]; y: number[] } }

/** Source (x, y, z-up) -> Recast (x, z, -y): a rotation, so triangle winding and "up" survive. */
const toRecast = (p: Float32Array): Float32Array => {
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) { out[i] = p[i]!; out[i + 1] = p[i + 2]!; out[i + 2] = -p[i + 1]! }
  return out
}

const buildTiles = (positions: Float32Array, indices: Uint32Array, agent: NavAgent, cs: number, ch: number, tileSize: number): BuiltTiles => {
  const r = generateTiledNavMesh(toRecast(positions), indices, {
    cs, ch, tileSize,
    walkableSlopeAngle: agent.slopeDegrees,
    walkableHeight: Math.ceil(agent.height / ch),
    walkableClimb: Math.floor(agent.climb / ch),
    walkableRadius: Math.ceil(agent.radius / cs),
    maxEdgeLen: Math.round(96 / cs),
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1
  })
  if (!r.success) throw new Error(`Recast failed: ${r.error}`)
  const nm = r.navMesh
  const pos: number[] = [], polys: number[][] = []
  const lx = new Set<number>(), ly = new Set<number>()
  let tiles = 0
  for (let t = 0; t < nm.getMaxTiles(); t++) {
    const tile = nm.getTile(t)
    const h = tile.header()
    if (!h || h.polyCount() === 0) continue
    tiles++
    lx.add(Math.round(h.bmin(0) * 100) / 100); lx.add(Math.round(h.bmax(0) * 100) / 100)
    ly.add(Math.round(-h.bmin(2) * 100) / 100); ly.add(Math.round(-h.bmax(2) * 100) / 100)
    const base = pos.length / 3
    for (let v = 0; v < h.vertCount(); v++) pos.push(tile.verts(v * 3), -tile.verts(v * 3 + 2), tile.verts(v * 3 + 1))
    for (let p = 0; p < h.polyCount(); p++) {
      const poly = tile.polys(p)
      if (poly.getType() !== 0) continue // off-mesh connection placeholder
      const q: number[] = []
      for (let k = 0; k < poly.vertCount(); k++) q.push(base + poly.verts(k))
      polys.push(q)
    }
  }
  nm.destroy()
  return { positions: pos, polys, tiles, lines: { x: [...lx], y: [...ly] } }
}

const inputKey = (parts: unknown) => sha256(JSON.stringify(parts)).slice(0, 16)

export const bakeNavmesh = async (dir: string, o: NavmeshOptions = {}): Promise<NavmeshReport> => {
  const errors: string[] = [], warnings: string[] = []
  const fail = (e: string): NavmeshReport => ({ ok: false, cached: false, errors: [...errors, e], warnings })
  let manifest: Manifest
  try {
    manifest = await Effect.runPromise(decodeVersioned(Manifest, 1)(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))))
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  if (!manifest.collision) return fail("manifest has no collision reference: nothing to bake (run extract first)")
  const collisionPath = join(dir, manifest.collision.file)
  if (!existsSync(collisionPath)) return fail(`missing collision file ${manifest.collision.file}`)
  const agent: NavAgent = { ...DEFAULT_NAV_AGENT, ...o.agent }
  const cs = o.cellSize ?? 8, ch = o.cellHeight ?? 4, tileSize = o.tileSize ?? 128
  if (![agent.radius, agent.height, agent.climb, agent.slopeDegrees, cs, ch, tileSize].every((n) => n > 0)) return fail("agent and Recast parameters must be > 0")
  const exclude = [...(o.excludeLayers ?? DEFAULT_NAV_EXCLUDE_LAYERS)].sort()
  const maxLinkSnap = o.maxLinkSnap ?? 256

  let entities: ReadonlyArray<Entity> = []
  let entitiesHash = "none"
  try {
    const raw = readFileSync(join(dir, manifest.entitiesFile), "utf8")
    entitiesHash = sha256(raw)
    entities = (await Effect.runPromise(decodeVersioned(EntitiesFile, 1)(JSON.parse(raw)))).entities
  } catch (e) {
    warnings.push(`entities unreadable, no off-mesh links: ${e instanceof Error ? e.message : String(e)}`)
  }

  const source = o.source ?? "auto"
  const hasGameNav = existsSync(join(dir, WALKABLE_NAV_FILE))
  if (source === "game" && !hasGameNav) return fail(`no game nav file at ${WALKABLE_NAV_FILE}: re-run extract on a map that ships a .nav`)
  if (hasGameNav && source !== "recast") return bakeGameNavmesh(dir, entities, entitiesHash, errors, warnings, o)

  const key = inputKey({
    v: NAVMESH_BAKE_VERSION, collision: sha256(readFileSync(collisionPath)), glbToWorld: manifest.collision.glbToWorld,
    exclude, agent, cs, ch, tileSize, maxLinkSnap, entities: entitiesHash
  })
  const rawManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>
  const prev = (rawManifest["baked"] as { navmesh?: NavmeshRecord } | undefined)?.navmesh
  const navPath = join(dir, "baked", "navmesh.bin")
  const qaDir = o.qaDir === false ? undefined : (o.qaDir ?? `${dir.replace(/[\\/]+$/, "")}.qa`)
  if (!o.force && prev?.inputKey === key && existsSync(navPath)) {
    o.log?.("navmesh: cached")
    return { ok: true, cached: true, errors, warnings, navmesh: prev }
  }

  o.log?.("navmesh: loading collision")
  const mesh = await loadCollisionMesh(collisionPath, manifest.collision.glbToWorld as Mat4, exclude)
  if (mesh.indices.length === 0) return fail(`no collision triangles left after excluding layers ${exclude.join(", ") || "(none)"}`)
  o.log?.(`navmesh: ${mesh.indices.length / 3} triangles, building Recast tiles (cell ${cs}x${ch}, tile ${tileSize} voxels)`)
  await ensureRecast()
  let built: BuiltTiles
  try {
    built = buildTiles(mesh.positions, mesh.indices, agent, cs, ch, tileSize)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  if (built.polys.length === 0) return fail("Recast produced no polygons: collision may have no walkable surface (check layers, agent parameters and frame)")

  const welded = weldVertices(Float64Array.from(built.positions), built.polys, agent.climb)
  const { soup, stitched } = stitchTileBorders(welded, built.lines, agent.climb)
  const { component, sizes } = polygonComponents(soup)
  const largestComponentShare = sizes[0]! / soup.polys.length
  o.log?.(`navmesh: ${built.tiles} tiles -> ${soup.polys.length} polygons, ${stitched} border edges stitched, ${sizes.length} components (largest ${(largestComponentShare * 100).toFixed(1)}%)`)

  const candidates = entityLinks(entities, nearTest(soup.vertices, Math.max(maxLinkSnap, ZIPLINE_SNAP)))
  const { kept, dropped } = snapLinks(candidates, soup.vertices, Math.max(maxLinkSnap, ZIPLINE_SNAP))
  const byKind: Record<string, number> = {}
  for (const l of kept) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1
  if (dropped > 0) warnings.push(`${dropped} off-mesh links dropped: an endpoint is more than ${maxLinkSnap} units from the navmesh`)
  if (candidates.length === 0 && entities.some((e) => e.kind === "zipline" || e.kind === "jumpPad")) {
    warnings.push("zipline/jump pad entities present but none resolved to a link: check the path_uniqueid / target property names against entities.json")
  }

  const bytes = new Uint8Array(NavMesh.fromPolygons(toNavMeshData(soup), kept).serialize())
  mkdirSync(join(dir, "baked"), { recursive: true })
  writeFileSync(navPath, bytes)
  let qaFile: string | undefined
  if (qaDir) {
    mkdirSync(qaDir, { recursive: true })
    qaFile = join(qaDir, "navmesh.obj")
    writeFileSync(qaFile, navmeshObj(soup, component))
  }

  const navmesh: NavmeshRecord = {
    bakeVersion: NAVMESH_BAKE_VERSION, inputKey: key, file: "baked/navmesh.bin", bytes: bytes.length, sha256: sha256(bytes),
    polygons: soup.polys.length, vertices: soup.vertices.length / 3, tiles: built.tiles, stitchedEdges: stitched,
    components: sizes.length, largestComponentShare,
    links: { count: kept.length, dropped, byKind },
    agent, recast: { cellSize: cs, cellHeight: ch, tileSize }, excludedLayers: exclude, inputTriangles: mesh.indices.length / 3
  }
  const baked = (rawManifest["baked"] ?? {}) as Record<string, unknown>
  rawManifest["baked"] = { ...baked, navmesh }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(rawManifest, null, 2) + "\n")
  return { ok: true, cached: false, errors, warnings, navmesh, ...(qaFile ? { qaFile } : {}) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Game nav source
// ---------------------------------------------------------------------------------------------------------------------

/** Root label per polygon: shared-edge components joined further wherever a link connects the polygons nearest its endpoints. */
const labelsWithLinks = (base: Int32Array, nm: NavMesh, links: ReadonlyArray<NavLink>): Int32Array => {
  const parent = Int32Array.from({ length: base.length }, (_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]! } return i }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  // Polygons of one shared-edge component are already joined: link each polygon to the first polygon of its component.
  const first = new Map<number, number>()
  base.forEach((c, p) => { const f = first.get(c); if (f === undefined) first.set(c, p); else union(f, p) })
  for (const l of links) {
    const a = nm.nearestPoint(l.from)?.poly, b = nm.nearestPoint(l.to)?.poly
    if (a !== undefined && b !== undefined) union(a, b)
  }
  return Int32Array.from(base, (_, p) => find(p))
}

/** Connected components counting `links` as connections between the polygons nearest their endpoints (sizes, largest first). */
const componentsWithLinks = (soup: PolygonSoup, base: Int32Array, nm: NavMesh, links: ReadonlyArray<NavLink>): number[] => {
  const labels = labelsWithLinks(base, nm, links)
  const sizes = new Map<number, number>()
  for (let p = 0; p < soup.polys.length; p++) sizes.set(labels[p]!, (sizes.get(labels[p]!) ?? 0) + 1)
  return [...sizes.values()].sort((a, b) => b - a)
}

/** Islands of at most this many polygons (after links) are candidates for stitching to the main mesh. */
export const ISLAND_MAX_POLYS = 400
/** An island is joined to the nearest larger piece within this 3D distance (Source units) and at most `ISLAND_MAX_DZ` apart in height. */
export const ISLAND_SNAP = 200
export const ISLAND_MAX_DZ = 96

/**
 * Small fragments of the game nav that touch nothing (gaps at thresholds, doorways, props) get one bidirectional `navConnection`
 * link to the nearest polygon of a larger piece, when that is close in 3D and at about the same height. Fragments with nothing
 * near enough (rooftop platforms, high ledges) are left alone: they need a real traversal link (zipline, rope, jump), not a guess.
 */
export const islandLinks = (soup: PolygonSoup, labels: Int32Array): NavLink[] => {
  const n = soup.polys.length
  const c = new Float64Array(n * 3)
  soup.polys.forEach((poly, i) => {
    for (const v of poly) for (let k = 0; k < 3; k++) c[i * 3 + k]! += soup.vertices[v * 3 + k]! / poly.length
  })
  const sizes = new Map<number, number>()
  for (let p = 0; p < n; p++) sizes.set(labels[p]!, (sizes.get(labels[p]!) ?? 0) + 1)
  const cell = ISLAND_SNAP
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  for (let p = 0; p < n; p++) {
    if (sizes.get(labels[p]!)! <= ISLAND_MAX_POLYS) continue
    const k = key(c[p * 3]!, c[p * 3 + 1]!)
    ;(grid.get(k) ?? grid.set(k, []).get(k)!).push(p)
  }
  const best = new Map<number, { d: number; a: number; b: number }>()
  for (let p = 0; p < n; p++) {
    const lab = labels[p]!
    if (sizes.get(lab)! > ISLAND_MAX_POLYS) continue
    const x = c[p * 3]!, y = c[p * 3 + 1]!, z = c[p * 3 + 2]!
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const q of grid.get(`${Math.floor(x / cell) + dx},${Math.floor(y / cell) + dy}`) ?? []) {
        if (Math.abs(c[q * 3 + 2]! - z) > ISLAND_MAX_DZ) continue
        const d = Math.hypot(c[q * 3]! - x, c[q * 3 + 1]! - y, c[q * 3 + 2]! - z)
        if (d <= ISLAND_SNAP && d < (best.get(lab)?.d ?? Infinity)) best.set(lab, { d, a: p, b: q })
      }
    }
  }
  return [...best.values()].map(({ a, b }) => ({
    from: [c[a * 3]!, c[a * 3 + 1]!, c[a * 3 + 2]!] as const, to: [c[b * 3]!, c[b * 3 + 1]!, c[b * 3 + 2]!] as const, kind: "navConnection", bidirectional: true
  }))
}

/**
 * Upward traversals mirrored from the game's one-way drops (`navConnection` flow links). The game's flow map only lists ways
 * down, so rooftop and ledge platforms (orbs, camps) have no way up in the graph although players jump and mantle onto them.
 * Each drop of at least `MANTLE_MIN_DROP` and at most `MANTLE_MAX_RISE` units gets a one-way reverse link of kind `mantle`.
 * It is a separate kind on purpose: a query's `linkSpeeds` sets what climbing costs (give `mantle` a speed well under walking
 * speed, e.g. half of it) and leaves it out to forbid climbing. Set `MANTLE_LINKS` to false to stop emitting them.
 */
export const MANTLE_LINKS = true
export const MANTLE_MIN_DROP = 48
export const MANTLE_MAX_RISE = 1600
export const MANTLE_KIND = "mantle"

export const mantleLinks = (links: ReadonlyArray<NavLink>): NavLink[] =>
  !MANTLE_LINKS ? [] : links
    .filter((l) => l.kind === "navConnection" && l.bidirectional !== true && l.from[2] - l.to[2] >= MANTLE_MIN_DROP && l.from[2] - l.to[2] <= MANTLE_MAX_RISE)
    .map((l) => ({ from: l.to, to: l.from, kind: MANTLE_KIND, bidirectional: false }))

/** Navmesh from the game's own nav faces (+ entity links and the `.navflowmap` connections that polygon adjacency lacks). */
const bakeGameNavmesh = async (
  dir: string, entities: ReadonlyArray<Entity>, entitiesHash: string, errors: string[], warnings: string[], o: NavmeshOptions
): Promise<NavmeshReport> => {
  const fail = (e: string): NavmeshReport => ({ ok: false, cached: false, errors: [...errors, e], warnings })
  const navFile = join(dir, WALKABLE_NAV_FILE), flowFile = join(dir, WALKABLE_FLOW_FILE)
  const hasFlow = existsSync(flowFile)
  const maxLinkSnap = o.maxLinkSnap ?? 256
  const flowHull = o.flowHull ?? 0
  const navHash = sha256(readFileSync(navFile)), flowHash = hasFlow ? sha256(readFileSync(flowFile)) : "none"
  const key = inputKey({ v: NAVMESH_BAKE_VERSION, source: "game-nav", nav: navHash, flow: flowHash, flowHull, maxLinkSnap, entities: entitiesHash })
  const rawManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>
  const prev = (rawManifest["baked"] as { navmesh?: NavmeshRecord } | undefined)?.navmesh
  const navPath = join(dir, "baked", "navmesh.bin")
  const qaDir = o.qaDir === false ? undefined : (o.qaDir ?? `${dir.replace(/[\/]+$/, "")}.qa`)
  if (!o.force && prev?.inputKey === key && existsSync(navPath)) {
    o.log?.("navmesh: cached")
    return { ok: true, cached: true, errors, warnings, navmesh: prev }
  }

  o.log?.("navmesh: reading the game nav file")
  let walkable: ReturnType<typeof loadWalkable>
  try {
    walkable = loadWalkable(navFile)
  } catch (e) {
    return fail(`cannot read ${WALKABLE_NAV_FILE}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const { soup, stats } = walkable
  if (soup.polys.length === 0) return fail("the game nav file has no usable polygons")
  const { component, sizes } = polygonComponents(soup)
  const largestComponentShare = sizes[0]! / soup.polys.length
  o.log?.(`navmesh: ${stats.faces} faces -> ${soup.polys.length} polygons (${stats.duplicateFaces} repeated faces dropped, ${stats.stitchedEdges} T-junction edges stitched), ${sizes.length} components (largest ${(largestComponentShare * 100).toFixed(1)}%)`)

  const entityCandidates = entityLinks(entities, nearTest(soup.vertices, Math.max(maxLinkSnap, ZIPLINE_SNAP)))
  const { kept: entityKept, dropped } = snapLinks(entityCandidates, soup.vertices, Math.max(maxLinkSnap, ZIPLINE_SNAP))
  if (dropped > 0) warnings.push(`${dropped} entity off-mesh links dropped: an endpoint is more than ${maxLinkSnap} units from the navmesh`)
  let flowKept: NavLink[] = []
  if (hasFlow) {
    try {
      const hull = parseFlowMap(new Uint8Array(readFileSync(flowFile))).find((h) => h.hullIndex === flowHull)
      if (!hull) warnings.push(`navflowmap has no hull ${flowHull}: no flow connections`)
      else {
        const r = flowLinks(hull, { component, faceToPolygon: walkable.faceToPolygon, soup })
        flowKept = r.links
        o.log?.(`navmesh: hull ${flowHull}: ${r.links.length} cross-component connections as links (${r.skipped.sameComponent} within a component, ${r.skipped.unresolved} unresolved)`)
      }
    } catch (e) {
      warnings.push(`navflowmap unreadable, no flow connections: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else warnings.push(`no ${WALKABLE_FLOW_FILE}: the mesh has no game-provided jump/drop connections`)
  const mantles = mantleLinks(flowKept)
  const linked = [...entityKept, ...flowKept, ...mantles]
  const stitches = islandLinks(soup, labelsWithLinks(component, NavMesh.fromPolygons(toNavMeshData(soup), linked), linked))
  if (stitches.length > 0) o.log?.(`navmesh: ${stitches.length} small islands stitched to the nearest larger piece`)
  const links = [...linked, ...stitches]
  const byKind: Record<string, number> = {}
  for (const l of links) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1

  const nm = NavMesh.fromPolygons(toNavMeshData(soup), links)
  const bytes = new Uint8Array(nm.serialize())
  const joined = componentsWithLinks(soup, component, nm, links)
  mkdirSync(join(dir, "baked"), { recursive: true })
  writeFileSync(navPath, bytes)
  let qaFile: string | undefined
  if (qaDir) {
    mkdirSync(qaDir, { recursive: true })
    qaFile = join(qaDir, "navmesh.obj")
    writeFileSync(qaFile, navmeshObj(soup, component))
  }
  const navmesh: NavmeshRecord = {
    bakeVersion: NAVMESH_BAKE_VERSION, inputKey: key, file: "baked/navmesh.bin", bytes: bytes.length, sha256: sha256(bytes),
    polygons: soup.polys.length, vertices: soup.vertices.length / 3, tiles: 0, stitchedEdges: stats.stitchedEdges,
    components: sizes.length, largestComponentShare,
    links: { count: links.length, dropped, byKind },
    // Not applicable to the game's own mesh (zeros, not guesses); `source` says why. A contracts follow-up should make these optional.
    agent: { radius: 0, height: 0, climb: 0, slopeDegrees: 0 }, recast: { cellSize: 0, cellHeight: 0, tileSize: 0 },
    excludedLayers: [], inputTriangles: soup.polys.reduce((n, p) => n + p.length - 2, 0),
    source: "game-nav",
    walkable: { ...stats, file: WALKABLE_NAV_FILE, sha256: navHash, ...(hasFlow ? { flowFile: WALKABLE_FLOW_FILE, flowHull } : {}) },
    componentsWithLinks: joined.length, largestComponentShareWithLinks: joined[0]! / soup.polys.length
  }
  const baked = (rawManifest["baked"] ?? {}) as Record<string, unknown>
  rawManifest["baked"] = { ...baked, navmesh }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(rawManifest, null, 2) + "\n")
  return { ok: true, cached: false, errors, warnings, navmesh, ...(qaFile ? { qaFile } : {}) }
}
