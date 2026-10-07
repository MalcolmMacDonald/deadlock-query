import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { transformPoint, type Aabb, type Mat4 } from "@deadlock-query/contracts"
import { MeshoptSimplifier } from "meshoptimizer"
import { readGltfJson } from "./gltfInfo.ts"
import { mipForDensity, sampleMips, toByte, type ColorProvider, type MaterialPaint } from "./colors.ts"

/** Await before `buildLiteTiles` (the decimation pass uses the meshopt WASM simplifier). */
export const liteReady: Promise<void> = MeshoptSimplifier.ready

/**
 * Derives the `lite` render tier from a full glTF export (which has ~29 M triangles): keeps the largest primitives
 * (by bounding-box diagonal) at full detail for `fullFraction` of the triangle budget and decimates all the others
 * (meshoptimizer, per primitive) into the rest, bakes node matrices into the vertices, groups them into
 * horizontal grid tiles split to stay under a byte budget, and writes one `.glb` per tile. Materials (and the
 * image files they reference) are carried over; textures are copied unmodified.
 */

export interface LiteOptions {
  /** Total triangles to keep (default: all of them; a finite budget keeps the largest primitives and decimates the rest). */
  readonly triBudget?: number
  /**
   * Share of `triBudget` spent on the largest primitives at full detail (default 0.6). The remaining primitives are all
   * simplified by one common ratio to fit the rest, so small props survive coarsely instead of being dropped.
   * 1 disables decimation (the old behaviour: whole primitives kept or dropped).
   */
  readonly fullFraction?: number
  /** Decimation keeps at least this many triangles per primitive (all of them if it has fewer) while budget remains (default 12). */
  readonly minTris?: number
  /** Simplifier error bound relative to the primitive's extent (default 0.1). */
  readonly decimateError?: number
  /** Max bytes of one tile .glb (default 18 MB, under the 20 MB site tile budget). */
  readonly tileBytes?: number
  /** Grid cell edge in loaded-frame units (metres; default 128). */
  readonly cell?: number
  /** Bakes a `COLOR_0` (RGBA8, linear) into every vertex from the primitive's material; without it tiles stay colourless unless the export itself carries vertex colours. */
  readonly colors?: ColorProvider
  readonly log?: ((m: string) => void) | undefined
}

export interface LiteTile {
  readonly id: string
  readonly file: string // relative to outDir
  readonly bounds: Aabb // loaded frame (apply the file's glbToWorld for world space)
  readonly bytes: number
  readonly sha256: string
  readonly materials: ReadonlyArray<string>
  readonly triangles: number
}

export interface LiteColorStats { readonly primitives: number; readonly painted: number; readonly textured: number; readonly unpainted: ReadonlyArray<string> }
export interface LiteResult {
  readonly tiles: LiteTile[]; readonly keptTriangles: number; readonly totalTriangles: number; readonly textureBytes: number; readonly warnings: string[]
  /** Triangles of primitives that were split because one primitive would not fit a tile. */
  readonly splitTriangles: number
  /** Present when tiles carry `COLOR_0`. */
  readonly colors?: LiteColorStats
}

interface G {
  buffers?: Array<{ uri?: string; byteLength: number }>
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; min?: number[]; max?: number[]; normalized?: boolean }>
  meshes?: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number; mode?: number }> }>
  nodes?: Array<{ mesh?: number; matrix?: number[]; translation?: number[]; scale?: number[]; rotation?: number[]; children?: number[] }>
  scenes?: Array<{ nodes?: number[] }>
  scene?: number
  materials?: Array<Record<string, any>>
  textures?: Array<{ source?: number; sampler?: number }>
  images?: Array<{ uri?: string; name?: string }>
  samplers?: unknown[]
}

const COMP = { 5120: [1, Int8Array], 5121: [1, Uint8Array], 5122: [2, Int16Array], 5123: [2, Uint16Array], 5125: [4, Uint32Array], 5126: [4, Float32Array] } as const
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

const localMatrix = (n: NonNullable<G["nodes"]>[number]): Mat4 => {
  if (n.matrix?.length === 16) return n.matrix
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1], t = n.translation ?? [0, 0, 0], s = n.scale ?? [1, 1, 1]
  const x2 = qx! + qx!, y2 = qy! + qy!, z2 = qz! + qz!
  const xx = qx! * x2, xy = qx! * y2, xz = qx! * z2, yy = qy! * y2, yz = qy! * z2, zz = qz! * z2, wx = qw! * x2, wy = qw! * y2, wz = qw! * z2
  return [(1 - (yy + zz)) * s[0]!, (xy + wz) * s[0]!, (xz - wy) * s[0]!, 0, (xy - wz) * s[1]!, (1 - (xx + zz)) * s[1]!, (yz + wx) * s[1]!, 0,
    (xz + wy) * s[2]!, (yz - wx) * s[2]!, (1 - (xx + yy)) * s[2]!, 0, t[0]!, t[1]!, t[2]!, 1]
}
const mul = (p: Mat4, q: Mat4): Mat4 => {
  const o: number[] = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += p[k * 4 + r]! * q[c * 4 + k]!
  return o
}

/** Reads byte ranges from the glTF's external buffers without loading multi-GB files. */
class BufferReader {
  private fds = new Map<number, number>()
  constructor(private readonly g: G, private readonly dir: string) {}
  read(buffer: number, offset: number, length: number): Buffer {
    let fd = this.fds.get(buffer)
    if (fd === undefined) {
      const uri = this.g.buffers?.[buffer]?.uri
      if (!uri) throw new Error(`buffer ${buffer} has no uri (embedded buffers are not supported)`)
      fd = openSync(join(this.dir, decodeURIComponent(uri)), "r")
      this.fds.set(buffer, fd)
    }
    const out = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const n = readSync(fd, out, got, length - got, offset + got)
      if (n === 0) throw new Error(`short read from buffer ${buffer}`)
      got += n
    }
    return out
  }
  close() { for (const fd of this.fds.values()) closeSync(fd); this.fds.clear() }
}

/** Accessor data as a tightly packed typed array of `count * components` values (normalized ints expanded to float). */
const readAccessor = (g: G, r: BufferReader, idx: number): { data: Float32Array | Uint32Array; comps: number } => {
  const a = g.accessors![idx]!
  const [size, Ctor] = COMP[a.componentType as keyof typeof COMP]
  const comps = NCOMP[a.type]!
  const bv = g.bufferViews![a.bufferView!]!
  const stride = bv.byteStride ?? size * comps
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const raw = r.read(bv.buffer, base, (a.count - 1) * stride + size * comps)
  const isIdx = a.type === "SCALAR" && a.componentType !== 5126
  if (stride === size * comps && !(a.normalized && !isIdx && Ctor !== Float32Array) && (Ctor === Float32Array || Ctor === Uint32Array || Ctor === Uint16Array)) {
    // Tightly packed little-endian data: copy into an aligned buffer and view it (the generic loop below is far slower).
    const copy = new Uint8Array(raw.byteLength); copy.set(raw)
    const typed = new Ctor(copy.buffer, 0, a.count * comps)
    return { data: isIdx && Ctor !== Uint32Array ? Uint32Array.from(typed) : (typed as Float32Array | Uint32Array), comps }
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const out = isIdx ? new Uint32Array(a.count) : new Float32Array(a.count * comps)
  const get = (o: number): number => {
    switch (Ctor) {
      case Float32Array: return view.getFloat32(o, true)
      case Uint32Array: return view.getUint32(o, true)
      case Uint16Array: return view.getUint16(o, true)
      case Int16Array: return view.getInt16(o, true)
      case Uint8Array: return view.getUint8(o)
      default: return view.getInt8(o)
    }
  }
  const norm = a.normalized && !isIdx && Ctor !== Float32Array
  const div = Ctor === Uint8Array ? 255 : Ctor === Uint16Array ? 65535 : Ctor === Int8Array ? 127 : Ctor === Int16Array ? 32767 : 1
  for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) {
    const v = get(i * stride + c * size)
    out[i * comps + c] = norm ? Math.max(v / div, -1) : v
  }
  return { data: out, comps }
}

interface Cand { node: number; prim: number; mesh: number; matrix: Mat4; tris: number; /** vertices actually referenced by the indices */ verts: number; /** key of decimated indices in `decimated`, when simplified */ dec?: string; diag: number; centre: [number, number, number]; material: number; hasUv: boolean; hasColor: boolean }

/** Nodes with their world matrices (scene graph walk; no hierarchy is typical for VRF exports). */
const worldNodes = (g: G): Array<{ node: number; matrix: Mat4 }> => {
  const nodes = g.nodes ?? []
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children?.includes(i)))
  const out: Array<{ node: number; matrix: Mat4 }> = []
  const walk = (i: number, parent: Mat4 | undefined) => {
    const n = nodes[i]!
    const m = parent ? mul(parent, localMatrix(n)) : localMatrix(n)
    if (n.mesh !== undefined) out.push({ node: i, matrix: m })
    for (const c of n.children ?? []) walk(c, m)
  }
  for (const r of roots) walk(r, undefined)
  return out
}

const align4 = (n: number) => (n + 3) & ~3

const writeGlb = (path: string, json: object, bin: Uint8Array) => {
  const j = Buffer.from(JSON.stringify(json))
  const jLen = align4(j.length), bLen = align4(bin.length)
  const head = Buffer.alloc(12 + 8 + jLen + 8)
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jLen + 8 + bLen, 8)
  head.writeUInt32LE(jLen, 12); head.writeUInt32LE(0x4e4f534a, 16)
  j.copy(head, 20); head.fill(0x20, 20 + j.length, 20 + jLen)
  head.writeUInt32LE(bLen, 20 + jLen); head.writeUInt32LE(0x004e4942, 24 + jLen)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([head, Buffer.from(bin), Buffer.alloc(bLen - bin.length)]))
}

const TEXTURE_SLOTS = (m: Record<string, any>): Array<Record<string, any>> =>
  [m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture].filter(Boolean)

export const buildLiteTiles = (gltfPath: string, outDir: string, opts: LiteOptions = {}): LiteResult => {
  const triBudget = opts.triBudget ?? Infinity
  const tileBytes = opts.tileBytes ?? 18 * 1024 * 1024
  const cell = opts.cell ?? 128
  const fullFraction = Math.min(1, Math.max(0, opts.fullFraction ?? 0.6))
  const minTris = opts.minTris ?? 12
  const decimateError = opts.decimateError ?? 0.1
  const warnings: string[] = []
  const g = readGltfJson(gltfPath) as unknown as G
  const srcDir = dirname(gltfPath)
  const reader = new BufferReader(g, srcDir)
  try {
    // Fragments of one aggregate share a vertex buffer: keep recently read accessors so consecutive fragments do not re-read it.
    const accCache = new Map<number, Float32Array | Uint32Array>()
    let accBytes = 0
    const read = (idx: number): Float32Array | Uint32Array => {
      const hit = accCache.get(idx)
      if (hit) { accCache.delete(idx); accCache.set(idx, hit); return hit }
      const data = readAccessor(g, reader, idx).data
      accCache.set(idx, data); accBytes += data.byteLength
      while (accBytes > 384 * 1048576 && accCache.size > 1) {
        const [k, v] = accCache.entries().next().value!
        accCache.delete(k); accBytes -= v.byteLength
      }
      return data
    }
    const t0 = Date.now()
    const cands: Cand[] = []
    let total = 0
    // A primitive's vertex buffer is often shared by many fragments (each indexes a small part of it), so tris, size and bounds
    // come from the vertices the indices actually reference. Cached per (mesh, primitive): instances share it.
    type Info = { verts: number; lo: number[]; hi: number[] }
    const infos = new Map<string, Info | undefined>()
    const primInfo = (mesh: number, prim: number): Info | undefined => {
      const key = `${mesh}:${prim}`
      if (infos.has(key)) return infos.get(key)
      const p = g.meshes![mesh]!.primitives[prim]!
      let info: Info | undefined
      if ((p.mode ?? 4) === 4 && p.attributes["POSITION"] !== undefined) {
        const pos = read(p.attributes["POSITION"]) as Float32Array
        const nv = pos.length / 3
        const idx = p.indices !== undefined ? (read(p.indices) as Uint32Array) : undefined
        const n3 = Math.floor((idx ? idx.length : nv) / 3) * 3
        const seen = new Uint8Array(nv)
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
        let verts = 0
        for (let i = 0; i < n3; i++) {
          const v = idx ? idx[i]! : i
          if (v >= nv || seen[v]) continue
          seen[v] = 1; verts++
          for (let k = 0; k < 3; k++) { const x = pos[v * 3 + k]!; if (x < lo[k]!) lo[k] = x; if (x > hi[k]!) hi[k] = x }
        }
        if (verts > 0) info = { verts, lo, hi }
      }
      infos.set(key, info)
      return info
    }
    for (const { node, matrix } of worldNodes(g)) {
      const mesh = g.nodes![node]!.mesh!
      g.meshes![mesh]!.primitives.forEach((p, prim) => {
        if ((p.mode ?? 4) !== 4) return
        const info = primInfo(mesh, prim)
        if (!info) return
        const tris = Math.floor((p.indices !== undefined ? g.accessors![p.indices]!.count : g.accessors![p.attributes["POSITION"]!]!.count) / 3)
        total += tris
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
        for (let c = 0; c < 8; c++) {
          const q = transformPoint(matrix, [c & 1 ? info.hi[0]! : info.lo[0]!, c & 2 ? info.hi[1]! : info.lo[1]!, c & 4 ? info.hi[2]! : info.lo[2]!])
          lo = lo.map((v, i) => Math.min(v, q[i]!)); hi = hi.map((v, i) => Math.max(v, q[i]!))
        }
        cands.push({
          node, prim, mesh, matrix, tris, verts: info.verts, material: p.material ?? -1, hasUv: p.attributes["TEXCOORD_0"] !== undefined, hasColor: p.attributes["COLOR_0"] !== undefined,
          diag: Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!),
          centre: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]
        })
      })
    }
    opts.log?.(`lite render: analysed ${cands.length} primitives in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
    // Largest first, deterministic on ties.
    cands.sort((a, b) => b.diag - a.diag || a.node - b.node || a.prim - b.prim)
    const kept: Cand[] = []
    let keptTris = 0
    // Phase 1: the largest primitives at full detail, up to `fullFraction` of the budget.
    const fullBudget = fullFraction >= 1 ? triBudget : Math.floor(triBudget * fullFraction)
    const rest: Cand[] = []
    for (const c of cands) {
      if (keptTris + c.tris > fullBudget) { rest.push(c); continue }
      kept.push(c); keptTris += c.tris
    }
    // Phase 2: everything else, simplified by one common ratio so the total fits the remaining budget.
    const decimated = new Map<string, { idx: Uint32Array; tris: number; verts: number } | null>()
    let decimatedPrims = 0, decimatedFrom = 0, decimatedTo = 0, decTime = 0, decCalls = 0, decIn = 0
    if (fullFraction < 1 && rest.length) {
      // The per-primitive floor is paid first; the common ratio shares out what is left.
      const floorMass = rest.reduce((n, c) => n + Math.min(c.tris, minTris), 0)
      const ratio = Math.min(1, Math.max(0, triBudget - keptTris - floorMass) / rest.reduce((n, c) => n + c.tris, 0))
      const targetOf = (c: Cand) => Math.max(Math.floor(c.tris * ratio), Math.min(c.tris, minTris))
      // Simplify each distinct (mesh, primitive, target) once, grouped by vertex buffer so the cached reads hit. Only the vertices a
      // primitive's indices reference go to the simplifier (a fragment's buffer is often far larger than its slice of it).
      const jobs = new Map<string, { mesh: number; prim: number; target: number; acc: number }>()
      for (const c of rest) {
        const target = targetOf(c)
        if (target >= c.tris) continue
        const key = `${c.mesh}:${c.prim}:${target}`
        if (!jobs.has(key)) jobs.set(key, { mesh: c.mesh, prim: c.prim, target, acc: g.meshes![c.mesh]!.primitives[c.prim]!.attributes["POSITION"]! })
      }
      let maxNv = 0
      for (const j of jobs.values()) maxNv = Math.max(maxNv, g.accessors![j.acc]!.count)
      const scratch = new Int32Array(maxNv).fill(-1)
      const tD = Date.now()
      for (const [key, j] of [...jobs.entries()].sort((x, y) => x[1].acc - y[1].acc || x[1].mesh - y[1].mesh || x[1].prim - y[1].prim)) {
        const p = g.meshes![j.mesh]!.primitives[j.prim]!
        const pos = read(p.attributes["POSITION"]!) as Float32Array
        const src = p.indices !== undefined ? (read(p.indices) as Uint32Array) : undefined
        const n3 = Math.floor((src ? src.length : pos.length / 3) / 3) * 3
        const used: number[] = []
        const cidx = new Uint32Array(n3)
        for (let i = 0; i < n3; i++) {
          const v = src ? src[i]! : i
          let o = scratch[v]!
          if (o < 0) { o = used.length; scratch[v] = o; used.push(v) }
          cidx[i] = o
        }
        const cpos = new Float32Array(used.length * 3)
        for (let i = 0; i < used.length; i++) { const v = used[i]!; cpos[i * 3] = pos[v * 3]!; cpos[i * 3 + 1] = pos[v * 3 + 1]!; cpos[i * 3 + 2] = pos[v * 3 + 2]! }
        for (const v of used) scratch[v] = -1
        const targetIdx = j.target * 3
        let [out] = MeshoptSimplifier.simplify(cidx, cpos, 3, targetIdx, decimateError, ["Prune"])
        if (out.length > targetIdx * 1.3) { // topology blocks the error bound: fall back to the sloppy simplifier
          const [sloppy] = MeshoptSimplifier.simplifySloppy(cidx, cpos, 3, null, targetIdx, decimateError)
          if (sloppy.length < out.length) out = sloppy
        }
        let d: { idx: Uint32Array; tris: number; verts: number } | null = null
        if (out.length >= 3) {
          const seen = new Uint8Array(used.length); let verts = 0
          const orig = new Uint32Array(out.length)
          for (let i = 0; i < out.length; i++) { const v = out[i]!; if (!seen[v]) { seen[v] = 1; verts++ } orig[i] = used[v]! }
          d = { idx: orig, tris: out.length / 3, verts }
        }
        decimated.set(key, d)
        decCalls++; decIn += n3 / 3
      }
      decTime = Date.now() - tD
      // Spend the budget in priority (largest-first) order.
      for (const c of rest) {
        const target = targetOf(c)
        if (target >= c.tris) { if (keptTris + c.tris <= triBudget) { kept.push(c); keptTris += c.tris } continue }
        const key = `${c.mesh}:${c.prim}:${target}`, d = decimated.get(key)
        if (!d || keptTris + d.tris > triBudget) continue
        decimatedPrims++; decimatedFrom += c.tris; decimatedTo += d.tris
        kept.push({ ...c, tris: d.tris, verts: d.verts, dec: key }); keptTris += d.tris
      }
    }
    opts.log?.(`lite render: ${decCalls} distinct simplifications (${decIn} input triangles) took ${(decTime / 1000).toFixed(0)} s`)
    opts.log?.(`lite render: keeping ${kept.length}/${cands.length} primitives, ${keptTris}/${total} triangles (${decimatedPrims} decimated from ${decimatedFrom} to ${decimatedTo} triangles)`)

    // Group by grid cell (loaded X/Z), then fill tiles up to the byte budget.
    const colorMode = opts.colors !== undefined || kept.some((c) => c.hasColor)
    // Per-vertex colour: the material's tint times its texture sampled at the vertex's UV (mip level matched to the primitive's vertex
    // spacing in UV space), times the export's own vertex colour when it has one. Linear RGBA8, as glTF's COLOR_0.
    const colorStats = { primitives: 0, painted: 0, textured: 0 }
    const unpainted = new Set<string>()
    const rgb: [number, number, number] = [0, 0, 0]
    const paintVertices = (c: Cand, p: NonNullable<G["meshes"]>[number]["primitives"][number], srcOf: ReadonlyArray<number>, C: Uint8Array, vo: number) => {
      const n = srcOf.length
      const meshName = g.meshes![c.mesh]!.name ?? ""
      // The export carries no materials: the mesh name holds the material (`..._agg_merge_<material>_<k>_fragment<j>`, `..._mt_<material>`).
      const names = [g.materials?.[p.material ?? -1]?.["name"] as string | undefined, /_mt_(.+)$/.exec(meshName)?.[1], meshName].filter((x): x is string => !!x)
      const paint: MaterialPaint | undefined = opts.colors?.paintFor(names)
      colorStats.primitives++
      if (paint) colorStats.painted++
      else if (opts.colors && unpainted.size < 20) unpainted.add(meshName || "(unnamed)")
      const tint = paint?.tint ?? opts.colors?.fallback ?? [1, 1, 1]
      const tex = paint?.texture
      const uv = tex && p.attributes["TEXCOORD_0"] !== undefined ? (read(p.attributes["TEXCOORD_0"]) as Float32Array) : undefined
      let level = 0
      if (tex && uv) {
        colorStats.textured++
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
        for (const v of srcOf) { const u = uv[v * 2]!, w = uv[v * 2 + 1]!; if (u < u0) u0 = u; if (u > u1) u1 = u; if (w < v0) v0 = w; if (w > v1) v1 = w }
        level = mipForDensity(tex, (u1 - u0) * (v1 - v0), n)
      }
      let src: { data: Float32Array | Uint32Array; comps: number } | undefined
      if (p.attributes["COLOR_0"] !== undefined) src = readAccessor(g, reader, p.attributes["COLOR_0"])
      for (let i = 0; i < n; i++) {
        const v = srcOf[i]!
        let r = tint[0], gr = tint[1], b = tint[2]
        if (tex && uv) { sampleMips(tex, uv[v * 2]!, uv[v * 2 + 1]!, level, rgb); r *= rgb[0]; gr *= rgb[1]; b *= rgb[2] }
        // The export's own vertex colour multiplies in; its alpha is a blend weight for the game's layered shaders, not opacity, so it is dropped.
        if (src) { const k = src.comps; r *= src.data[v * k]!; gr *= src.data[v * k + 1]!; b *= src.data[v * k + 2]! }
        const d = (vo + i) * 4
        C[d] = toByte(r); C[d + 1] = toByte(gr); C[d + 2] = toByte(b); C[d + 3] = 255
      }
    }
    const estimate = (c: Cand) => c.verts * (12 + 12 + 8 + (colorMode ? 4 : 0)) + c.tris * 3 * 4
    const splitCandidate = (c: Cand): Cand[] => {
      const p = g.meshes![c.mesh]!.primitives[c.prim]!
      const pos = read(p.attributes["POSITION"]!) as Float32Array
      const src = c.dec !== undefined ? decimated.get(c.dec)!.idx : p.indices !== undefined ? (read(p.indices) as Uint32Array) : undefined
      const vertexOf = (t: number, k: number) => (src ? src[t * 3 + k]! : t * 3 + k)
      const n = c.tris
      const cen = new Float32Array(n * 3)
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
        let sum = 0
        for (let j = 0; j < 3; j++) sum += pos[vertexOf(t, j) * 3 + k]!
        const v = sum / 3
        cen[t * 3 + k] = v
        if (v < lo[k]!) lo[k] = v
        if (v > hi[k]!) hi[k] = v
      }
      const axis = hi[0]! - lo[0]! >= hi[1]! - lo[1]! && hi[0]! - lo[0]! >= hi[2]! - lo[2]! ? 0 : hi[1]! - lo[1]! >= hi[2]! - lo[2]! ? 1 : 2
      const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => cen[a * 3 + axis]! - cen[b * 3 + axis]! || a - b)
      const out: Cand[] = []
      const seen = new Uint8Array(pos.length / 3)
      const emit = (from: number, to: number) => {
        const m = to - from
        const idx = new Uint32Array(m * 3)
        let verts = 0
        const used: number[] = []
        for (let i = 0; i < m; i++) for (let k = 0; k < 3; k++) {
          const v = vertexOf(order[from + i]!, k)
          idx[i * 3 + k] = v
          if (!seen[v]) { seen[v] = 1; verts++; used.push(v) }
        }
        const wlo = [Infinity, Infinity, Infinity], whi = [-Infinity, -Infinity, -Infinity]
        const mt = c.matrix
        for (const v of used) {
          seen[v] = 0
          const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!
          const w = [mt[0]! * x + mt[4]! * y + mt[8]! * z + mt[12]!, mt[1]! * x + mt[5]! * y + mt[9]! * z + mt[13]!, mt[2]! * x + mt[6]! * y + mt[10]! * z + mt[14]!]
          for (let k = 0; k < 3; k++) { if (w[k]! < wlo[k]!) wlo[k] = w[k]!; if (w[k]! > whi[k]!) whi[k] = w[k]! }
        }
        const key = `split:${c.node}:${c.prim}:${from}`
        decimated.set(key, { idx, tris: m, verts })
        const part: Cand = {
          ...c, tris: m, verts, dec: key, diag: Math.hypot(whi[0]! - wlo[0]!, whi[1]! - wlo[1]!, whi[2]! - wlo[2]!),
          centre: [(wlo[0]! + whi[0]!) / 2, (wlo[1]! + whi[1]!) / 2, (wlo[2]! + whi[2]!) / 2]
        }
        if (estimate(part) > tileBytes && m > 1) {
          decimated.delete(key)
          const mid = from + (m >> 1)
          emit(from, mid); emit(mid, to)
        } else out.push(part)
      }
      emit(0, n)
      return out
    }
    // A primitive that cannot fit one tile is cut into parts of about `tileBytes` along its longest axis (by triangle centroid),
    // so a very large mesh is never dropped; the parts then land in the grid cells of their own centres.
    let splitTriangles = 0
    const parts: Cand[] = []
    for (const c of kept) {
      if (estimate(c) <= tileBytes) { parts.push(c); continue }
      const split = splitCandidate(c)
      splitTriangles += c.tris
      parts.push(...split)
    }
    const cells = new Map<string, Cand[]>()
    for (const c of parts) {
      const key = `${Math.floor(c.centre[0] / cell)}_${Math.floor(c.centre[2] / cell)}`
      ;(cells.get(key) ?? cells.set(key, []).get(key)!).push(c)
    }
    const tileGroups: Array<{ id: string; prims: Cand[] }> = []
    const oversized: Cand[] = []
    for (const key of [...cells.keys()].sort()) {
      let part = 0, cur: Cand[] = [], bytes = 0
      const flush = () => { if (cur.length) tileGroups.push({ id: part ? `${key}_${part}` : key, prims: cur }); cur = []; bytes = 0; part++ }
      for (const c of cells.get(key)!) {
        if (bytes + estimate(c) > tileBytes && cur.length) flush()
        if (estimate(c) > tileBytes) { oversized.push(c); continue }
        cur.push(c); bytes += estimate(c)
      }
      flush()
    }

    if (oversized.length) warnings.push(`${oversized.length} primitives exceed the ${(tileBytes / 1048576).toFixed(0)} MB tile budget even after splitting (largest ${(Math.max(...oversized.map(estimate)) / 1048576).toFixed(1)} MB, ${oversized.reduce((n, c) => n + c.tris, 0)} triangles); dropped`)
    if (splitTriangles) opts.log?.(`lite render: split ${splitTriangles} triangles of oversized primitives into tile-sized parts`)

    const matName = (i: number) => (g.materials?.[i]?.name as string | undefined) ?? `material_${i}`
    const copiedImages = new Set<string>()
    let textureBytes = 0
    const tiles: LiteTile[] = []
    let tileTris = 0
    for (const { id, prims } of tileGroups) {
      // One output primitive per material, vertices concatenated with node matrices baked in.
      const byMat = new Map<number, Cand[]>()
      for (const c of prims) (byMat.get(c.material) ?? byMat.set(c.material, []).get(c.material)!).push(c)
      const chunks: Uint8Array[] = []
      const bufferViews: object[] = [], accessors: object[] = [], primitives: object[] = []
      const usedMats: number[] = []
      let offset = 0
      const addView = (data: ArrayBufferView, target: number): number => {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        const pad = align4(bytes.length) - bytes.length
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target })
        chunks.push(bytes); if (pad) chunks.push(new Uint8Array(pad))
        offset += bytes.length + pad
        return bufferViews.length - 1
      }
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      let tTris = 0
      for (const [mat, list] of [...byMat.entries()].sort((a, b) => a[0] - b[0])) {
        const nV = list.reduce((n, c) => n + c.verts, 0), nI = list.reduce((n, c) => n + c.tris * 3, 0)
        const P = new Float32Array(nV * 3), N = new Float32Array(nV * 3)
        // With colours baked the UVs have no further use (the lite tier has no textures), so they are not written.
        const withUv = list.every((c) => c.hasUv) && !opts.colors
        const T = withUv ? new Float32Array(nV * 2) : undefined
        const C = colorMode ? new Uint8Array(nV * 4) : undefined
        const I = new Uint32Array(nI)
        let vo = 0, io = 0
        for (const c of list) {
          const p = g.meshes![c.mesh]!.primitives[c.prim]!
          const pos = read(p.attributes["POSITION"]!) as Float32Array
          const nor = p.attributes["NORMAL"] !== undefined ? (read(p.attributes["NORMAL"]) as Float32Array) : undefined
          const uv = withUv ? (read(p.attributes["TEXCOORD_0"]!) as Float32Array) : undefined
          const idx = c.dec !== undefined ? decimated.get(c.dec)!.idx : p.indices !== undefined ? (read(p.indices) as Uint32Array) : undefined
          const m = c.matrix
          // Only the referenced vertices are emitted (first-use order, so output stays deterministic).
          const remap = new Int32Array(pos.length / 3).fill(-1)
          const srcOf: number[] = []
          let nUsed = 0
          const n3 = c.tris * 3
          for (let i = 0; i < n3; i++) {
            const v = idx ? idx[i]! : i
            let o = remap[v]!
            if (o < 0) {
              o = nUsed++; remap[v] = o; srcOf.push(v)
              const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!
              const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
              const d = vo + o
              P[d * 3] = wx; P[d * 3 + 1] = wy; P[d * 3 + 2] = wz
              if (wx < lo[0]!) lo[0] = wx
              if (wy < lo[1]!) lo[1] = wy
              if (wz < lo[2]!) lo[2] = wz
              if (wx > hi[0]!) hi[0] = wx
              if (wy > hi[1]!) hi[1] = wy
              if (wz > hi[2]!) hi[2] = wz
              if (nor) {
                const nx = nor[v * 3]!, ny = nor[v * 3 + 1]!, nz = nor[v * 3 + 2]!
                const ax = m[0]! * nx + m[4]! * ny + m[8]! * nz, ay = m[1]! * nx + m[5]! * ny + m[9]! * nz, az = m[2]! * nx + m[6]! * ny + m[10]! * nz
                const l = Math.hypot(ax, ay, az) || 1
                N[d * 3] = ax / l; N[d * 3 + 1] = ay / l; N[d * 3 + 2] = az / l
              } else { N[d * 3] = 0; N[d * 3 + 1] = 1; N[d * 3 + 2] = 0 }
              if (T && uv) { T[d * 2] = uv[v * 2]!; T[d * 2 + 1] = uv[v * 2 + 1]! }
            }
            I[io + i] = o + vo
          }
          if (C) paintVertices(c, p, srcOf, C, vo)
          vo += nUsed; io += n3
        }
        const attrs: Record<string, number> = {}
        accessors.push({ bufferView: addView(P, 34962), componentType: 5126, count: nV, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0] }) // exact min/max filled in below
        attrs["POSITION"] = accessors.length - 1
        accessors.push({ bufferView: addView(N, 34962), componentType: 5126, count: nV, type: "VEC3" }); attrs["NORMAL"] = accessors.length - 1
        if (T) { accessors.push({ bufferView: addView(T, 34962), componentType: 5126, count: nV, type: "VEC2" }); attrs["TEXCOORD_0"] = accessors.length - 1 }
        if (C) { accessors.push({ bufferView: addView(C, 34962), componentType: 5121, normalized: true, count: nV, type: "VEC4" }); attrs["COLOR_0"] = accessors.length - 1 }
        accessors.push({ bufferView: addView(I, 34963), componentType: 5125, count: nI, type: "SCALAR" })
        const prim: Record<string, unknown> = { attributes: attrs, indices: accessors.length - 1, mode: 4 }
        if (mat >= 0) { prim["material"] = usedMats.length; usedMats.push(mat) }
        primitives.push(prim)
        tTris += nI / 3
      }
      const json: Record<string, unknown> = {
        asset: { version: "2.0", generator: "dlq-extract lite" },
        scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: `tile_${id}` }], meshes: [{ name: `tile_${id}`, primitives }],
        buffers: [{ byteLength: offset }], bufferViews, accessors
      }
      // Carry over the used materials, remapping texture -> image ids; copy referenced image files.
      if (usedMats.length) {
        const texMap = new Map<number, number>(), imgMap = new Map<number, number>()
        const textures: object[] = [], images: object[] = []
        const remapTex = (ref: Record<string, any>) => {
          const t = g.textures?.[ref["index"]]
          if (!t || t.source === undefined) return false
          const img = g.images?.[t.source]
          if (!img?.uri || img.uri.startsWith("data:")) { warnings.push(`material texture ${t.source} is embedded or missing; dropped`); return false }
          if (!imgMap.has(t.source)) {
            imgMap.set(t.source, images.length); images.push({ uri: img.uri, ...(img.name ? { name: img.name } : {}) })
            if (!copiedImages.has(img.uri)) {
              copiedImages.add(img.uri)
              const from = join(srcDir, decodeURIComponent(img.uri)), to = join(outDir, decodeURIComponent(img.uri))
              if (existsSync(from)) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); textureBytes += statSync(to).size }
              else warnings.push(`texture file ${img.uri} not found`)
            }
          }
          if (!texMap.has(ref["index"])) { texMap.set(ref["index"], textures.length); textures.push({ source: imgMap.get(t.source) }) }
          ref["index"] = texMap.get(ref["index"])
          return true
        }
        json["materials"] = usedMats.map((i) => {
          const { extensions: _drop, ...m } = structuredClone(g.materials![i]!)
          const pbr = m["pbrMetallicRoughness"]
          for (const key of ["baseColorTexture", "metallicRoughnessTexture"]) if (pbr?.[key] && !remapTex(pbr[key])) delete pbr[key]
          for (const key of ["normalTexture", "occlusionTexture", "emissiveTexture"]) if (m[key] && !remapTex(m[key])) delete m[key]
          return m
        })
        if (textures.length) { json["textures"] = textures; json["images"] = images }
      }
      const file = `tiles/${id}.glb`
      const bin = new Uint8Array(offset)
      let at = 0
      for (const c of chunks) { bin.set(c, at); at += c.length }
      // exact min/max per POSITION accessor
      for (const a of accessors as Array<{ type: string; componentType: number; bufferView: number; count: number; min?: number[]; max?: number[] }>) {
        if (a.min === undefined) continue
        const bv = bufferViews[a.bufferView] as { byteOffset: number }
        const f = new Float32Array(bin.buffer, bin.byteOffset + bv.byteOffset, a.count * 3)
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
        for (let i = 0; i < a.count; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k]!, f[i * 3 + k]!); mx[k] = Math.max(mx[k]!, f[i * 3 + k]!) }
        a.min = mn; a.max = mx
      }
      writeGlb(join(outDir, file), json, bin)
      const bytes = readFileSync(join(outDir, file))
      tiles.push({
        id, file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), triangles: tTris,
        bounds: { min: lo as unknown as Aabb["min"], max: hi as unknown as Aabb["max"] },
        materials: [...new Set(usedMats.map(matName))].sort()
      })
      tileTris += tTris
    }
    return {
      tiles, keptTriangles: tileTris, totalTriangles: total, textureBytes, warnings, splitTriangles,
      ...(colorMode ? { colors: { ...colorStats, unpainted: [...unpainted].sort() } } : {})
    }
  } finally {
    reader.close()
  }
}
