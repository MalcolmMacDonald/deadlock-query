import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { packLite } from "../src/packLite.ts"

test("pack-lite validates lite tier bundle and checks for textures", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "dlq-bundle-"))

  // Create a minimal lite bundle
  const manifest = {
    gameBuildId: "25712201",
    mapName: "dl_midtown",
    tier: "lite",
    schemaVersion: "1.0.0",
    entitiesFile: "entities.json",
    coordinateSystem: {
      up: "Z",
      unit: "source",
      glbToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    },
    bounds: { min: [-500, -500, -1000], max: [500, 500, 1000] },
    tiles: [{
      id: "tile0",
      file: "render/tile.glb",
      bytes: 5 * 1024 * 1024,
      bounds: { min: [-500, -500, -1000], max: [500, 500, 1000] },
      sha256: "abc123def456"
    }],
    collision: {
      file: "collision/physics.glb",
      format: "glb",
      glbToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      layers: ["solid", "playerclip"]
    },
    provenance: {
      extractorVersion: "0.3.0",
      s2vVersion: "20.0"
    }
  }

  // Write manifest
  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest))

  // Create entities file
  const entities = { entities: [], schemaVersion: "1.0.0" }
  writeFileSync(join(bundleDir, "entities.json"), JSON.stringify(entities))

  // Create render directory and tile file
  mkdirSync(join(bundleDir, "render"), { recursive: true })
  writeFileSync(join(bundleDir, "render", "tile.glb"), Buffer.alloc(5 * 1024 * 1024))

  // Create collision file
  mkdirSync(join(bundleDir, "collision"), { recursive: true })
  writeFileSync(join(bundleDir, "collision", "physics.glb"), Buffer.alloc(6 * 1024 * 1024))

  // Test pack-lite on valid lite bundle with no textures
  const result = await packLite(bundleDir)
  expect(result.ok).toBe(true)
  expect(result.tier).toBe("lite")
  expect(result.buildId).toBe("25712201")
  expect(result.mapName).toBe("dl_midtown")
  expect(result.sizes.textureFiles).toEqual([])
  expect(result.errors).toEqual([])
  expect(result.warnings.length).toBe(0)

  // Add a texture file and re-test
  writeFileSync(join(bundleDir, "render", "texture.png"), Buffer.alloc(2 * 1024 * 1024))
  const resultWithTexture = await packLite(bundleDir)
  expect(resultWithTexture.ok).toBe(false)
  expect(resultWithTexture.sizes.textureFiles).toContain("render/texture.png")
  expect(resultWithTexture.errors.some((e) => e.includes("texture files"))).toBe(true)
})

test("pack-lite rejects non-lite bundles", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "dlq-bundle-full-"))

  const manifest = {
    gameBuildId: "25712201",
    mapName: "dl_midtown",
    tier: "full",
    schemaVersion: "1.0.0",
    entitiesFile: "entities.json",
    coordinateSystem: {
      up: "Z",
      unit: "source",
      glbToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    },
    bounds: { min: [0, 0, 0], max: [100, 100, 100] },
    tiles: [],
    provenance: {
      extractorVersion: "0.3.0",
      s2vVersion: "20.0"
    }
  }

  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(bundleDir, "entities.json"), JSON.stringify({ entities: [], schemaVersion: "1.0.0" }))

  const result = await packLite(bundleDir)
  expect(result.ok).toBe(false)
  expect(result.errors.some((e) => e.includes('expected tier "lite"'))).toBe(true)
})

test("pack-lite catches missing manifest", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "dlq-bundle-nofile-"))

  const result = await packLite(bundleDir)
  expect(result.ok).toBe(false)
  expect(result.errors[0]).toBe("manifest.json not found")
})

test("pack-lite checks every tile file named in the manifest, including nested LOD files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-bundle-"))
  const mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const b = { min: [0, 0, 0], max: [1, 1, 1] }
  const tile = (id: string, file: string) => ({ id, file, bytes: 1, bounds: b, sha256: "x" })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: "1.0.0", gameBuildId: "1", mapName: "m", tier: "lite", coordinateSystem: { up: "Z", unit: "source", glbToWorld: mat },
    bounds: b, tiles: [tile("a", "render/tiles/a.glb"), tile("a#lod1", "render/tiles/a.lod1.glb")], entitiesFile: "entities.json",
    provenance: { extractorVersion: "0.3.0", s2vVersion: "20.0" }
  }))
  mkdirSync(join(dir, "render", "tiles"), { recursive: true })
  writeFileSync(join(dir, "render", "tiles", "a.glb"), Buffer.alloc(21 * 1024 * 1024))
  const r = await packLite(dir)
  expect(r.ok).toBe(false)
  expect(r.errors.some((e) => e.startsWith("tile a is 21.0 MB"))).toBe(true)
  expect(r.errors.some((e) => e.includes("a#lod1 references missing file"))).toBe(true)
})

test("pack-lite leaves scratch (.work, .stage-*) out of the size total", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-bundle-"))
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const box = { min: [0, 0, 0], max: [1, 1, 1] }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    gameBuildId: "1", mapName: "m", tier: "lite", schemaVersion: "1.0.0", entitiesFile: "entities.json",
    coordinateSystem: { up: "Z", unit: "source", glbToWorld: ident }, bounds: box,
    tiles: [{ id: "t", file: "render/t.glb", bytes: 1, bounds: box, sha256: "x" }],
    provenance: { extractorVersion: "0.3.0", s2vVersion: "20.0" }
  }))
  writeFileSync(join(dir, "entities.json"), JSON.stringify({ entities: [], schemaVersion: "1.0.0" }))
  mkdirSync(join(dir, "render"), { recursive: true }); writeFileSync(join(dir, "render", "t.glb"), Buffer.alloc(1000))
  mkdirSync(join(dir, ".work"), { recursive: true }); writeFileSync(join(dir, ".work", "big.bin"), Buffer.alloc(5000))
  writeFileSync(join(dir, ".stage-x"), "scratch")
  const r = await packLite(dir)
  expect(r.ok).toBe(true)
  expect(r.sizes.totalBytes).toBeLessThan(5000)
  expect(r.warnings.some((w) => w.includes(".work/big.bin"))).toBe(true)
})
