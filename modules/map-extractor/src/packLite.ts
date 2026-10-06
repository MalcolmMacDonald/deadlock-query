import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { Manifest, decodeVersioned } from "@deadlock-query/contracts"

export interface PackLiteReport {
  readonly ok: boolean
  readonly tier: string | undefined
  readonly buildId: string | undefined
  readonly mapName: string | undefined
  readonly errors: string[]
  readonly warnings: string[]
  readonly sizes: {
    readonly totalBytes: number
    readonly textureBytes: number
    readonly textureFiles: string[]
    readonly tileCount: number
    readonly collisionBytes: number | undefined
  }
}

/** Texture file extensions that should not be in a lite bundle. */
const TEXTURE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".basis", ".tga", ".bmp"]

const isTextureFile = (path: string): boolean => TEXTURE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))

const walk = (dir: string, rel = ""): string[] =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n
    const fullPath = join(dir, r)
    return statSync(fullPath).isDirectory() ? walk(dir, r) : [r]
  })

/** Validate that a bundle is lite-tier and ready for packing; check for texture files, sizes, and budget compliance. */
export const packLite = async (dir: string): Promise<PackLiteReport> => {
  const errors: string[] = []
  const warnings: string[] = []
  const textureFiles: string[] = []
  let tier: string | undefined
  let buildId: string | undefined
  let mapName: string | undefined
  let totalBytes = 0
  let textureBytes = 0
  let tileCount = 0
  let collisionBytes: number | undefined

  // Validate manifest exists and is lite
  try {
    if (!existsSync(join(dir, "manifest.json"))) {
      errors.push("manifest.json not found")
      return { ok: false, tier, buildId, mapName, errors, warnings, sizes: { totalBytes, textureBytes, textureFiles, tileCount, collisionBytes } }
    }

    const manifest = await Effect.runPromise(decodeVersioned(Manifest, 1)(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))))
    tier = manifest.tier
    buildId = manifest.gameBuildId
    mapName = manifest.mapName

    if (tier !== "lite") {
      errors.push(`expected tier "lite", got "${tier}"`)
    }

    // Count tiles and check sizes
    tileCount = manifest.tiles.length
    if (tileCount === 0) warnings.push("no tiles in manifest")

    // Check collision
    if (manifest.collision) {
      const collisionPath = join(dir, manifest.collision.file)
      if (existsSync(collisionPath)) {
        collisionBytes = statSync(collisionPath).size
      } else {
        warnings.push(`collision file referenced in manifest but not found: ${manifest.collision.file}`)
      }
    }
  } catch (e) {
    errors.push(`manifest validation failed: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, tier, buildId, mapName, errors, warnings, sizes: { totalBytes, textureBytes, textureFiles, tileCount, collisionBytes } }
  }

  // Walk bundle and check files
  try {
    const files = walk(dir)
    for (const f of files) {
      const fullPath = join(dir, f)
      const size = statSync(fullPath).size
      totalBytes += size

      if (isTextureFile(f)) {
        textureFiles.push(f)
        textureBytes += size
      }

      // Warn about work files that shouldn't be in a published bundle
      if (f.startsWith(".work/") || f.startsWith(".stage-")) {
        warnings.push(`scratch file should be excluded from published bundle: ${f}`)
      }
    }
  } catch (e) {
    errors.push(`file walk failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Check budget
  const SITE_BUDGET = 900 * 1024 * 1024 // 900 MB
  const TILE_BUDGET = 20 * 1024 * 1024 // 20 MB per tile
  const MB = 1024 * 1024

  if (totalBytes > SITE_BUDGET) {
    errors.push(`bundle is ${(totalBytes / MB).toFixed(1)} MB, exceeds site budget of ${(SITE_BUDGET / MB).toFixed(0)} MB`)
  }

  // Check individual tile sizes (tiles/* files)
  if (existsSync(join(dir, "render"))) {
    const tiles = readdirSync(join(dir, "render")).filter((f) => f.endsWith(".glb") || f.endsWith(".gltf") || f.endsWith(".bin"))
    for (const tile of tiles) {
      const tileSize = statSync(join(dir, "render", tile)).size
      if (tileSize > TILE_BUDGET) {
        errors.push(`tile ${tile} is ${(tileSize / MB).toFixed(1)} MB, exceeds per-tile budget of ${(TILE_BUDGET / MB).toFixed(0)} MB`)
      }
    }
  }

  // Texture files are an error in lite bundles
  if (textureFiles.length > 0) {
    errors.push(`lite bundle must not include texture files (${textureFiles.length} found, ${(textureBytes / MB).toFixed(1)} MB total)`)
  }

  return {
    ok: errors.length === 0,
    tier,
    buildId,
    mapName,
    errors,
    warnings,
    sizes: { totalBytes, textureBytes, textureFiles, tileCount, collisionBytes }
  }
}
