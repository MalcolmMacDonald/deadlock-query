import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { transformPoint, type Aabb, type Mat4 } from "@deadlock-query/contracts"
import { readGltfJson } from "./gltfInfo.ts"

/**
 * Derives the `lite` render tier from a full glTF export (which has ~29 M triangles): keeps the largest primitives
 * (by bounding-box diagonal) up to a triangle budget, bakes node matrices into the vertices, groups them into
 * horizontal grid tiles split to stay under a byte budget, and writes one `.glb` per tile. Materials (and the
 * image files they reference) are carried over; textures are copied unmodified.
 */

export interface LiteOptions {
  /** Total triangles to keep (default 5 M, roughly 150 MB of tiles). */
  readonly triBudget?: number
  /** Max bytes of one tile .glb (default 18 MB, under the 20 MB site tile budget). */
  readonly tileBytes?: number
  /** Grid cell edge in loaded-frame units (metres; default 128). */
  readonly cell?: number
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

export interface LiteResult { readonly tiles: LiteTile[]; readonly keptTriangles: number; readonly totalTriangles: number; readonly textureBytes: number; readonly warnings: string[] }

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

interface Cand { node: number; prim: number; mesh: number; matrix: Mat4; tris: number; /** vertices actually referenced by the indices */ verts: number; diag: number; centre: [number, number, number]; material: number; hasUv: boolean }

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
  const triBudget = opts.triBudget ?? 5_000_000
  const tileBytes = opts.tileBytes ?? 18 * 1024 * 1024
  const cell = opts.cell ?? 128
  const warnings: string[] = []
  const g = readGltfJson(gltfPath) as unknown as G
  const srcDir = dirname(gltfPath)
  const reader = new BufferReader(g, srcDir)
  try {
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
        const pos = readAccessor(g, reader, p.attributes["POSITION"]).data as Float32Array
        const nv = pos.length / 3
        const idx = p.indices !== undefined ? (readAccessor(g, reader, p.indices).data as Uint32Array) : undefined
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
          node, prim, mesh, matrix, tris, verts: info.verts, material: p.material ?? -1, hasUv: p.attributes["TEXCOORD_0"] !== undefined,
          diag: Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!),
          centre: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]
        })
      })
    }
    // Largest first, deterministic on ties.
    cands.sort((a, b) => b.diag - a.diag || a.node - b.node || a.prim - b.prim)
    const kept: Cand[] = []
    let keptTris = 0
    for (const c of cands) {
      if (keptTris + c.tris > triBudget) continue
      kept.push(c); keptTris += c.tris
    }
    opts.log?.(`lite render: keeping ${kept.length}/${cands.length} primitives, ${keptTris}/${total} triangles`)

    // Group by grid cell (loaded X/Z), then fill tiles up to the byte budget.
    const cells = new Map<string, Cand[]>()
    for (const c of kept) {
      const key = `${Math.floor(c.centre[0] / cell)}_${Math.floor(c.centre[2] / cell)}`
      ;(cells.get(key) ?? cells.set(key, []).get(key)!).push(c)
    }
    const estimate = (c: Cand) => c.verts * (12 + 12 + 8) + c.tris * 3 * 4
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

    if (oversized.length) warnings.push(`${oversized.length} primitives exceed the ${(tileBytes / 1048576).toFixed(0)} MB tile budget (largest ${(Math.max(...oversized.map(estimate)) / 1048576).toFixed(1)} MB, ${oversized.reduce((n, c) => n + c.tris, 0)} triangles); dropped`)

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
        const withUv = list.every((c) => c.hasUv)
        const T = withUv ? new Float32Array(nV * 2) : undefined
        const I = new Uint32Array(nI)
        let vo = 0, io = 0
        for (const c of list) {
          const p = g.meshes![c.mesh]!.primitives[c.prim]!
          const pos = readAccessor(g, reader, p.attributes["POSITION"]!).data as Float32Array
          const nor = p.attributes["NORMAL"] !== undefined ? (readAccessor(g, reader, p.attributes["NORMAL"]).data as Float32Array) : undefined
          const uv = withUv ? (readAccessor(g, reader, p.attributes["TEXCOORD_0"]!).data as Float32Array) : undefined
          const idx = p.indices !== undefined ? (readAccessor(g, reader, p.indices).data as Uint32Array) : undefined
          const m = c.matrix
          // Only the referenced vertices are emitted (first-use order, so output stays deterministic).
          const remap = new Int32Array(pos.length / 3).fill(-1)
          let nUsed = 0
          const n3 = c.tris * 3
          for (let i = 0; i < n3; i++) {
            const v = idx ? idx[i]! : i
            let o = remap[v]!
            if (o < 0) {
              o = nUsed++; remap[v] = o
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
          vo += nUsed; io += n3
        }
        const attrs: Record<string, number> = {}
        accessors.push({ bufferView: addView(P, 34962), componentType: 5126, count: nV, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0] }) // exact min/max filled in below
        attrs["POSITION"] = accessors.length - 1
        accessors.push({ bufferView: addView(N, 34962), componentType: 5126, count: nV, type: "VEC3" }); attrs["NORMAL"] = accessors.length - 1
        if (T) { accessors.push({ bufferView: addView(T, 34962), componentType: 5126, count: nV, type: "VEC2" }); attrs["TEXCOORD_0"] = accessors.length - 1 }
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
    return { tiles, keptTriangles: tileTris, totalTriangles: total, textureBytes, warnings }
  } finally {
    reader.close()
  }
}
