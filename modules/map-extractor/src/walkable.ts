import { readFileSync } from "node:fs"
import { parseNavFile, type NavFile } from "./navFile.ts"
import type { PolygonSoup } from "./navmesh.ts"

/**
 * The walkable surface: the game's own nav faces (`collision/walkable.nav`, see `navFile.ts`) cleaned into a polygon soup that
 * spatial-core can use directly (`NavMesh`) and into triangles for the floor raycaster of the sample grid.
 */

/** Where `extract` stores the game's nav file inside a bundle; `bake` uses it when present. */
export const WALKABLE_NAV_FILE = "collision/walkable.nav"
/** The game's coarse pathfinding graph over the nav faces (optional): supplies off-mesh connections. */
export const WALKABLE_FLOW_FILE = "collision/walkable.navflowmap"

export interface WalkableStats {
  readonly faces: number
  /** Faces left after dropping repeats (same vertex set) and zero-area faces. */
  readonly polygons: number
  readonly duplicateFaces: number
  readonly degenerateFaces: number
  readonly vertices: number
  /** Boundary edges split because another polygon's vertex lies on them (T-junctions). */
  readonly stitchedEdges: number
}

export interface Walkable {
  readonly soup: PolygonSoup
  /** Source nav face index (0-based; the flowmap's `nav_id` is this plus 1) -> polygon in `soup`, -1 when the face was dropped. Repeated faces share their polygon. */
  readonly faceToPolygon: Int32Array
  readonly stats: WalkableStats
}

const polyAreaXY = (V: Float64Array, p: ReadonlyArray<number>): number => {
  let a = 0
  for (let k = 0; k < p.length; k++) {
    const i = p[k]! * 3, j = p[(k + 1) % p.length]! * 3
    a += V[i]! * V[j + 1]! - V[j]! * V[i + 1]!
  }
  return Math.abs(a) / 2
}

const edgeKey = (a: number, b: number, vc: number) => (a < b ? a * vc + b : b * vc + a)

/**
 * Splits boundary edges (used by exactly one polygon) at every vertex that lies on their interior within `tol` (3D distance),
 * so both sides of a seam end up with identical sub-edges and shared-edge adjacency connects them. Game nav faces of different
 * sizes meet like this (a big quad next to two small ones). Returns the number of edges split.
 */
export const stitchTJunctions = (soup: PolygonSoup, tol = 1): { soup: PolygonSoup; stitched: number } => {
  const { vertices: V, polys } = soup
  const vc = V.length / 3
  const count = new Map<number, number>()
  for (const p of polys) for (let k = 0; k < p.length; k++) {
    const key = edgeKey(p[k]!, p[(k + 1) % p.length]!, vc)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  const cell = 64
  const grid = new Map<string, number[]>()
  const onBoundary = new Set<number>()
  const edges: Array<{ poly: number; k: number; a: number; b: number }> = []
  polys.forEach((p, poly) => {
    for (let k = 0; k < p.length; k++) {
      const a = p[k]!, b = p[(k + 1) % p.length]!
      if (count.get(edgeKey(a, b, vc)) !== 1) continue
      edges.push({ poly, k, a, b })
      onBoundary.add(a); onBoundary.add(b)
    }
  })
  for (const v of onBoundary) {
    const key = `${Math.floor(V[v * 3]! / cell)},${Math.floor(V[v * 3 + 1]! / cell)}`
    const l = grid.get(key) ?? []; l.push(v); grid.set(key, l)
  }
  const inserts = new Map<number, Map<number, number[]>>() // poly -> edge index -> vertex ids in a-to-b order
  let stitched = 0
  const tol2 = tol * tol
  for (const e of edges) {
    const ax = V[e.a * 3]!, ay = V[e.a * 3 + 1]!, az = V[e.a * 3 + 2]!
    const dx = V[e.b * 3]! - ax, dy = V[e.b * 3 + 1]! - ay, dz = V[e.b * 3 + 2]! - az
    const len2 = dx * dx + dy * dy + dz * dz
    if (len2 < 1e-9) continue
    const x0 = Math.min(ax, ax + dx) - tol, x1 = Math.max(ax, ax + dx) + tol
    const y0 = Math.min(ay, ay + dy) - tol, y1 = Math.max(ay, ay + dy) + tol
    const found: Array<{ v: number; t: number }> = []
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        for (const v of grid.get(`${gx},${gy}`) ?? []) {
          if (v === e.a || v === e.b) continue
          const px = V[v * 3]! - ax, py = V[v * 3 + 1]! - ay, pz = V[v * 3 + 2]! - az
          const t = (px * dx + py * dy + pz * dz) / len2
          if (t <= 1e-3 || t >= 1 - 1e-3) continue
          const qx = px - t * dx, qy = py - t * dy, qz = pz - t * dz
          if (qx * qx + qy * qy + qz * qz <= tol2) found.push({ v, t })
        }
      }
    }
    if (found.length === 0) continue
    found.sort((p, q) => p.t - q.t)
    const perPoly = inserts.get(e.poly) ?? new Map<number, number[]>()
    perPoly.set(e.k, found.map((f) => f.v))
    inserts.set(e.poly, perPoly)
    stitched++
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

/** Welds the pooled vertices (same position up to 1/64 unit), drops repeated and zero-area faces, and stitches T-junctions. */
export const cleanNavFaces = (nav: Pick<NavFile, "vertices" | "faces">, tJunctionTol = 1): Walkable => {
  const src = nav.vertices
  const weldId = new Int32Array(src.length / 3)
  const byPos = new Map<string, number>()
  const verts: number[] = []
  for (let i = 0; i < weldId.length; i++) {
    const x = src[i * 3]!, y = src[i * 3 + 1]!, z = src[i * 3 + 2]!
    const key = `${Math.round(x * 64)},${Math.round(y * 64)},${Math.round(z * 64)}`
    let id = byPos.get(key)
    if (id === undefined) { id = verts.length / 3; verts.push(x, y, z); byPos.set(key, id) }
    weldId[i] = id
  }
  const V = Float64Array.from(verts)
  const keyToPoly = new Map<string, number>()
  const polys: number[][] = []
  const faceToPolygon = new Int32Array(nav.faces.length).fill(-1)
  let duplicateFaces = 0, degenerateFaces = 0
  nav.faces.forEach((face, f) => {
    const p: number[] = []
    for (const v of face) { const n = weldId[v]!; if (p[p.length - 1] !== n) p.push(n) }
    if (p.length > 1 && p[0] === p[p.length - 1]) p.pop()
    if (p.length < 3 || (polyAreaXY(V, p) < 1e-3 && !isSteep(V, p))) { degenerateFaces++; return }
    const key = [...p].sort((a, b) => a - b).join(",")
    const seen = keyToPoly.get(key)
    if (seen !== undefined) { duplicateFaces++; faceToPolygon[f] = seen; return }
    keyToPoly.set(key, polys.length)
    faceToPolygon[f] = polys.length
    polys.push(p)
  })
  // Keep only vertices a polygon uses, so counts reflect the walkable surface.
  const used = new Int32Array(V.length / 3).fill(-1)
  const kept: number[] = []
  const remapped = polys.map((p) => p.map((v) => {
    if (used[v]! < 0) { used[v] = kept.length / 3; kept.push(V[v * 3]!, V[v * 3 + 1]!, V[v * 3 + 2]!) }
    return used[v]!
  }))
  const { soup, stitched } = stitchTJunctions({ vertices: Float64Array.from(kept), polys: remapped }, tJunctionTol)
  return {
    soup, faceToPolygon,
    stats: { faces: nav.faces.length, polygons: soup.polys.length, duplicateFaces, degenerateFaces, vertices: soup.vertices.length / 3, stitchedEdges: stitched }
  }
}

/** A face with no xy area but real extent in z is a wall-like sliver, not a degenerate point/line. */
const isSteep = (V: Float64Array, p: ReadonlyArray<number>): boolean => {
  let lo = Infinity, hi = -Infinity
  for (const v of p) { lo = Math.min(lo, V[v * 3 + 2]!); hi = Math.max(hi, V[v * 3 + 2]!) }
  return hi - lo > 1
}

export const loadWalkable = (path: string, tJunctionTol = 1): Walkable => cleanNavFaces(parseNavFile(new Uint8Array(readFileSync(path))), tJunctionTol)

/** Fan-triangulates the (convex) polygons for the floor raycaster. Vertices are shared with the soup. */
export const triangulate = (soup: PolygonSoup): { positions: Float32Array; indices: Uint32Array } => {
  let tris = 0
  for (const p of soup.polys) tris += p.length - 2
  const indices = new Uint32Array(tris * 3)
  let o = 0
  for (const p of soup.polys) for (let k = 1; k + 1 < p.length; k++) { indices[o++] = p[0]!; indices[o++] = p[k]!; indices[o++] = p[k + 1]! }
  return { positions: Float32Array.from(soup.vertices), indices }
}
