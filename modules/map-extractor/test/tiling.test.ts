import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { Document, Format, NodeIO } from "@gltf-transform/core"
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { isLodTile, tileBundle } from "../src/tiling.ts"

/** A `n x n` quad grid with a gentle bump, as one tile .glb with a textured material. */
const writeTile = async (path: string, n: number, texture?: string, colors = false) => {
  const doc = new Document()
  const buf = doc.createBuffer()
  const pos = new Float32Array((n + 1) * (n + 1) * 3), nor = new Float32Array((n + 1) * (n + 1) * 3), uv = new Float32Array((n + 1) * (n + 1) * 2)
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const k = j * (n + 1) + i
    pos.set([i * 2, Math.sin(i / 7) * Math.cos(j / 9) * 3, j * 2], k * 3); nor.set([0, 1, 0], k * 3); uv.set([i / n, j / n], k * 2)
  }
  const idx = new Uint32Array(n * n * 6)
  for (let j = 0, o = 0; j < n; j++) for (let i = 0; i < n; i++, o += 6) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1
    idx.set([a, c, b, b, c, d], o)
  }
  const mat = doc.createMaterial("wall")
  if (texture) mat.setBaseColorTexture(doc.createTexture("t").setImage(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])).setMimeType("image/png").setURI(texture))
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(pos).setBuffer(buf))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(nor).setBuffer(buf))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(uv).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(idx).setBuffer(buf))
  if (colors) {
    // a red-to-blue ramp along X, RGBA8 normalised
    const col = new Uint8Array((n + 1) * (n + 1) * 4)
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) col.set([Math.round(255 * (1 - i / n)), 0, Math.round(255 * (i / n)), 255], (j * (n + 1) + i) * 4)
    prim.setAttribute("COLOR_0", doc.createAccessor().setType("VEC4").setArray(col).setNormalized(true).setBuffer(buf))
  }
  const mesh = doc.createMesh("m").addPrimitive(prim)
  doc.createScene().addChild(doc.createNode("n").setMesh(mesh))
  if (!texture) return void (await new NodeIO().write(path, doc))
  // Like liteRender's tiles: a GLB whose image stays an external file.
  const { json, resources } = await new NodeIO().writeJSON(doc, { format: Format.GLTF })
  const binName = json.buffers![0]!.uri!
  const bin = Buffer.from(resources[binName]!)
  delete json.buffers![0]!.uri
  const pad = (b: Buffer, c: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, c)])
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20), b = pad(bin, 0)
  const head = Buffer.alloc(12 + 8), mid = Buffer.alloc(8)
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8)
  head.writeUInt32LE(j.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
  mid.writeUInt32LE(b.length, 0); mid.writeUInt32LE(0x004e4942, 4)
  writeFileSync(path, Buffer.concat([head, j, mid, b]))
  writeFileSync(join(dirname(path), texture), "png")
}

const bundle = async (n = 60, colors = false) => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-tile-"))
  mkdirSync(join(dir, "render/tiles"), { recursive: true })
  const file = "render/tiles/0_0.glb"
  await writeTile(join(dir, file), n, colors ? undefined : "tex.png", colors)
  const raw = readFileSync(join(dir, file))
  const bounds = { min: [0, -3, 0] as const, max: [n * 2, 3, n * 2] as const }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: "1.0.0", gameBuildId: "1", mapName: "m", tier: "lite",
    coordinateSystem: { up: "Z", unit: "source", glbToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    bounds, tiles: [{ id: "0_0", bounds, file, bytes: raw.length, sha256: "x", materials: ["wall"] }],
    entitiesFile: "entities.json", provenance: { extractorVersion: "0.4.0", s2vVersion: "20.0" }
  }))
  return { dir, file, rawBytes: raw.length, n }
}

const decode = async (path: string) => {
  await MeshoptDecoder.ready
  return new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ "meshopt.decoder": MeshoptDecoder }).read(path)
}
const tris = (d: Document) => d.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((k, p) => k + p.getIndices()!.getCount() / 3, 0)

test("writes a compressed LOD0 and a simplified LOD1 per tile and updates the manifest", async () => {
  const { dir, file, rawBytes, n } = await bundle()
  const r = await tileBundle(dir, { lods: 2, lodRatio: 0.25 })
  expect(r.errors).toEqual([])
  expect(r.ok).toBe(true)
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  expect(m.tiles.map((t: any) => t.id)).toEqual(["0_0", "0_0#lod1"])
  expect(m.tiles.map((t: any) => isLodTile(t.id))).toEqual([false, true])
  expect(m.tiles[1].file).toBe("render/tiles/0_0.lod1.glb")
  expect(m.tiles[1].bounds).toEqual(m.tiles[0].bounds)
  for (const t of m.tiles) {
    const bytes = readFileSync(join(dir, t.file))
    expect(t.bytes).toBe(bytes.length)
    expect(t.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(t.bytes).toBeLessThan(rawBytes)
  }
  const lod0 = await decode(join(dir, file)), lod1 = await decode(join(dir, "render/tiles/0_0.lod1.glb"))
  expect(lod0.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain("EXT_meshopt_compression")
  expect(tris(lod0)).toBe(n * n * 2)
  expect(tris(lod1)).toBeLessThan(tris(lod0) * 0.5)
  expect(tris(lod1)).toBeGreaterThan(0)
  expect(r.largestTileBytes).toBeLessThanOrEqual(20 * 1024 * 1024)
})

test("positions survive quantisation within a small tolerance", async () => {
  const { dir, file, n } = await bundle(30)
  await tileBundle(dir, { lods: 1 })
  const doc = await decode(join(dir, file))
  const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
  const node = doc.getRoot().listNodes()[0]!
  const p = prim.getAttribute("POSITION")!
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  const v = [0, 0, 0]
  const s = node.getScale(), t = node.getTranslation()
  for (let i = 0; i < p.getCount(); i++) {
    p.getElement(i, v)
    for (let k = 0; k < 3; k++) { const w = v[k]! * s[k]! + t[k]!; lo[k] = Math.min(lo[k]!, w); hi[k] = Math.max(hi[k]!, w) }
  }
  expect(hi[0]! - lo[0]!).toBeCloseTo(n * 2, 1)
  expect(hi[2]! - lo[2]!).toBeCloseTo(n * 2, 1)
})

test("strips textures and deletes their files by default, keeps them with keepTextures", async () => {
  const a = await bundle(10)
  const ra = await tileBundle(a.dir, { lods: 1 })
  expect(ra.removedTextureBytes).toBe(3)
  expect(existsSync(join(a.dir, "render/tiles/tex.png"))).toBe(false)
  expect((await decode(join(a.dir, a.file))).getRoot().listTextures().length).toBe(0)
  const b = await bundle(10)
  await tileBundle(b.dir, { lods: 1, keepTextures: true })
  expect((await decode(join(b.dir, b.file))).getRoot().listTextures().length).toBe(1)
})

test("reports tiles over the byte budget", async () => {
  const { dir } = await bundle(60)
  const r = await tileBundle(dir, { lods: 1, maxTileBytes: 100 })
  expect(r.ok).toBe(false)
  expect(r.errors[0]).toContain("over the")
})

test("rejects full-tier, missing and already tiled bundles", async () => {
  const empty = mkdtempSync(join(tmpdir(), "dlq-tile-"))
  expect((await tileBundle(empty)).errors[0]).toContain("manifest.json not found")
  const { dir } = await bundle(10)
  await tileBundle(dir, { lods: 2 })
  expect((await tileBundle(dir)).errors[0]).toContain("already tiled")
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, tier: "full", tiles: [] }))
  expect((await tileBundle(dir)).errors[0]).toContain('expected tier "lite"')
})

test("running tile again after an extract rewrote the manifest (tiles already compressed) gives the same result", async () => {
  const { dir } = await bundle()
  const before = readFileSync(join(dir, "manifest.json"), "utf8") // what a cached `extract` writes: untiled entries
  const first = await tileBundle(dir, { lods: 2 })
  expect(first.errors).toEqual([])
  const tiled = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  writeFileSync(join(dir, "manifest.json"), before)
  const second = await tileBundle(dir, { lods: 2 })
  expect(second.errors).toEqual([])
  const again = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  expect(again.tiles.map((t: { id: string }) => t.id)).toEqual(tiled.tiles.map((t: { id: string }) => t.id))
  for (const t of again.tiles) expect(createHash("sha256").update(readFileSync(join(dir, t.file))).digest("hex")).toBe(t.sha256)
  expect(tris(await decode(join(dir, "render/tiles/0_0.glb")))).toBe(60 * 60 * 2) // LOD0 keeps every triangle through the second pass
  expect(tris(await decode(join(dir, "render/tiles/0_0.lod1.glb")))).toBeLessThan(tris(await decode(join(dir, "render/tiles/0_0.glb"))))
})

test("keeps COLOR_0 through compression and every LOD, makes 3 LODs by default and tags LOD tiles with lod / lodOf", async () => {
  const { dir } = await bundle(60, true)
  const r = await tileBundle(dir)
  expect(r.errors).toEqual([])
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  expect(m.tiles.map((t: any) => t.id)).toEqual(["0_0", "0_0#lod1", "0_0#lod2"])
  expect(m.tiles.map((t: any) => t.lod)).toEqual([undefined, 1, 2])
  expect(m.tiles.map((t: any) => t.lodOf)).toEqual([undefined, "0_0", "0_0"])
  const counts: number[] = []
  for (const t of m.tiles) {
    const d = await decode(join(dir, t.file))
    const prim = d.getRoot().listMeshes()[0]!.listPrimitives()[0]!
    const c = prim.getAttribute("COLOR_0")!
    expect(c).toBeTruthy()
    expect(c.getNormalized()).toBe(true)
    // the ramp survives: the vertex with the smallest x is red, the largest blue
    const pos = prim.getAttribute("POSITION")!
    let lo = 0, hi = 0
    for (let i = 0; i < pos.getCount(); i++) { if (pos.getScalar(i) < pos.getScalar(lo)) lo = i; if (pos.getScalar(i) > pos.getScalar(hi)) hi = i }
    expect(c.getElement(lo, [0, 0, 0, 0])[0]).toBeGreaterThan(0.9)
    expect(c.getElement(hi, [0, 0, 0, 0])[2]).toBeGreaterThan(0.9)
    counts.push(tris(d))
  }
  expect(counts[1]!).toBeLessThan(counts[0]! * 0.5)
  expect(counts[2]!).toBeLessThan(counts[1]!)
})
