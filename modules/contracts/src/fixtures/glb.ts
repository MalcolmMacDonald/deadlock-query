import { DEFAULT_GLB_TO_WORLD, type Vec3 } from "../Space.ts"

export interface BoxSpec {
  readonly name: string
  readonly min: Vec3
  readonly max: Vec3
  readonly extras?: Record<string, unknown>
}

/** Convert world (Z-up) to glTF (Y-up): inverse of DEFAULT_GLB_TO_WORLD, (x,y,z) -> (x,z,-y). */
const toGlb = (p: Vec3): Vec3 => [p[0], p[2], -p[1]]

const boxMesh = (b: BoxSpec) => {
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max
  const corners: Vec3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
  ]
  const idx = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
  ]
  return { positions: corners.flatMap((c) => toGlb(c)), indices: idx }
}

/** Minimal deterministic GLB writer: one mesh+node per box, `extras` on nodes. */
export const writeBoxGlb = (boxes: ReadonlyArray<BoxSpec>): Uint8Array => {
  const bufferViews: unknown[] = []
  const accessors: unknown[] = []
  const meshes: unknown[] = []
  const nodes: unknown[] = []
  const chunks: Uint8Array[] = []
  let offset = 0
  const push = (data: ArrayBuffer, target: number): number => {
    chunks.push(new Uint8Array(data))
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target })
    offset += data.byteLength
    return bufferViews.length - 1
  }
  boxes.forEach((b, i) => {
    const m = boxMesh(b)
    const pos = new Float32Array(m.positions)
    const idx = new Uint16Array(m.indices)
    const posView = push(pos.buffer, 34962)
    const mins = [0, 1, 2].map((a) => Math.min(...m.positions.filter((_, k) => k % 3 === a)))
    const maxs = [0, 1, 2].map((a) => Math.max(...m.positions.filter((_, k) => k % 3 === a)))
    accessors.push({ bufferView: posView, componentType: 5126, count: 8, type: "VEC3", min: mins, max: maxs })
    // Uint16 length 72 bytes: already 4-byte aligned
    const idxView = push(idx.buffer, 34963)
    accessors.push({ bufferView: idxView, componentType: 5123, count: idx.length, type: "SCALAR" })
    meshes.push({ name: b.name, primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1 }] })
    nodes.push({ name: b.name, mesh: i, ...(b.extras ? { extras: b.extras } : {}) })
  })
  const json = {
    asset: { version: "2.0", generator: "deadlock-query/contracts fixtures" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes, accessors, bufferViews,
    buffers: [{ byteLength: offset }]
  }
  const pad = (u: Uint8Array, byte: number): Uint8Array => {
    const n = (4 - (u.length % 4)) % 4
    const out = new Uint8Array(u.length + n).fill(byte)
    out.set(u)
    return out
  }
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const bin = new Uint8Array(offset)
  let o = 0
  for (const c of chunks) { bin.set(c, o); o += c.length }
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

export { DEFAULT_GLB_TO_WORLD }
