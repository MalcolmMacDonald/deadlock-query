import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { EntitiesFile, Manifest, decodeVersioned, type Entity, type Mat4 } from "@deadlock-query/contracts"
import { NavMesh, type NavLink } from "@deadlock-query/spatial-core"
import { init } from "recast-navigation"
import { generateTiledNavMesh } from "recast-navigation/generators"
import { loadCollisionMesh } from "./bake.ts"

/**
 * M5: Recast navmesh baked from the collision GLB, written as spatial-core's `NavMesh.serialize()` format.
 *   baked/navmesh.bin   convex polygons in Source units (Z up) + off-mesh links from entities
 *   <qa dir>/navmesh.obj  one OBJ group per connected component, for eyeballing in Blender / MeshLab
 * The manifest's `baked.navmesh` records the file, counts, agent/Recast parameters and a cache key.
 */

export const NAVMESH_BAKE_VERSION = "1.0.0"

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

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)

/**
 * Candidate off-mesh links, from the real dl_midtown entity lump (build 25738777):
 *   - ziplines: `citadel_zipline_path_node`s share a `path_uniqueid` and are ordered by `path_index`. The nodes hang in the air,
 *     so only each path's first and last node become one link (a rider can get on and off at the ends), bidirectional unless the
 *     first node has `one_way`;
 *   - jump pads: `trigger_catapult` whose `target` names an `info_target_server_only` landing point (one way; `launchTarget` is
 *     accepted as an alias).
 * Entities without a resolvable target produce no link.
 */
export const entityLinks = (entities: ReadonlyArray<Entity>): NavLink[] => {
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
    const first = nodes[0]!, last = nodes[nodes.length - 1]!
    out.push({ from: first.position, to: last.position, kind: "zipline", bidirectional: !(str(first.properties["one_way"]) === "1" || first.properties["one_way"] === true) })
  }
  return out
}

/** Keeps links whose both endpoints lie within `maxSnap` of some navmesh vertex (uniform xy grid, no polygon tests). */
export const snapLinks = (links: ReadonlyArray<NavLink>, vertices: Float64Array, maxSnap: number): { kept: NavLink[]; dropped: number } => {
  const cell = Math.max(maxSnap, 1)
  const grid = new Map<string, number[]>()
  for (let i = 0; i < vertices.length; i += 3) {
    const key = `${Math.floor(vertices[i]! / cell)},${Math.floor(vertices[i + 1]! / cell)}`
    const l = grid.get(key) ?? []; l.push(i); grid.set(key, l)
  }
  const near = (p: readonly [number, number, number]) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (Math.hypot(vertices[i]! - p[0], vertices[i + 1]! - p[1], vertices[i + 2]! - p[2]) <= maxSnap) return true
      }
    }
    return false
  }
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

  const candidates = entityLinks(entities)
  const { kept, dropped } = snapLinks(candidates, soup.vertices, maxLinkSnap)
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
