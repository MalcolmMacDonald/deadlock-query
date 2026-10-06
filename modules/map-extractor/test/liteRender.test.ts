import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildLiteTiles, liteReady } from "../src/liteRender.ts"
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
  const r = buildLiteTiles(join(src, "n0.gltf"), out, { triBudget: 4, cell: 1e6, fullFraction: 1 }) // 2 quads
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
  const r = buildLiteTiles(join(src, "n0.gltf"), out, { triBudget: 100, cell: 1e6, tileBytes: 200, fullFraction: 1 })
  expect(r.tiles.length).toBe(3)
  expect(r.keptTriangles).toBe(6)
  expect(new Set(r.tiles.map((t) => t.file)).size).toBe(3)
})

test("emits only the vertices a primitive's indices reference, and bounds ignore the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-lite-"))
  // 8 vertices, but the single triangle only uses 0, 1, 2; vertices 3..7 sit far away and must not count.
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, ...[9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5, 9e5]])
  const idx = new Uint32Array([0, 1, 2])
  writeFileSync(join(dir, "n0.bin"), Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]))
  writeFileSync(join(dir, "n0.gltf"), JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ name: "m", primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [0, 0, 0], max: [9e5, 9e5, 9e5] }, { bufferView: 1, componentType: 5125, count: 3, type: "SCALAR" }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
    buffers: [{ uri: "n0.bin", byteLength: pos.byteLength + idx.byteLength }]
  }))
  const out = mkdtempSync(join(tmpdir(), "dlq-out-"))
  const r = buildLiteTiles(join(dir, "n0.gltf"), out, { cell: 1e6, fullFraction: 1 })
  expect(r.keptTriangles).toBe(1)
  expect(r.tiles[0]!.bounds).toEqual({ min: [0, 0, 0], max: [1, 0, 1] })
  const j = readGltfJson(join(out, r.tiles[0]!.file)) as any
  expect(j.accessors.find((a: any) => a.min).count).toBe(3)
})

/** An n x n grid of quads (2 n^2 triangles) spanning `size`, with a gentle bump so simplification has to keep some shape. */
const grid = (n: number, size: number) => {
  const pos = new Float32Array((n + 1) * (n + 1) * 3), idx = new Uint32Array(n * n * 6)
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const k = (j * (n + 1) + i) * 3
    pos[k] = (i / n) * size; pos[k + 1] = Math.sin((i / n) * 3) * size * 0.02; pos[k + 2] = (j / n) * size
  }
  let t = 0
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1
    idx.set([a, b, d, a, d, c], t); t += 6
  }
  return { pos, idx }
}

test("decimates the primitives that do not fit at full detail instead of dropping them", async () => {
  await liteReady
  const dir = mkdtempSync(join(tmpdir(), "dlq-lite-"))
  const big = grid(10, 1000), small = grid(20, 10) // 200 and 800 triangles; the big one is kept at full detail
  const chunks: Buffer[] = [], views: object[] = [], accessors: object[] = []
  let off = 0
  const add = (a: ArrayBufferView, type: string, componentType: number, count: number, extra: object = {}) => {
    const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength)
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length })
    accessors.push({ bufferView: views.length - 1, componentType, count, type, ...extra })
    chunks.push(b); off += b.length
    return accessors.length - 1
  }
  const meshes = [big, small].map((m, i) => {
    const n = m.pos.length / 3
    const max = [0, 1, 2].map((k) => Math.max(...Array.from({ length: n }, (_, v) => m.pos[v * 3 + k]!)))
    return { name: `m${i}`, primitives: [{ attributes: { POSITION: add(m.pos, "VEC3", 5126, n, { min: [0, -100, 0], max }) }, indices: add(m.idx, "SCALAR", 5125, m.idx.length) }] }
  })
  writeFileSync(join(dir, "n0.bin"), Buffer.concat(chunks))
  writeFileSync(join(dir, "n0.gltf"), JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, { mesh: 1, translation: [5000, 0, 0] }], meshes, accessors, bufferViews: views, buffers: [{ uri: "n0.bin", byteLength: off }]
  }))
  const out = mkdtempSync(join(tmpdir(), "dlq-out-"))
  // Budget 600, 40 % (240 triangles) for full detail: only the big grid fits; the 800-triangle one must be simplified into 400.
  const r = buildLiteTiles(join(dir, "n0.gltf"), out, { triBudget: 600, fullFraction: 0.4, cell: 1e6 })
  expect(r.totalTriangles).toBe(1000)
  expect(r.keptTriangles).toBeGreaterThan(200) // the small mesh is still there...
  expect(r.keptTriangles).toBeLessThan(600) // ...but simplified
  expect(r.tiles[0]!.bounds.max[0]).toBeGreaterThan(5000) // the translated small grid made it in
  // same input without decimation: the 800-triangle primitive does not fit and is dropped whole
  const dropped = buildLiteTiles(join(dir, "n0.gltf"), mkdtempSync(join(tmpdir(), "dlq-out-")), { triBudget: 600, fullFraction: 1, cell: 1e6 })
  expect(dropped.keptTriangles).toBe(200)
  // minTris is a per-primitive floor: asking for 700 keeps the 800-triangle grid at >= 700 (budget permitting) instead of the ratio's 400
  const floored = buildLiteTiles(join(dir, "n0.gltf"), mkdtempSync(join(tmpdir(), "dlq-out-")), { triBudget: 1000, fullFraction: 0.1, minTris: 700, decimateError: 1e-4, cell: 1e6 })
  expect(floored.keptTriangles).toBeGreaterThanOrEqual(700)
})
