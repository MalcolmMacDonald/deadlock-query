import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkBundleReady } from "../src/bundleReady.ts"
import { assetName, bundleFiles, checkBundleBudget, isPublishable, parseBundleManifest, releaseTag, updatePointer } from "../../../tools/lib/publish.ts"

const info = parseBundleManifest({ gameBuildId: "42", mapName: "dl_midtown", tier: "lite" })

test("names and tag", () => {
  expect(assetName(info, "ab".repeat(32))).toBe("dl_midtown-42-lite-abababababab.zip")
  expect(assetName(info, "ab".repeat(32))).not.toBe(assetName(info, "cd".repeat(32))) // a re-publish never overwrites an older asset
  expect(releaseTag(info)).toBe("data-42")
  expect(() => parseBundleManifest({ gameBuildId: "../x", mapName: "m", tier: "lite" })).toThrow()
  expect(() => parseBundleManifest({})).toThrow()
})

test("scratch and stage stamps are excluded", () => {
  expect(isPublishable(".work/x")).toBe(false)
  expect(isPublishable(".stage-render")).toBe(false)
  expect(isPublishable("collision/walkable.nav")).toBe(false) // raw game file, bake input only
  expect(isPublishable("collision/walkable.navflowmap")).toBe(false)
  expect(isPublishable("baked/navmesh.bin")).toBe(true)
  const d = mkdtempSync(join(tmpdir(), "dlq-"))
  mkdirSync(join(d, ".work")); mkdirSync(join(d, "collision"))
  for (const f of ["manifest.json", ".stage-entities", ".work/a", "collision/physics.glb", "collision/walkable.nav"]) writeFileSync(join(d, f), "x")
  expect(bundleFiles(d).sort()).toEqual(["collision/physics.glb", "manifest.json"])
  expect(checkBundleBudget(d, bundleFiles(d))).toEqual([])
})

test("updatePointer replaces on a new tag and merges on the same tag", () => {
  const a = updatePointer(undefined, info, "a".repeat(64))
  expect(a.assets).toEqual([{ name: "dl_midtown-42-lite-aaaaaaaaaaaa.zip", sha256: "a".repeat(64), dest: "data/dl_midtown" }])
  const b = updatePointer(a, { ...info, mapName: "dl_hideout" }, "b".repeat(64))
  expect(b.assets.length).toBe(2)
  const c = updatePointer(b, info, "c".repeat(64))
  expect(c.assets.find((x) => x.dest === "data/dl_midtown")!.sha256).toBe("c".repeat(64))
  expect(updatePointer(c, { ...info, buildId: "43" }, "d".repeat(64)).assets.length).toBe(1)
})

test("writeZip output is readable by unzip and by fetchData's extractor", async () => {
  const { writeZip } = await import("../../../tools/lib/zip.ts")
  const { spawnSync } = await import("node:child_process")
  const { readFileSync } = await import("node:fs")
  const d = mkdtempSync(join(tmpdir(), "dlq-"))
  mkdirSync(join(d, "src/sub"), { recursive: true })
  writeFileSync(join(d, "src/manifest.json"), "{}".repeat(500))
  writeFileSync(join(d, "src/sub/a.bin"), Buffer.from([1, 2, 3, 250, 251]))
  writeFileSync(join(d, "src/empty"), "")
  writeZip(join(d, "x.zip"), join(d, "src"), ["manifest.json", "sub/a.bin", "empty"])
  expect(spawnSync("unzip", ["-tq", join(d, "x.zip")]).status).toBe(0)
  spawnSync("unzip", ["-q", join(d, "x.zip"), "-d", join(d, "out")])
  expect(readFileSync(join(d, "out/manifest.json"), "utf8")).toBe("{}".repeat(500))
  expect([...readFileSync(join(d, "out/sub/a.bin"))]).toEqual([1, 2, 3, 250, 251])
})

const sha = (b: string) => createHash("sha256").update(b).digest("hex")

/** A tiled, baked bundle on disk, shaped like the extractor's output (file contents are placeholders; checks are size + sha256). */
const readyBundle = () => {
  const d = mkdtempSync(join(tmpdir(), "dlq-ready-"))
  for (const sub of ["render/tiles", "collision", "baked"]) mkdirSync(join(d, sub), { recursive: true })
  const files: Record<string, string> = {
    "render/tiles/0_0.glb": "lod0", "render/tiles/0_0.lod1.glb": "lod1", "collision/physics.glb": "phys", "entities.json": "{}",
    "baked/collision.bvh": "bvh", "baked/sample-grid.bin": "grid", "baked/navmesh.bin": "nav"
  }
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c)
  const bounds = { min: [0, 0, 0], max: [1, 1, 1] }
  const tile = (id: string, file: string) => ({ id, file, bounds, bytes: files[file]!.length, sha256: sha(files[file]!) })
  const entry = (file: string) => ({ file, bytes: files[file]!.length, sha256: sha(files[file]!) })
  const manifest = {
    schemaVersion: "1.0.0", gameBuildId: "42", mapName: "dl_midtown", tier: "lite",
    coordinateSystem: { up: "Z", unit: "source", glbToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    bounds, tiles: [tile("0_0", "render/tiles/0_0.glb"), tile("0_0#lod1", "render/tiles/0_0.lod1.glb")],
    collision: { file: "collision/physics.glb", format: "glb", glbToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], layers: [] },
    entitiesFile: "entities.json",
    baked: {
      bakeVersion: "1", semanticsVersion: "s", placeholder: true, inputKey: "k",
      bvh: { ...entry("baked/collision.bvh"), triangles: 1, vertices: 3, excludedLayers: [], skippedNodes: 0 },
      sampleGrid: { ...entry("baked/sample-grid.bin"), cellSize: 64, nx: 1, ny: 1, origin: [0, 0], channels: ["floorHeight"], params: {} },
      navmesh: {
        ...entry("baked/navmesh.bin"), bakeVersion: "1", inputKey: "k", polygons: 1, vertices: 3, tiles: 1, stitchedEdges: 0, components: 1, largestComponentShare: 1,
        links: { count: 0, dropped: 0, byKind: {} }, agent: { radius: 16, height: 72, climb: 18, slopeDegrees: 45 },
        recast: { cellSize: 8, cellHeight: 4, tileSize: 128 }, excludedLayers: [], inputTriangles: 1
      }
    },
    provenance: { extractorVersion: "0.4.0", s2vVersion: "20.0" }
  }
  const write = (m: unknown) => writeFileSync(join(d, "manifest.json"), JSON.stringify(m))
  write(manifest)
  return { d, manifest, write }
}

test("checkBundleReady accepts a tiled, baked bundle", async () => {
  const { d } = readyBundle()
  expect(await checkBundleReady(d, bundleFiles(d))).toEqual([])
})

test("checkBundleReady catches a manifest an `extract` rerun rewrote (no LODs, no baked, stale tile hash)", async () => {
  const { d, manifest, write } = readyBundle()
  const { baked: _baked, ...rest } = manifest
  write({ ...rest, tiles: [{ ...manifest.tiles[0]!, sha256: "0".repeat(64) }] })
  const errors = (await checkBundleReady(d, bundleFiles(d))).join("\n")
  expect(errors).toContain("sha256 does not match")
  expect(errors).toContain("no baked data")
  expect(errors).toContain("no LODs")
})

test("checkBundleReady requires the navmesh and every baked file to be published", async () => {
  const { d, manifest, write } = readyBundle()
  const { navmesh: _nav, ...baked } = manifest.baked
  write({ ...manifest, baked })
  expect((await checkBundleReady(d, bundleFiles(d))).join("\n")).toContain("no navmesh")
  write(manifest)
  expect((await checkBundleReady(d, bundleFiles(d).filter((f) => f !== "baked/navmesh.bin"))).join("\n")).toContain("missing baked navmesh file")
})

test("checkBundleReady reports an unreadable manifest instead of throwing", async () => {
  const d = mkdtempSync(join(tmpdir(), "dlq-ready-"))
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ gameBuildId: "42" }))
  expect((await checkBundleReady(d, ["manifest.json"]))[0]).toContain("not a valid v1 manifest")
})
