import { DEFAULT_GLB_TO_WORLD, SCHEMA_VERSION, type Manifest } from "@deadlock-query/contracts"

/**
 * Synthetic large map for the streaming acceptance test (contains no Valve data): a `cols` x `rows` grid of square
 * tiles, each with a finest LOD and coarser ones, every LOD a real heightfield GLB of a known size. Defaults add up to
 * ~620 MB of tile files (14 x 14 cells of 2.4 + 0.6 + 0.15 MB), over the 500 MB the milestone asks for.
 */
export interface SyntheticOptions {
  readonly cols?: number
  readonly rows?: number
  /** Edge length of a cell in world units. */
  readonly cell?: number
  /** Heightfield grid size (vertices per edge) for LOD0, LOD1, ...; each LOD roughly quarters the bytes. */
  readonly grids?: ReadonlyArray<number>
  /** Give every tile a `COLOR_0` (RGBA8) so the coloured material path is exercised (default false). */
  readonly colored?: boolean
}

export const DEFAULT_SYNTHETIC: Required<SyntheticOptions> = { cols: 14, rows: 14, cell: 1000, grids: [260, 130, 65], colored: false }

const height = (x: number, y: number) => 60 * Math.sin(x / 700) * Math.cos(y / 900) + 25 * Math.sin((x + y) / 230)

const pad4 = (u: Uint8Array, byte: number): Uint8Array => {
  const n = (4 - (u.length % 4)) % 4
  const out = new Uint8Array(u.length + n).fill(byte)
  out.set(u)
  return out
}

/** A `n` x `n` vertex heightfield over [x0, x0 + size] x [y0, y0 + size] (world), as a GLB in glTF space (Y up). */
export const heightfieldGlb = (x0: number, y0: number, size: number, n: number, colored = false): Uint8Array => {
  const pos = new Float32Array(n * n * 3)
  let mnY = Infinity, mxY = -Infinity
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i / (n - 1)) * size, y = y0 + (j / (n - 1)) * size, z = height(x, y)
      const o = (j * n + i) * 3
      pos[o] = x; pos[o + 1] = z; pos[o + 2] = -y // world (x, y, z) -> glTF (x, z, -y)
      mnY = Math.min(mnY, z); mxY = Math.max(mxY, z)
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6)
  let k = 0
  for (let j = 0; j + 1 < n; j++) for (let i = 0; i + 1 < n; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d
  }
  // Optional COLOR_0 (RGBA8 normalised): red where the ground is high, blue where it is low, green across x.
  const col = colored ? new Uint8Array(n * n * 4) : undefined
  if (col) for (let v = 0; v < n * n; v++) {
    const t = (pos[v * 3 + 1]! - mnY) / Math.max(1e-6, mxY - mnY)
    col.set([Math.round(255 * t), Math.round(255 * ((v % n) / (n - 1))), Math.round(255 * (1 - t)), 255], v * 4)
  }
  const json = {
    asset: { version: "2.0", generator: "deadlock-query/map-viewer synthetic" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(col ? { COLOR_0: 2 } : {}) }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n * n, type: "VEC3", min: [x0, mnY, -(y0 + size)], max: [x0 + size, mxY, -y0] },
      { bufferView: 1, componentType: 5125, count: idx.length, type: "SCALAR" },
      ...(col ? [{ bufferView: 2, componentType: 5121, normalized: true, count: n * n, type: "VEC4" }] : [])
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
      ...(col ? [{ buffer: 0, byteOffset: pos.byteLength + idx.byteLength, byteLength: col.byteLength, target: 34962 }] : [])
    ],
    buffers: [{ byteLength: pos.byteLength + idx.byteLength + (col?.byteLength ?? 0) }]
  }
  const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const bin = new Uint8Array(pos.byteLength + idx.byteLength + (col?.byteLength ?? 0))
  bin.set(new Uint8Array(pos.buffer), 0)
  bin.set(new Uint8Array(idx.buffer), pos.byteLength)
  if (col) bin.set(col, pos.byteLength + idx.byteLength)
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  const p = 20 + jsonBytes.length
  dv.setUint32(p, bin.length, true); dv.setUint32(p + 4, 0x004e4942, true)
  out.set(bin, p + 8)
  return out
}

/** File size of a LOD's GLB (identical for every cell: only the heights differ). */
export const glbBytesForGrid = (n: number): number => heightfieldGlb(0, 0, 1, n).byteLength

export interface SyntheticMap {
  readonly manifest: Manifest
  /** GLB for a tile id of this map (generated on demand). */
  readonly glb: (tileId: string) => Uint8Array
  readonly totalTileBytes: number
}

export const syntheticMap = (opts: SyntheticOptions = {}): SyntheticMap => {
  const o = { ...DEFAULT_SYNTHETIC, ...opts }
  const bytes = o.grids.map((n) => heightfieldGlb(0, 0, 1, n, o.colored).byteLength)
  const tiles: Manifest["tiles"][number][] = []
  const spec = new Map<string, { x0: number; y0: number; n: number }>()
  const x0 = -(o.cols * o.cell) / 2, y0 = -(o.rows * o.cell) / 2
  for (let i = 0; i < o.cols; i++) for (let j = 0; j < o.rows; j++) {
    const cx = x0 + i * o.cell, cy = y0 + j * o.cell
    o.grids.forEach((n, lod) => {
      const id = lod === 0 ? `c${i}_${j}` : `c${i}_${j}#lod${lod}`
      spec.set(id, { x0: cx, y0: cy, n })
      tiles.push({
        id, file: `tiles/${id.replace("#", ".")}.glb`, bytes: bytes[lod]!, sha256: "",
        bounds: { min: [cx, cy, -100], max: [cx + o.cell, cy + o.cell, 100] }
      })
    })
  }
  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION, gameBuildId: "synthetic", mapName: "synthetic_500mb", tier: "lite",
    coordinateSystem: { up: "Z", unit: "source", glbToWorld: DEFAULT_GLB_TO_WORLD },
    bounds: { min: [x0, y0, -100], max: [x0 + o.cols * o.cell, y0 + o.rows * o.cell, 100] },
    tiles, entitiesFile: "entities.json",
    provenance: { extractorVersion: "synthetic", s2vVersion: "none", synthetic: true }
  }
  return {
    manifest,
    glb: (id) => {
      const s = spec.get(id)
      if (!s) throw new Error(`unknown tile ${id}`)
      return heightfieldGlb(s.x0, s.y0, o.cell, s.n, o.colored)
    },
    totalTileBytes: tiles.reduce((n, t) => n + t.bytes, 0)
  }
}
