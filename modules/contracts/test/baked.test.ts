import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  Baked, EntityKind, Manifest, buildMiniMap, checkFiles, checkTiles, decodeVersioned, sha256Hex,
  tileBaseId, tileLod, tilesAtLod, type Manifest as ManifestT
} from "../src/index.ts"

/** Shape of `manifest.baked` as written by map-extractor on the real dl_midtown bundle (bake + navmesh stages). */
const realBaked = () => ({
  bakeVersion: "1.0.0",
  semanticsVersion: "abc123",
  placeholder: true,
  inputKey: "k1",
  bvh: { file: "baked/collision.bvh", bytes: 100, sha256: "a", triangles: 12, vertices: 24, excludedLayers: ["sky"], skippedNodes: 1 },
  sampleGrid: {
    file: "baked/sample-grid.bin", bytes: 200, sha256: "b", cellSize: 64, nx: 333, ny: 385, origin: [-100, -200] as [number, number],
    channels: ["floorHeight", "interior", "wallDistance"],
    params: { eyeHeight: 64, targetHeight: 32, maxRange: 5000, wallMinSlope: 60, interiorCeiling: 1500, wallRays: 32, wallSampleHeight: 48 }
  },
  navmesh: {
    bakeVersion: "1.0.0", inputKey: "k2", file: "baked/navmesh.bin", bytes: 300, sha256: "c",
    polygons: 10, vertices: 30, tiles: 2, stitchedEdges: 4, components: 1, largestComponentShare: 1,
    links: { count: 2, dropped: 0, byKind: { zipline: 2 } },
    agent: { radius: 16, height: 72, climb: 18, slopeDegrees: 45 },
    recast: { cellSize: 8, cellHeight: 4, tileSize: 128 }, excludedLayers: ["sky"], inputTriangles: 12
  }
})

const baseTile = buildMiniMap().manifest.tiles[0]!
const withLods = (style: "fields" | "id"): ManifestT => {
  const m = buildMiniMap().manifest
  const lod1 = style === "fields"
    ? { ...baseTile, id: "t0.lod1", file: "render/t0.lod1.glb", lod: 1, lodOf: "t0" }
    : { ...baseTile, id: "t0#lod1", file: "render/t0.lod1.glb" }
  return { ...m, tiles: [baseTile, lod1] }
}

const decode = (v: unknown) => Effect.runSync(Schema.decodeUnknownEffect(Manifest)(v))

test("manifest accepts the real baked shape, with and without navmesh", () => {
  const m = buildMiniMap().manifest
  const full = decode({ ...m, baked: realBaked() })
  expect(full.baked?.sampleGrid.nx).toBe(333)
  expect(full.baked?.navmesh?.links.byKind["zipline"]).toBe(2)
  const { navmesh: _n, ...noNav } = realBaked()
  expect(decode({ ...m, baked: noNav }).baked?.navmesh).toBeUndefined()
})

test("baked rejects missing or mistyped fields", () => {
  const bad = (f: (b: ReturnType<typeof realBaked>) => unknown) => () => Effect.runSync(Schema.decodeUnknownEffect(Baked)(f(realBaked())))
  expect(bad((b) => ({ ...b, bvh: { ...b.bvh, sha256: 1 } }))).toThrow()
  expect(bad(({ sampleGrid: _s, ...rest }) => rest)).toThrow()
  expect(bad((b) => ({ ...b, sampleGrid: { ...b.sampleGrid, origin: [1] } }))).toThrow()
  expect(bad((b) => ({ ...b, placeholder: "yes" }))).toThrow()
})

test("baked round-trips through encode/decode", () => {
  const b = Effect.runSync(Schema.decodeUnknownEffect(Baked)(realBaked()))
  expect(Effect.runSync(Schema.encodeEffect(Baked)(b))).toEqual(realBaked())
})

test("tile lod: field, legacy id suffix and default agree", () => {
  expect(tileLod(baseTile)).toBe(0)
  expect(tileLod({ id: "t0#lod2" })).toBe(2)
  expect(tileLod({ id: "t0.lod1", lod: 1 })).toBe(1)
  expect(tileBaseId({ id: "t0#lod2" })).toBe("t0")
  expect(tileBaseId({ id: "t0.lod1", lodOf: "t0" })).toBe("t0")
  expect(tileBaseId(baseTile)).toBe("t0")
  for (const style of ["fields", "id"] as const) {
    const m = withLods(style)
    expect(tilesAtLod(m).map((t) => t.id)).toEqual(["t0"])
    expect(tilesAtLod(m, 1)).toHaveLength(1)
  }
})

test("tile lod must be a non-negative integer", () => {
  const m = buildMiniMap().manifest
  const tile = (extra: object) => decode({ ...m, tiles: [{ ...m.tiles[0], ...extra }] })
  expect(tile({ lod: 1, lodOf: "t0" }).tiles[0]?.lod).toBe(1)
  expect(() => tile({ lod: -1 })).toThrow()
  expect(() => tile({ lod: 1.5 })).toThrow()
})

test("checkTiles accepts both LOD encodings and flags broken ones", () => {
  expect(checkTiles(withLods("fields"))).toEqual({ errors: [], warnings: [] })
  expect(checkTiles(withLods("id"))).toEqual({ errors: [], warnings: [] })
  const m = withLods("fields")
  const lod = m.tiles[1]!
  const errs = (tiles: ManifestT["tiles"]) => checkTiles({ tiles }).errors.join("\n")
  expect(errs([baseTile, { ...lod, lodOf: "gone" }])).toContain("base tile gone not found")
  expect(errs([baseTile, { ...lod, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }])).toContain("bounds differ")
  expect(errs([baseTile, baseTile])).toContain("duplicate tile id")
  expect(errs([baseTile, { ...lod, id: "t0#lod2" }])).toContain("disagrees with the id suffix")
  expect(errs([{ ...baseTile, lodOf: "x" }])).toContain("lodOf is set on a LOD0")
  expect(errs([baseTile, lod, { ...lod, id: "t0.lod1b" }])).toContain("LOD 1 appears more than once")
})

test("checkTiles warns about a missing LOD level and uneven LOD counts", () => {
  const m = withLods("fields")
  const lod3 = { ...m.tiles[1]!, id: "t0.lod3", lod: 3 }
  expect(checkTiles({ tiles: [baseTile, lod3] }).warnings.join("\n")).toContain("LOD 1 missing")
  const t1 = { ...baseTile, id: "t1" }
  expect(checkTiles({ tiles: [baseTile, m.tiles[1]!, t1] }).warnings.join("\n")).toContain("differing LOD counts")
})

/** In-memory bundle files for checkFiles: byte contents keyed by path. */
const bundleFiles = (manifest: ManifestT, content: Record<string, Uint8Array>) => ({
  files: {
    size: (f: string) => content[f]?.length,
    sha256: (f: string) => sha256Hex(content[f]!)
  },
  manifest
})

const bakedBundle = () => {
  const bytes = (n: number, v: number) => new Uint8Array(n).fill(v)
  const bvh = bytes(10, 1), grid = bytes(20, 2), nav = bytes(30, 3)
  const real = realBaked()
  const baked = {
    ...real,
    bvh: { ...real.bvh, bytes: bvh.length, sha256: sha256Hex(bvh) },
    sampleGrid: { ...real.sampleGrid, bytes: grid.length, sha256: sha256Hex(grid) },
    navmesh: { ...real.navmesh, bytes: nav.length, sha256: sha256Hex(nav) }
  }
  const m = decode({ ...withLods("fields"), baked })
  const mini = buildMiniMap()
  const content: Record<string, Uint8Array> = {
    [m.tiles[0]!.file]: mini.renderGlb,
    [m.tiles[1]!.file]: bytes(m.tiles[1]!.bytes, 9),
    [m.collision!.file]: mini.collisionGlb,
    [m.entitiesFile]: bytes(1, 0),
    "baked/collision.bvh": bvh, "baked/sample-grid.bin": grid, "baked/navmesh.bin": nav
  }
  // The LOD tile copies the base tile's metadata, so give it matching content.
  content[m.tiles[1]!.file] = mini.renderGlb
  return { m, content }
}

test("checkFiles passes a complete baked bundle (placeholder semantics only warns)", () => {
  const { m, content } = bakedBundle()
  const { files } = bundleFiles(m, content)
  const r = checkFiles(m, files)
  expect(r.errors).toEqual([])
  expect(r.warnings.join("\n")).toContain("placeholder semantics")
})

test("checkFiles reports missing, resized and corrupted files", () => {
  const { m, content } = bakedBundle()
  const run = (c: Record<string, Uint8Array>) => checkFiles(m, bundleFiles(m, c).files).errors.join("\n")
  const { "baked/collision.bvh": _gone, ...withoutBvh } = content
  expect(run(withoutBvh)).toContain("missing baked bvh file baked/collision.bvh")
  expect(run({ ...content, "baked/sample-grid.bin": new Uint8Array(5) })).toContain("5 bytes on disk, manifest says 20")
  expect(run({ ...content, "baked/navmesh.bin": new Uint8Array(30).fill(7) })).toContain("sha256 does not match")
  expect(run({ ...content, [m.tiles[1]!.file]: new Uint8Array(3) })).toContain(`tile ${m.tiles[1]!.file}`)
  // --no-hash style: a same-size corrupted file passes when hashing is off.
  expect(checkFiles(m, bundleFiles(m, { ...content, "baked/navmesh.bin": new Uint8Array(30).fill(7) }).files, { hash: false }).errors).toEqual([])
})

test("checkFiles validates the sample grid description", () => {
  const { m, content } = bakedBundle()
  const grid = (g: Partial<NonNullable<ManifestT["baked"]>["sampleGrid"]>): ManifestT =>
    ({ ...m, baked: { ...m.baked!, sampleGrid: { ...m.baked!.sampleGrid, ...g } } })
  const errs = (mm: ManifestT) => checkFiles(mm, bundleFiles(mm, content).files).errors.join("\n")
  expect(errs(grid({ channels: ["interior"] }))).toContain("no floorHeight channel")
  expect(errs(grid({ channels: ["floorHeight", "floorHeight"] }))).toContain("not unique")
  expect(errs(grid({ nx: 0 }))).toContain("non-positive dimensions")
})

test("an unbaked manifest has no baked checks to fail", () => {
  const mini = buildMiniMap()
  const content = {
    [mini.manifest.tiles[0]!.file]: mini.renderGlb,
    [mini.manifest.collision!.file]: mini.collisionGlb,
    [mini.manifest.entitiesFile]: new Uint8Array(1)
  }
  expect(checkFiles(mini.manifest, bundleFiles(mini.manifest, content).files)).toEqual({ errors: [], warnings: [] })
})

test("the mini-map fixture has an entity for every EntityKind", () => {
  const kinds = new Set(buildMiniMap().entities.map((e) => e.kind))
  for (const k of EntityKind.literals) expect(kinds.has(k)).toBe(true)
})

test("fixture manifest still decodes as a versioned Manifest", async () => {
  const m = await Effect.runPromise(decodeVersioned(Manifest, 1)(buildMiniMap().manifest))
  expect(m.tiles).toHaveLength(1)
})
