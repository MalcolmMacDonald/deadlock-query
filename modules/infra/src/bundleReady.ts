import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { Manifest, checkFiles, checkTiles, decodeVersioned } from "@deadlock-query/contracts"

/**
 * Is the bundle in `dir` safe to publish? Runs the contracts checks (every file the manifest names exists with the recorded
 * size and sha256, LOD tiles are consistent) and requires the baked data, so a manifest rewritten by a later `extract`
 * (no LODs, stale tile hashes, no `baked`) is caught before upload. Returns one message per problem.
 */
export const checkBundleReady = async (dir: string, files: string[]): Promise<string[]> => {
  let manifest: Manifest
  try {
    manifest = await Effect.runPromise(decodeVersioned(Manifest, 1)(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))))
  } catch (e) {
    return [`manifest.json is not a valid v1 manifest: ${e instanceof Error ? e.message : String(e)}`]
  }
  const errors: string[] = []
  const published = new Set(files)
  const size = (f: string) => (published.has(f) ? statSync(join(dir, f)).size : undefined)
  const sha256 = (f: string) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")
  errors.push(...checkTiles(manifest).errors, ...checkFiles(manifest, { size, sha256 }).errors)
  if (!manifest.baked) errors.push("manifest has no baked data: run `dlq-extract bake <bundle>`")
  else if (!manifest.baked.navmesh) errors.push("manifest.baked has no navmesh: run `dlq-extract bake <bundle>` without --no-navmesh")
  if (manifest.tiles.length > 0 && !manifest.tiles.some((t) => t.id.includes("#lod"))) errors.push("tiles have no LODs: run `dlq-extract tile <bundle>`")
  return errors
}
