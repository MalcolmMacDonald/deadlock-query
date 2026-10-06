import { Triangle, Vector3 } from "three"
import type { Vec3 } from "@deadlock-query/contracts"

/** Convex polygon soup in world space (Z-up). Polygon `i` uses `indices[offsets[i]..offsets[i+1])`. */
export interface NavMeshData {
  readonly vertices: Float32Array
  readonly offsets: Uint32Array
  readonly indices: Uint32Array
}
/** Off-mesh connection (zipline, jump pad, ...). Cost is distance / speed of its `kind`. */
export interface NavLink { readonly from: Vec3; readonly to: Vec3; readonly kind: string; readonly bidirectional?: boolean }
export interface MovementModel {
  /** Walking speed in world units per second (use 1 for plain distance). */
  readonly speed: number
  /** Speed per link `kind`; links of unlisted kinds are unusable. */
  readonly linkSpeeds?: Readonly<Record<string, number>>
}
export interface NavOverrides {
  readonly blockedPolys?: readonly number[]
  readonly addedLinks?: readonly NavLink[]
  /** Multiplies the cost of entering the polygon. */
  readonly costMultipliers?: Readonly<Record<number, number>>
}
export interface NearestPoint { readonly point: Vec3; readonly poly: number; readonly distance: number }
export interface NavPath { readonly points: Vec3[]; readonly polys: number[]; readonly cost: number }
export interface DistanceField {
  /** Cost (seconds under the model) at the polygon containing/nearest `p`; Infinity if unreachable. */
  costAt(p: Vec3, maxSnap?: number): number
  readonly costs: Float64Array
}

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

type Edge = { to: number; a: number; b: number } // shared edge vertex indices
type LinkEdge = { to: number; kind: string; len: number }

export class NavMesh {
  readonly polyCount: number
  private readonly centroids: Float64Array
  private readonly adj: Edge[][]
  private readonly links: LinkEdge[][]
  private readonly blocked: Uint8Array
  private readonly mult: Float64Array

  private constructor(readonly data: NavMeshData, private readonly srcLinks: readonly NavLink[], private readonly overrides: NavOverrides = {}) {
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
      this.links[a]!.push({ to: b, kind: l.kind, len })
      if (l.bidirectional ?? true) this.links[b]!.push({ to: a, kind: l.kind, len })
    }
  }

  static fromPolygons(data: NavMeshData, links: readonly NavLink[] = []): NavMesh { return new NavMesh(data, links) }

  /** Same mesh with blocked polygons, extra links and cost multipliers applied. */
  withOverrides(o: NavOverrides): NavMesh { return new NavMesh(this.data, this.srcLinks, o) }

  centroid(poly: number): Vec3 { const c = this.centroids; return [c[poly * 3]!, c[poly * 3 + 1]!, c[poly * 3 + 2]!] }

  private nearestPoly(p: Vec3): number { return this.nearestPoint(p)?.poly ?? -1 }

  nearestPoint(p: Vec3, opts: { maxDist?: number } = {}): NearestPoint | null {
    const { vertices: V, offsets: O, indices: I } = this.data
    const tri = new Triangle(), t = new Vector3(), q = new Vector3(p[0], p[1], p[2]), best = new Vector3()
    let bd = Infinity, bp = -1
    for (let poly = 0; poly < this.polyCount; poly++) {
      const s = O[poly]!, e = O[poly + 1]!
      const v0 = I[s]! * 3
      for (let k = s + 1; k + 1 < e; k++) {
        const v1 = I[k]! * 3, v2 = I[k + 1]! * 3
        tri.a.fromArray(V, v0); tri.b.fromArray(V, v1); tri.c.fromArray(V, v2)
        tri.closestPointToPoint(q, t)
        const d = t.distanceTo(q)
        if (d < bd) { bd = d; bp = poly; best.copy(t) }
      }
    }
    if (bp < 0 || bd > (opts.maxDist ?? Infinity)) return null
    return { point: [best.x, best.y, best.z], poly: bp, distance: bd }
  }

  private edgeCost(from: number, to: number, speed: number): number {
    return (dist(this.centroid(from), this.centroid(to)) * this.mult[to]!) / speed
  }

  private neighbours(p: number, m: MovementModel, f: (to: number, cost: number) => void) {
    for (const e of this.adj[p]!) if (!this.blocked[e.to]) f(e.to, this.edgeCost(p, e.to, m.speed))
    for (const l of this.links[p]!) {
      const sp = m.linkSpeeds?.[l.kind]
      if (sp && !this.blocked[l.to]) f(l.to, (l.len * this.mult[l.to]!) / sp)
    }
  }

  /** Multi-source Dijkstra over the polygon graph; cost is travel time under `model`. */
  distanceField(sources: readonly Vec3[], model: MovementModel): DistanceField {
    const costs = new Float64Array(this.polyCount).fill(Infinity)
    const h = new Heap()
    for (const s of sources) {
      const p = this.nearestPoly(s)
      if (p >= 0 && !this.blocked[p]) { costs[p] = 0; h.push(0, p) }
    }
    while (h.size) {
      const [c, p] = h.pop()
      if (c > costs[p]!) continue
      this.neighbours(p, model, (to, w) => {
        if (c + w < costs[to]!) { costs[to] = c + w; h.push(c + w, to) }
      })
    }
    return { costs, costAt: (pt, maxSnap) => {
      const n = this.nearestPoint(pt, maxSnap === undefined ? {} : { maxDist: maxSnap })
      return n ? costs[n.poly]! : Infinity
    } }
  }

  /** A* over polygons; points run from → shared-edge midpoints → to (no funnel smoothing). */
  findPath(from: Vec3, to: Vec3, model: MovementModel): NavPath | null {
    const a = this.nearestPoly(from), b = this.nearestPoly(to)
    if (a < 0 || b < 0 || this.blocked[a] || this.blocked[b]) return null
    const g = new Float64Array(this.polyCount).fill(Infinity), prev = new Int32Array(this.polyCount).fill(-1)
    const goal = this.centroid(b), h = new Heap()
    const hf = (p: number) => dist(this.centroid(p), goal) / Math.max(model.speed, ...Object.values(model.linkSpeeds ?? {}))
    g[a] = 0; h.push(hf(a), a)
    while (h.size) {
      const [, p] = h.pop()
      if (p === b) break
      this.neighbours(p, model, (n, w) => {
        if (g[p]! + w < g[n]!) { g[n] = g[p]! + w; prev[n] = p; h.push(g[n]! + hf(n), n) }
      })
    }
    if (!Number.isFinite(g[b]!)) return null
    const polys: number[] = []
    for (let p = b; p >= 0; p = prev[p]!) polys.push(p)
    polys.reverse()
    const points: Vec3[] = [from]
    const V = this.data.vertices
    for (let i = 0; i + 1 < polys.length; i++) {
      const e = this.adj[polys[i]!]!.find((x) => x.to === polys[i + 1])
      if (e) points.push([(V[e.a * 3]! + V[e.b * 3]!) / 2, (V[e.a * 3 + 1]! + V[e.b * 3 + 1]!) / 2, (V[e.a * 3 + 2]! + V[e.b * 3 + 2]!) / 2])
      else points.push(this.centroid(polys[i + 1]!)) // off-mesh link
    }
    points.push(to)
    return { points, polys, cost: g[b]! }
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
