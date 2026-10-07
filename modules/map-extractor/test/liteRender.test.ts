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

/** One glTF with the given primitives (positions, optional uvs, indices, material index), each in its own mesh named `<name>_mt_<material>`. */
const gltfOf = (prims: Array<{ name: string; pos: Float32Array; idx: Uint32Array; uv?: Float32Array; material?: number }>, materials: object[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-lite-"))
  const chunks: Buffer[] = [], views: object[] = [], accessors: object[] = []
  let off = 0
  const add = (a: ArrayBufferView, type: string, componentType: number, count: number, extra: object = {}) => {
    const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength)
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length })
    accessors.push({ bufferView: views.length - 1, componentType, count, type, ...extra })
    chunks.push(b); off += b.length
    return accessors.length - 1
  }
  const meshes = prims.map((m) => {
    const n = m.pos.length / 3
    const mn = [0, 1, 2].map((k) => Math.min(...Array.from({ length: n }, (_, v) => m.pos[v * 3 + k]!)))
    const mx = [0, 1, 2].map((k) => Math.max(...Array.from({ length: n }, (_, v) => m.pos[v * 3 + k]!)))
    const attributes: Record<string, number> = { POSITION: add(m.pos, "VEC3", 5126, n, { min: mn, max: mx }) }
    if (m.uv) attributes["TEXCOORD_0"] = add(m.uv, "VEC2", 5126, n)
    return { name: m.name, primitives: [{ attributes, indices: add(m.idx, "SCALAR", 5125, m.idx.length), ...(m.material !== undefined ? { material: m.material } : {}) }] }
  })
  writeFileSync(join(dir, "n0.bin"), Buffer.concat(chunks))
  writeFileSync(join(dir, "n0.gltf"), JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: prims.map((_, i) => i) }], nodes: prims.map((_, i) => ({ mesh: i })), meshes, accessors, bufferViews: views,
    buffers: [{ uri: "n0.bin", byteLength: off }], ...(materials.length ? { materials } : {})
  }))
  return join(dir, "n0.gltf")
}

test("a primitive too big for one tile is split into tile-sized parts instead of being dropped", () => {
  const g = grid(40, 4000) // 3,200 triangles
  const src = gltfOf([{ name: "terrain", pos: g.pos, idx: g.idx }])
  const out = mkdtempSync(join(tmpdir(), "dlq-out-"))
  const r = buildLiteTiles(src, out, { cell: 1e6, tileBytes: 30_000 })
  expect(r.totalTriangles).toBe(3200)
  expect(r.keptTriangles).toBe(3200)
  expect(r.splitTriangles).toBe(3200)
  expect(r.warnings).toEqual([])
  expect(r.tiles.length).toBeGreaterThan(3)
  for (const t of r.tiles) expect(t.bytes).toBeLessThan(30_000 * 1.5)
  // the parts cover the whole surface
  expect(Math.min(...r.tiles.map((t) => t.bounds.min[0]))).toBeCloseTo(0, 3)
  expect(Math.max(...r.tiles.map((t) => t.bounds.max[0]))).toBeCloseTo(4000, 3)
  expect(Math.max(...r.tiles.map((t) => t.bounds.max[2]))).toBeCloseTo(4000, 3)
})

/** The tile's COLOR_0 bytes (RGBA8) in file order, read from the GLB's binary chunk. */
const colorsOf = (path: string): Uint8Array[] => {
  const buf = readFileSync(path)
  const jl = buf.readUInt32LE(12), j = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8"))
  const bin = buf.subarray(20 + jl + 8)
  return j.meshes.flatMap((m: any) => m.primitives).map((p: any) => {
    const a = j.accessors[p.attributes.COLOR_0], bv = j.bufferViews[a.bufferView]
    expect(a.componentType).toBe(5121); expect(a.normalized).toBe(true); expect(a.type).toBe("VEC4")
    return new Uint8Array(bin.subarray(bv.byteOffset, bv.byteOffset + a.count * 4))
  })
}

test("bakes a COLOR_0 per vertex from the material paint: tint, texture sampled at the vertex UV, fallback when unresolved", async () => {
  await liteReady
  const { mapProvider, buildMips, solidMips } = await import("../src/colors.ts")
  // a 2 x 2 texture: left column red, right column blue (sRGB bytes), sampled by a dense quad (4 vertices over the whole texture)
  const px = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255])
  const mips = buildMips(px, 2, 2)
  const q = quad(100)
  const src = gltfOf([
    { name: "a_mt_painted", pos: q.pos, idx: new Uint32Array(q.idx), uv: new Float32Array([0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75]) }, // texel centres
    { name: "b_mt_unknown", pos: q.pos.map((v, i) => (i % 3 === 0 ? v + 500 : v)), idx: new Uint32Array(q.idx) },
    { name: "c_mt_tinted", pos: q.pos.map((v, i) => (i % 3 === 0 ? v + 1000 : v)), idx: new Uint32Array(q.idx), uv: q.uv }
  ])
  const provider = mapProvider(new Map([
    ["painted", { tint: [1, 1, 1] as const, texture: mips }],
    ["tinted", { tint: [0.5, 0.25, 1] as const, texture: solidMips([1, 1, 1]) }]
  ]), [0.2, 0.2, 0.2])
  const out = mkdtempSync(join(tmpdir(), "dlq-out-"))
  const r = buildLiteTiles(src, out, { cell: 1e6, colors: provider })
  expect(r.colors).toEqual({ primitives: 3, painted: 2, textured: 2, unpainted: ["b_mt_unknown"] })
  expect(r.tiles).toHaveLength(1)
  const [C] = colorsOf(join(out, r.tiles[0]!.file))
  const rgba = (i: number) => [...C!.subarray(i * 4, i * 4 + 4)]
  // vertex order per primitive is first-use: quad corners with u = 0.25, 0.75, 0.75, 0.25 (the centres of the red and blue columns)
  const painted = [0, 1, 2, 3].map(rgba)
  expect(painted[0]![0]).toBeGreaterThan(painted[0]![2]!) // red column
  expect(painted[1]![2]).toBeGreaterThan(painted[1]![0]!) // blue column
  for (const p of painted) expect(p[3]).toBe(255)
  // unresolved: the fallback 0.2 linear = 51
  expect([4, 5, 6, 7].map(rgba)).toEqual(Array(4).fill([51, 51, 51, 255]))
  // tinted: 0.5, 0.25, 1 linear -> 128, 64, 255 (white texture)
  expect([8, 9, 10, 11].map(rgba)).toEqual(Array(4).fill([128, 64, 255, 255]))
  // UVs are not written once colours are baked
  const j = readGltfJson(join(out, r.tiles[0]!.file)) as any
  expect(j.meshes[0].primitives.every((p: any) => p.attributes.TEXCOORD_0 === undefined && p.attributes.COLOR_0 !== undefined)).toBe(true)
})

test("without a colour provider the tiles carry no COLOR_0, and the default budget keeps every triangle", () => {
  const g = grid(10, 100)
  const src = gltfOf([{ name: "m", pos: g.pos, idx: g.idx }])
  const out = mkdtempSync(join(tmpdir(), "dlq-out-"))
  const r = buildLiteTiles(src, out, { cell: 1e6 })
  expect(r.keptTriangles).toBe(r.totalTriangles)
  expect(r.colors).toBeUndefined()
  const j = readGltfJson(join(out, r.tiles[0]!.file)) as any
  expect(j.meshes[0].primitives[0].attributes.COLOR_0).toBeUndefined()
})
