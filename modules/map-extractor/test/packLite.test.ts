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
