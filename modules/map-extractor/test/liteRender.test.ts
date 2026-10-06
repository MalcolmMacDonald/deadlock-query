import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildLiteTiles } from "../src/liteRender.ts"
import { readGltfJson } from "../src/gltfInfo.ts"

/** A quad (2 tris) scaled `s`, as raw buffers: positions, normals, uvs, indices. */
const quad = (s: number) => ({
  pos: new Float32Array([0, 0, 0, s, 0, 0, s, 0, s, 0, 0, s]),
  nor: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  idx: new Uint16Array([0, 1, 2, 0, 2, 3])
})

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-lite-"))
  const sizes = [1, 10, 100] // diagonals grow; the budget keeps the biggest
  const chunks: Buffer[] = []
  const views: object[] = [], accessors: object[] = []
  let off = 0
  const add = (a: ArrayBufferView, type: string, componentType: number, count: number, extra: object = {}) => {
    const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength)
    const pad = (4 - (b.length % 4)) % 4
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length })
    accessors.push({ bufferView: views.length - 1, componentType, count, type, ...extra })
    chunks.push(b, Buffer.alloc(pad)); off += b.length + pad
    return accessors.length - 1
  }
  const meshes = sizes.map((s, i) => {
    const q = quad(s)
    return { name: `m${i}_mt_wall${i % 2}`, primitives: [{ attributes: { POSITION: add(q.pos, "VEC3", 5126, 4, { min: [0, 0, 0], max: [s, 0, s] }), NORMAL: add(q.nor, "VEC3", 5126, 4), TEXCOORD_0: add(q.uv, "VEC2", 5126, 4) }, indices: add(q.idx, "SCALAR", 5123, 6), material: i % 2 }] }
  })
  writeFileSync(join(dir, "n0.bin"), Buffer.concat(chunks))
  mkdirSync(join(dir, "textures"))
  writeFileSync(join(dir, "textures", "wall0.png"), "png0")
  // node i translated by +1000*i in X, so baking is observable
  const nodes = sizes.map((_, i) => ({ mesh: i, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000 * i, 0, 0, 1] }))
  writeFileSync(join(dir, "n0.gltf"), JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews: views,
    buffers: [{ uri: "n0.bin", byteLength: off }],
    materials: [{ name: "wall0", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { name: "wall1", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    textures: [{ source: 0 }], images: [{ uri: "textures/wall0.png" }]
  }))
  return dir
}

test("keeps the largest primitives within the triangle budget, bakes matrices, carries materials", () => {
  const src = fixture(), out = mkdtempSync(join(tmpdir(), "dlq-out-"))
  const r = buildLiteTiles(join(src, "n0.gltf"), out, { triBudget: 4, cell: 1e6 }) // 2 quads
  expect(r.totalTriangles).toBe(6)
  expect(r.keptTriangles).toBe(4)
  expect(r.tiles.length).toBe(1)
  const t = r.tiles[0]!
  // kept: sizes 100 (node 2, x+2000) and 10 (node 1, x+1000); the size-1 quad is dropped
  expect(t.bounds.min[0]).toBe(1000)
  expect(t.bounds.max[0]).toBe(2100)
  expect(t.materials).toEqual(["wall0", "wall1"].filter((m) => t.materials.includes(m)))
  const j = readGltfJson(join(out, t.file)) as any
  expect(j.materials.length).toBe(2)
  expect(j.images[0].uri).toBe("textures/wall0.png")
  expect(readFileSync(join(out, "textures/wall0.png"), "utf8")).toBe("png0")
  const pos = j.accessors.filter((a: any) => a.min)
  expect(Math.min(...pos.map((a: any) => a.min[0]))).toBe(1000)
  expect(Math.max(...pos.map((a: any) => a.max[0]))).toBe(2100)
  expect(t.bytes).toBe(readFileSync(join(out, t.file)).length)
})

test("splits a cell into several tiles when the byte budget is small", () => {
  const src = fixture(), out = mkdtempSync(join(tmpdir(), "dlq-out-"))
  const r = buildLiteTiles(join(src, "n0.gltf"), out, { triBudget: 100, cell: 1e6, tileBytes: 200 })
  expect(r.tiles.length).toBe(3)
  expect(r.keptTriangles).toBe(6)
  expect(new Set(r.tiles.map((t) => t.file)).size).toBe(3)
})
