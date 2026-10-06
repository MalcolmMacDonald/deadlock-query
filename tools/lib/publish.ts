import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { MB, DEFAULT_BUDGETS } from "./budget.ts"
import type { DataPointer } from "./data.ts"

export interface BundleInfo { buildId: string; mapName: string; tier: string }

export const parseBundleManifest = (raw: unknown): BundleInfo => {
  const m = raw as Record<string, unknown> | null
  if (!m || typeof m.gameBuildId !== "string" || typeof m.mapName !== "string" || typeof m.tier !== "string")
    throw new Error("manifest.json: expected gameBuildId, mapName and tier")
  if (!/^[0-9A-Za-z_-]+$/.test(m.gameBuildId) || !/^[0-9A-Za-z_-]+$/.test(m.mapName)) throw new Error("manifest.json: unsafe build id or map name")
  return { buildId: m.gameBuildId, mapName: m.mapName, tier: m.tier }
}

export const assetName = (b: BundleInfo) => `${b.mapName}-${b.buildId}-${b.tier}.zip`
export const releaseTag = (b: BundleInfo) => `data-${b.buildId}`

/** Scratch (`.work`) and stage-stamp files are not part of a published bundle. */
export const isPublishable = (rel: string) => !rel.split("/").some((p) => p === ".work" || p.startsWith(".stage-"))

/** Publishable files of a bundle dir (relative, forward-slash paths). */
export const bundleFiles = (dir: string, rel = ""): string[] =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n
    if (!isPublishable(r)) return []
    return statSync(join(dir, r)).isDirectory() ? bundleFiles(dir, r) : [r]
  })

/** Hosted data must fit the site budget; returns one message per problem. */
export const checkBundleBudget = (dir: string, files: string[]): string[] => {
  const errors: string[] = []
  const total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0)
  if (total > DEFAULT_BUDGETS.siteBytes) errors.push(`bundle is ${(total / MB).toFixed(0)} MB, over the ${DEFAULT_BUDGETS.siteBytes / MB} MB site budget (publish the lite tier)`)
  for (const f of files)
    if (/\.(gltf|glb|bin)$/.test(f) && statSync(join(dir, f)).size > DEFAULT_BUDGETS.tileBytes * 5)
      errors.push(`${f} is ${(statSync(join(dir, f)).size / MB).toFixed(0)} MB; too large to host`)
  return errors
}

/** New pointer for a published asset: same tag adds/replaces the asset with the same dest, a new tag replaces the pointer. */
export const updatePointer = (prev: DataPointer | undefined, b: BundleInfo, sha256: string): DataPointer => {
  const asset = { name: assetName(b), sha256, dest: `data/${b.mapName}` }
  const keep = prev && prev.tag === releaseTag(b) ? prev.assets.filter((a) => a.dest !== asset.dest) : []
  return { buildId: b.buildId, tag: releaseTag(b), assets: [...keep, asset] }
}
