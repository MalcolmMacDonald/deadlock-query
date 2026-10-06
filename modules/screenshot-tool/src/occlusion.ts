import { Manifest } from "@deadlock-query/contracts"
import { Raycaster } from "@deadlock-query/spatial-core"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PlanError } from "./plan.ts"
import type { Occlusion } from "./targets.ts"

export interface BundleOcclusion {
  readonly manifest: Manifest
  /** Line-of-sight test over the bundle's baked collision BVH; `undefined` when the bundle has none. */
  readonly occlusion: Occlusion | undefined
}

/**
 * Open a bundle for planning: its manifest, and (when `manifest.baked.bvh` exists) the baked collision BVH as an `Occlusion`.
 * The BVH file is checked against the manifest's size and sha256 so a stale or truncated bake is an error, not a wrong answer.
 */
export const loadBundle = (dir: string): BundleOcclusion => {
  let manifest: Manifest
  try { manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))) }
  catch (e) { throw new PlanError([`cannot read a bundle manifest in ${dir}: ${(e as Error).message.split("\n")[0]}`]) }
  const bvh = manifest.baked?.bvh
  if (bvh === undefined) return { manifest, occlusion: undefined }
  let bytes: Buffer
  try { bytes = readFileSync(join(dir, bvh.file)) } catch (e) { throw new PlanError([`cannot read the baked collision ${bvh.file}: ${(e as Error).message}`]) }
  if (bytes.length !== bvh.bytes || createHash("sha256").update(bytes).digest("hex") !== bvh.sha256) {
    throw new PlanError([`${bvh.file} does not match the manifest (size or sha256); re-run \`dlq-extract bake\``])
  }
  const rc = Raycaster.deserialize(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  return { manifest, occlusion: { blocked: (from, to) => rc.occluded(from, to) } }
}
