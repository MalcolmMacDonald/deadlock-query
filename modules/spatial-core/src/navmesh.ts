import type { Vec3 } from "@deadlock-query/contracts"
import { funnelPath, type Portal } from "./funnel.ts"
import { NavIndex } from "./navIndex.ts"

/** Convex polygon soup in world space (Z-up). Polygon `i` uses `indices[offsets[i]..offsets[i+1])`. */
export interface NavMeshData {
  readonly vertices: Float32Array
  readonly offsets: Uint32Array
  readonly indices: Uint32Array
}
/**
 * Off-mesh connection (zipline, jump pad, ...). Cost is distance / speed of its `kind`, unless `cost` is set.
 * `cost` (override links only; it is not serialised) is the fixed travel time in seconds: the link is then
 * usable whatever `linkSpeeds` says for its kind, except an explicit speed of 0, which switches the kind off.
 */
export interface NavLink { readonly from: Vec3; readonly to: Vec3; readonly kind: string; readonly bidirectional?: boolean; readonly cost?: number }
export interface MovementModel {
  /** Walking speed in world units per second (use 1 for plain distance). */
  readonly speed: number
  /** Speed per link `kind`; links of unlisted kinds are unusable. */
  readonly linkSpeeds?: Readonly<Record<string, number>>
}
export interface NavOverrides {
  readonly blockedPolys?: readonly number[]
  readonly addedLinks?: readonly NavLink[]
  /**
   * Extra convex ground polygons (3+ vertices, either winding). They get indices `baseCount, baseCount + 1, ...`
   * after the mesh's own polygons (`NavMesh.addedPolyStart`). A vertex within 0.5 units of an existing one is shared,
   * so a polygon that meets the mesh along an edge becomes a neighbour of it; otherwise reach it with an added link.
   */
  readonly addedPolygons?: readonly (readonly Vec3[])[]
  /** Multiplies the cost of entering the polygon. */
  readonly costMultipliers?: Readonly<Record<number, number>>
}
export interface NearestPoint { readonly point: Vec3; readonly poly: number; readonly distance: number }
export interface NavPath {
  /** From → to. Funnel-smoothed (bends only at polygon corners and link ends) unless `smooth: false`. */
  readonly points: Vec3[]
  readonly polys: number[]
  /** Travel time over the polygon graph (centroid hops); identical to `distanceField` costs, whatever `smooth` says. */
  readonly cost: number
}
export interface DistanceField {
  /** Cost (seconds under the model) at the polygon containing/nearest `p`; Infinity if unreachable. */
  costAt(p: Vec3, maxSnap?: number): number
  readonly costs: Float64Array
}

const indexes = new WeakMap<NavMeshData, NavIndex>()
const MAGIC = 0x314d564e // "NVM1"

class Heap {
  private k: number[] = []; private v: number[] = []
  get size() { return this.k.length }
  push(key: number, val: number) {
    let i = this.k.push(key) - 1; this.v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.k[p]! <= key) break
      this.k[i] = this.k[p]!; this.v[i] = this.v[p]!; i = p
    }
    this.k[i] = key; this.v[i] = val
  }
  pop(): [number, number] {
    const rk = this.k[0]!, rv = this.v[0]!
    const lk = this.k.pop()!, lv = this.v.pop()!
    const n = this.k.length
    if (n > 0) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && this.k[c + 1]! < this.k[c]!) c++
        if (this.k[c]! >= lk) break
        this.k[i] = this.k[c]!; this.v[i] = this.v[c]!; i = c
      }
      this.k[i] = lk; this.v[i] = lv
    }
    return [rk, rv]
  }
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** Moves both ends of a portal edge toward each other by `r`, never past the middle. */
const insetPortal = (a: Vec3, b: Vec3, r: number): [Vec3, Vec3] => {
  const len = dist(a, b)
  if (len < 1e-6) return [a, b]
  const t = Math.min(r, len / 2 - 1e-3 * len) / len
  const lerp = (u: Vec3, v: Vec3): Vec3 => [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t]
  return [lerp(a, b), lerp(b, a)]
}

type Edge = { to: number; a: number; b: number } // shared edge vertex indices
type LinkEdge = { to: number; kind: string; len: number; from3: Vec3; to3: Vec3; cost?: number | undefined }

/** Appends `polys` to `data`, sharing vertices that coincide (within 0.5 units) with existing ones. */
const withPolygons = (data: NavMeshData, polys: readonly (readonly Vec3[])[]): NavMeshData => {
  const key = (x: number, y: number, z: number) => `${Math.round(x * 2)},${Math.round(y * 2)},${Math.round(z * 2)}`
  const byKey = new Map<string, number>()
  const V = data.vertices
  for (let i = 0; i < V.length / 3; i++) byKey.set(key(V[i * 3]!, V[i * 3 + 1]!, V[i * 3 + 2]!), i)
  const verts: number[] = [], idx: number[] = [], offs: number[] = []
  let vc = V.length / 3
  for (const poly of polys) {
    if (poly.length < 3) throw new Error("added polygon needs at least 3 vertices")
    const ids = poly.map((v) => {
      const k = key(v[0], v[1], v[2])
      let id = byKey.get(k)
      if (id === undefined) { id = vc++; byKey.set(k, id); verts.push(v[0], v[1], v[2]) }
      return id
    })
    offs.push(ids.length)
    idx.push(...ids)
  }
  const vertices = new Float32Array(V.length + verts.length); vertices.set(V); vertices.set(verts, V.length)
  const offsets = new Uint32Array(data.offsets.length + polys.length); offsets.set(data.offsets)
  let acc = data.indices.length
  offs.forEach((n, i) => { acc += n; offsets[data.offsets.length + i] = acc })
  const indices = new Uint32Array(acc); indices.set(data.indices); indices.set(idx, data.indices.length)
  return { vertices, offsets, indices }
}

export class NavMesh {
  readonly polyCount: number
  private readonly centroids: Float64Array
  private readonly adj: Edge[][]
  private readonly links: LinkEdge[][]
  private readonly blocked: Uint8Array
  private readonly mult: Float64Array
  /** Fastest link rate (units per second) among links with a fixed `cost`; keeps the A* heuristic admissible. */
  private fixedLinkRate = 0
  readonly data: NavMeshData
  /** Index of the first polygon added by `overrides.addedPolygons` (equals `polyCount` when there are none). */
  readonly addedPolyStart: number

  private constructor(private readonly baseData: NavMeshData, private readonly srcLinks: readonly NavLink[], private readonly overrides: NavOverrides = {}) {
    this.addedPolyStart = baseData.offsets.length - 1
    const data = (this.data = overrides.addedPolygons?.length ? withPolygons(baseData, overrides.addedPolygons) : baseData)
    const n = (this.polyCount = data.offsets.length - 1)
    this.centroids = new Float64Array(n * 3)
    for (let p = 0; p < n; p++) {
      let x = 0, y = 0, z = 0
      const s = data.offsets[p]!, e = data.offsets[p + 1]!
      for (let k = s; k < e; k++) { const v = data.indices[k]! * 3; x += data.vertices[v]!; y += data.vertices[v + 1]!; z += data.vertices[v + 2]! }
      const c = e - s
      this.centroids.set([x / c, y / c, z / c], p * 3)
    }
    this.adj = Array.from({ length: n }, () => [])
    const edges = new Map<number, { p: number; a: number; b: number }>()
    const vc = data.vertices.length / 3
    for (let p = 0; p < n; p++) {
      const s = data.offsets[p]!, e = data.offsets[p + 1]!
      for (let k = s; k < e; k++) {
        const a = data.indices[k]!, b = data.indices[k + 1 < e ? k + 1 : s]!
        const key = Math.min(a, b) * vc + Math.max(a, b)
        const o = edges.get(key)
        if (o && o.p !== p) { this.adj[p]!.push({ to: o.p, a, b }); this.adj[o.p]!.push({ to: p, a, b }); edges.delete(key) }
        else edges.set(key, { p, a, b })
      }
    }
    this.blocked = new Uint8Array(n)
    for (const p of overrides.blockedPolys ?? []) this.blocked[p] = 1
    this.mult = new Float64Array(n).fill(1)
    for (const [p, m] of Object.entries(overrides.costMultipliers ?? {})) this.mult[Number(p)] = m
    this.links = Array.from({ length: n }, () => [])
    for (const l of [...srcLinks, ...(overrides.addedLinks ?? [])]) {
      const a = this.nearestPoly(l.from), b = this.nearestPoly(l.to)
      if (a < 0 || b < 0) continue
      const len = dist(l.from, l.to)
      const cost = l.cost !== undefined && l.cost >= 0 ? l.cost : undefined
      if (cost !== undefined && len > 0) this.fixedLinkRate = Math.max(this.fixedLinkRate, len / Math.max(cost, 1e-9))
      this.links[a]!.push({ to: b, kind: l.kind, len, from3: l.from, to3: l.to, cost })
      if (l.bidirectional ?? true) this.links[b]!.push({ to: a, kind: l.kind, len, from3: l.to, to3: l.from, cost })
    }
  }

  static fromPolygons(data: NavMeshData, links: readonly NavLink[] = []): NavMesh { return new NavMesh(data, links) }

  /** Same mesh with blocked polygons, extra polygons and links, and cost multipliers applied (replaces overrides already on the mesh). */
  withOverrides(o: NavOverrides): NavMesh { return new NavMesh(this.baseData, this.srcLinks, o) }

  /** Source off-mesh links (without `withOverrides` additions). */
  get sourceLinks(): readonly NavLink[] { return this.srcLinks }

  centroid(poly: number): Vec3 { const c = this.centroids; return [c[poly * 3]!, c[poly * 3 + 1]!, c[poly * 3 + 2]!] }

  private nearestPoly(p: Vec3): number { return this.nearestPoint(p)?.poly ?? -1 }

  /** Closest point on the mesh (any polygon), via an XY grid index built on first use and shared by `withOverrides` copies. */
  nearestPoint(p: Vec3, opts: { maxDist?: number } = {}): NearestPoint | null {
    let ix = indexes.get(this.data)
    if (!ix) indexes.set(this.data, (ix = new NavIndex(this.data)))
    return ix.nearest(p, opts.maxDist)
  }

  private edgeCost(from: number, to: number, speed: number): number {
    return (dist(this.centroid(from), this.centroid(to)) * this.mult[to]!) / speed
  }

  private neighbours(p: number, m: MovementModel, f: (to: number, cost: number, link?: LinkEdge) => void) {
    for (const e of this.adj[p]!) if (!this.blocked[e.to]) f(e.to, this.edgeCost(p, e.to, m.speed))
    for (const l of this.links[p]!) {
      const sp = m.linkSpeeds?.[l.kind]
      if (this.blocked[l.to]) continue
      if (l.cost !== undefined) { if (sp !== 0) f(l.to, l.cost * this.mult[l.to]!, l) }
      else if (sp) f(l.to, (l.len * this.mult[l.to]!) / sp, l)
    }
  }

  /** Multi-source Dijkstra over the polygon graph; cost is travel time under `model`. */
  distanceField(sources: readonly Vec3[], model: MovementModel, opts?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): DistanceField {
    if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError")
    const costs = new Float64Array(this.polyCount).fill(Infinity)
    const h = new Heap()
    for (const s of sources) {
      const p = this.nearestPoly(s)
      if (p >= 0 && !this.blocked[p]) { costs[p] = 0; h.push(0, p) }
    }
    let processed = 0
    while (h.size) {
      if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError")
      const [c, p] = h.pop()
      if (c > costs[p]!) continue
      this.neighbours(p, model, (to, w) => {
        if (c + w < costs[to]!) { costs[to] = c + w; h.push(c + w, to) }
      })
      processed++
      if (opts?.onProgress) opts.onProgress(processed, this.polyCount)
    }
    return { costs, costAt: (pt, maxSnap) => {
      const n = this.nearestPoint(pt, maxSnap === undefined ? {} : { maxDist: maxSnap })
      return n ? costs[n.poly]! : Infinity
    } }
  }

  /**
   * A* over polygons. `points` are funnel-smoothed by default; `smooth: false` gives from → shared-edge
   * midpoints → to. `radius` (default 0) keeps funnel corners that far from the portal ends (polygon vertices, which
   * is where walls are), clamped so a gap narrower than `2 * radius` still passes at its middle; it only changes
   * `points`, never `polys` or `cost`.
   */
  findPath(from: Vec3, to: Vec3, model: MovementModel, opts?: { signal?: AbortSignal; smooth?: boolean; radius?: number }): NavPath | null {
    if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError")
    const a = this.nearestPoly(from), b = this.nearestPoly(to)
    if (a < 0 || b < 0 || this.blocked[a] || this.blocked[b]) return null
    const g = new Float64Array(this.polyCount).fill(Infinity), prev = new Int32Array(this.polyCount).fill(-1)
    const via: (LinkEdge | undefined)[] = new Array(this.polyCount)
    const goal = this.centroid(b), h = new Heap()
    const hf = (p: number) => dist(this.centroid(p), goal) / Math.max(model.speed, this.fixedLinkRate, ...Object.values(model.linkSpeeds ?? {}))
    g[a] = 0; h.push(hf(a), a)
    while (h.size) {
      if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError")
      const [, p] = h.pop()
      if (p === b) break
      this.neighbours(p, model, (n, w, link) => {
        if (g[p]! + w < g[n]!) { g[n] = g[p]! + w; prev[n] = p; via[n] = link; h.push(g[n]! + hf(n), n) }
      })
    }
    if (!Number.isFinite(g[b]!)) return null
    const polys: number[] = []
    for (let p = b; p >= 0; p = prev[p]!) polys.push(p)
    polys.reverse()
    const points = opts?.smooth === false ? this.midpointRoute(from, to, polys, via) : this.funnelRoute(from, to, polys, via, opts?.radius ?? 0)
    return { points, polys, cost: g[b]! }
  }

  /**
   * True when the straight segment a→b stays on the mesh: sampled every `step` units (default 32), each sample must be
   * within `tol` (default 24) of the mesh in 3D. Cheap approximation of "can walk it in a line"; polygons are not
   * required to be connected, so it also holds across a thin gap smaller than `tol`.
   */
  walkable(a: Vec3, b: Vec3, opts: { step?: number; tol?: number } = {}): boolean {
    const step = opts.step ?? 32, tol = opts.tol ?? 24
    const n = Math.max(1, Math.ceil(dist(a, b) / step))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const n2 = this.nearestPoint([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], { maxDist: tol })
      if (!n2 || this.blocked[n2.poly]) return false
    }
    return true
  }

  /**
   * Exact line test: walks the segment a→b from polygon to polygon (convex clipping in XY), failing at the first border
   * edge nobody can cross (open wall, blocked neighbour) or where the mesh height at the crossing differs from the
   * segment's by more than `zTol` (default 24). Starts on the polygon nearest `a` within `zTol` and succeeds when
   * `b` falls inside the polygon reached. Link hops are not walkable. Unlike `walkable` it never steps across a gap.
   */
  walkExact(a: Vec3, b: Vec3, opts: { zTol?: number } = {}): boolean {
    const zTol = opts.zTol ?? 24
    const start = this.nearestPoint(a, { maxDist: zTol })
    if (!start || this.blocked[start.poly]) return false
    const d = this.data, V = d.vertices
    const dx = b[0] - a[0], dy = b[1] - a[1]
    let poly = start.poly, prev = -1, tCur = 0
    for (let step = 0; step < this.polyCount + 8; step++) {
      const s = d.offsets[poly]!, e = d.offsets[poly + 1]!
      let area = 0
      for (let k = s; k < e; k++) {
        const i = d.indices[k]! * 3, j = d.indices[k + 1 < e ? k + 1 : s]! * 3
        area += V[i]! * V[j + 1]! - V[j]! * V[i + 1]!
      }
      const sign = area >= 0 ? 1 : -1 // outward normal of edge (p→q) is sign * (qy - py, px - qx)
      let tExit = 1, exitK = -1
      for (let k = s; k < e; k++) {
        const i = d.indices[k]! * 3, j = d.indices[k + 1 < e ? k + 1 : s]! * 3
        const nx = sign * (V[j + 1]! - V[i + 1]!), ny = sign * (V[i]! - V[j]!)
        const den = nx * dx + ny * dy
        if (den <= 1e-12) continue
        const t = (nx * (V[i]! - a[0]) + ny * (V[i + 1]! - a[1])) / den
        if (t < tExit) { tExit = t; exitK = k }
      }
      if (exitK < 0) return true
      tExit = Math.max(tExit, tCur)
      const ia = d.indices[exitK]!, ib = d.indices[exitK + 1 < e ? exitK + 1 : s]!
      const next = this.adj[poly]!.find((x) => x.to !== prev && ((x.a === ia && x.b === ib) || (x.a === ib && x.b === ia)))
        ?? this.adj[poly]!.find((x) => (x.a === ia && x.b === ib) || (x.a === ib && x.b === ia))
      if (!next || this.blocked[next.to]) return false
      // Mesh height where the segment crosses the shared edge.
      const ex = V[ib * 3]! - V[ia * 3]!, ey = V[ib * 3 + 1]! - V[ia * 3 + 1]!, l2 = ex * ex + ey * ey
      const cx = a[0] + dx * tExit, cy = a[1] + dy * tExit
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((cx - V[ia * 3]!) * ex + (cy - V[ia * 3 + 1]!) * ey) / l2)) : 0
      if (Math.abs(V[ia * 3 + 2]! + (V[ib * 3 + 2]! - V[ia * 3 + 2]!) * u - (a[2] + (b[2] - a[2]) * tExit)) > zTol) return false
      prev = poly; poly = next.to; tCur = tExit
    }
    return false
  }

  private edgeMidpoint(a: number, b: number): Vec3 {
    const V = this.data.vertices
    return [(V[a * 3]! + V[b * 3]!) / 2, (V[a * 3 + 1]! + V[b * 3 + 1]!) / 2, (V[a * 3 + 2]! + V[b * 3 + 2]!) / 2]
  }

  private midpointRoute(from: Vec3, to: Vec3, polys: readonly number[], via: readonly (LinkEdge | undefined)[]): Vec3[] {
    const points: Vec3[] = [from]
    for (let i = 0; i + 1 < polys.length; i++) {
      const link = via[polys[i + 1]!]
      if (link) points.push(link.from3, link.to3)
      else {
        const e = this.adj[polys[i]!]!.find((x) => x.to === polys[i + 1])!
        points.push(this.edgeMidpoint(e.a, e.b))
      }
    }
    points.push(to)
    return points
  }

  /** Funnel each stretch of polygons between off-mesh links; a link contributes its two end points. */
  private funnelRoute(from: Vec3, to: Vec3, polys: readonly number[], via: readonly (LinkEdge | undefined)[], radius = 0): Vec3[] {
    const V = this.data.vertices
    const out: Vec3[] = []
    let start = from, portals: Portal[] = [], stretch: number[] = [polys[0]!]
    const flush = (end: Vec3) => {
      const pts = funnelPath(start, end, portals)
      out.push(...(radius > 0 ? this.clearWalls(pts, stretch, radius) : pts))
    }
    for (let i = 0; i + 1 < polys.length; i++) {
      const link = via[polys[i + 1]!]
      if (link) {
        flush(link.from3)
        start = link.to3; portals = []; stretch = [polys[i + 1]!]
        continue
      }
      stretch.push(polys[i + 1]!)
      const e = this.adj[polys[i]!]!.find((x) => x.to === polys[i + 1])!
      const c = this.centroid(polys[i]!), m = this.edgeMidpoint(e.a, e.b)
      const A: Vec3 = [V[e.a * 3]!, V[e.a * 3 + 1]!, V[e.a * 3 + 2]!], B: Vec3 = [V[e.b * 3]!, V[e.b * 3 + 1]!, V[e.b * 3 + 2]!]
      // Left of the travel direction (centroid → edge midpoint) is counter-clockwise in XY.
      const side = (m[0] - c[0]) * (A[1] - c[1]) - (m[1] - c[1]) * (A[0] - c[0])
      const [pa, pb] = radius > 0 ? insetPortal(A, B, radius) : [A, B]
      portals.push(side > 0 ? [pa, pb] : [pb, pa])
    }
    flush(to)
    return out.filter((p, i) => i === 0 || p[0] !== out[i - 1]![0] || p[1] !== out[i - 1]![1] || p[2] !== out[i - 1]![2])
  }

  /** Border edges of `p` nobody can cross: no neighbour, or a blocked one. */
  private wallEdges(p: number): [Vec3, Vec3][] {
    const d = this.data, V = d.vertices, s = d.offsets[p]!, e = d.offsets[p + 1]!
    const open = new Set<number>()
    for (const x of this.adj[p]!) if (!this.blocked[x.to]) open.add(Math.min(x.a, x.b) * (V.length / 3) + Math.max(x.a, x.b))
    const out: [Vec3, Vec3][] = []
    for (let k = s; k < e; k++) {
      const a = d.indices[k]!, b = d.indices[k + 1 < e ? k + 1 : s]!
      if (open.has(Math.min(a, b) * (V.length / 3) + Math.max(a, b))) continue
      out.push([[V[a * 3]!, V[a * 3 + 1]!, V[a * 3 + 2]!], [V[b * 3]!, V[b * 3 + 1]!, V[b * 3 + 2]!]])
    }
    return out
  }

  private containsXY(p: number, x: number, y: number): boolean {
    const d = this.data, V = d.vertices, s = d.offsets[p]!, e = d.offsets[p + 1]!
    let pos = false, neg = false
    for (let k = s; k < e; k++) {
      const a = d.indices[k]! * 3, b = d.indices[k + 1 < e ? k + 1 : s]! * 3
      const c = (V[b]! - V[a]!) * (y - V[a + 1]!) - (V[b + 1]! - V[a + 1]!) * (x - V[a]!)
      if (c > 1e-9) pos = true; else if (c < -1e-9) neg = true
    }
    return !(pos && neg)
  }

  /**
   * Keeps a smoothed stretch `radius` away from the open borders (walls) of the polygons it runs through. The funnel only
   * insets portal ends, so a segment can still graze a long wall; at the worst grazing point a waypoint is pushed
   * out from the wall (skipped when that would leave the corridor). Approximate: three splits per segment at most.
   */
  private clearWalls(pts: readonly Vec3[], corridor: readonly number[], radius: number): Vec3[] {
    const walls = corridor.flatMap((p) => this.wallEdges(p))
    if (!walls.length) return [...pts]
    const near = (x: number, y: number, z: number) => {
      let best = { d: Infinity, wx: 0, wy: 0 }
      for (const [a, b] of walls) {
        const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0
        const wx = a[0] + ex * u, wy = a[1] + ey * u, wz = a[2] + (b[2] - a[2]) * u
        const d = Math.hypot(x - wx, y - wy)
        if (d < best.d && Math.abs(wz - z) < 120) best = { d, wx, wy }
      }
      return best
    }
    const out: Vec3[] = [pts[0]!]
    const fix = (a: Vec3, b: Vec3, depth: number) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.min(200, Math.ceil(len / Math.max(radius / 2, 4)))
      let worst: { d: number; wx: number; wy: number; t: number } | null = null
      for (let k = 1; k < n; k++) {
        const t = k / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t
        const w = near(x, y, a[2] + (b[2] - a[2]) * t)
        if (w.d < radius * 0.98 && (!worst || w.d < worst.d)) worst = { ...w, t }
      }
      if (worst && depth < 3) {
        const x = a[0] + (b[0] - a[0]) * worst.t, y = a[1] + (b[1] - a[1]) * worst.t
        const d = Math.hypot(x - worst.wx, y - worst.wy)
        // Away from the wall; a segment lying on it is pushed to the side of its start.
        const ux = d > 1e-6 ? (x - worst.wx) / d : -(b[1] - a[1]) / (len || 1), uy = d > 1e-6 ? (y - worst.wy) / d : (b[0] - a[0]) / (len || 1)
        const q: Vec3 = [worst.wx + ux * radius, worst.wy + uy * radius, a[2] + (b[2] - a[2]) * worst.t]
        if (corridor.some((p) => this.containsXY(p, q[0], q[1]))) { fix(a, q, depth + 1); fix(q, b, depth + 1); return }
      }
      out.push(b)
    }
    for (let i = 1; i < pts.length; i++) fix(pts[i - 1]!, pts[i]!, 0)
    return out
  }

  /** Header (magic, vertexCount, polyCount, indexCount, linkCount), vertices, offsets, indices, links (6 f32 + kind id + flags). */
  serialize(): ArrayBuffer {
    const kinds = [...new Set(this.srcLinks.map((l) => l.kind))].sort()
    const enc = new TextEncoder(), kb = enc.encode(JSON.stringify(kinds))
    const d = this.data
    const pad = (n: number) => (n + 3) & ~3
    const size = 24 + d.vertices.byteLength + d.offsets.byteLength + d.indices.byteLength + this.srcLinks.length * 32 + pad(kb.length)
    const buf = new ArrayBuffer(size), dv = new DataView(buf)
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, d.vertices.length / 3, true); dv.setUint32(8, this.polyCount, true)
    dv.setUint32(12, d.indices.length, true); dv.setUint32(16, this.srcLinks.length, true); dv.setUint32(20, kb.length, true)
    let o = 24
    new Float32Array(buf, o, d.vertices.length).set(d.vertices); o += d.vertices.byteLength
    new Uint32Array(buf, o, d.offsets.length).set(d.offsets); o += d.offsets.byteLength
    new Uint32Array(buf, o, d.indices.length).set(d.indices); o += d.indices.byteLength
    for (const l of this.srcLinks) {
      for (let i = 0; i < 3; i++) dv.setFloat32(o + i * 4, l.from[i]!, true)
      for (let i = 0; i < 3; i++) dv.setFloat32(o + 12 + i * 4, l.to[i]!, true)
      dv.setUint32(o + 24, kinds.indexOf(l.kind), true); dv.setUint32(o + 28, (l.bidirectional ?? true) ? 1 : 0, true)
      o += 32
    }
    new Uint8Array(buf, o, kb.length).set(kb)
    return buf
  }

  static load(bytes: ArrayBuffer): NavMesh {
    const dv = new DataView(bytes)
    if (dv.getUint32(0, true) !== MAGIC) throw new Error("not a NavMesh")
    const vc = dv.getUint32(4, true), pc = dv.getUint32(8, true), ic = dv.getUint32(12, true), lc = dv.getUint32(16, true), kl = dv.getUint32(20, true)
    let o = 24
    const vertices = new Float32Array(bytes.slice(o, o + vc * 12)); o += vc * 12
    const offsets = new Uint32Array(bytes.slice(o, o + (pc + 1) * 4)); o += (pc + 1) * 4
    const indices = new Uint32Array(bytes.slice(o, o + ic * 4)); o += ic * 4
    const raw: { f: Vec3; t: Vec3; k: number; b: boolean }[] = []
    for (let i = 0; i < lc; i++) {
      raw.push({ f: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)], t: [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true)], k: dv.getUint32(o + 24, true), b: dv.getUint32(o + 28, true) === 1 })
      o += 32
    }
    const kinds: string[] = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, o, kl)))
    return new NavMesh({ vertices, offsets, indices }, raw.map((r) => ({ from: r.f, to: r.t, kind: kinds[r.k]!, bidirectional: r.b })))
  }
}
