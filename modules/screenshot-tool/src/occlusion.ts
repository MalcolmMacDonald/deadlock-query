import { Manifest } from "@deadlock-query/contracts"
import { NavMesh, Raycaster } from "@deadlock-query/spatial-core"
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
  /** Walkable floor height under (x, y) near the reference height `nearZ`, within `maxDist`; `undefined` when the bundle has no baked navmesh. */
  readonly floorAt: ((x: number, y: number, nearZ: number, maxDist: number) => number | undefined) | undefined
}

/**
 * Open a bundle for planning: its manifest, and (when `manifest.baked.bvh` exists) the baked collision BVH as an `Occlusion`.
 * The BVH file is checked against the manifest's size and sha256 so a stale or truncated bake is an error, not a wrong answer.
 */
export const loadBundle = (dir: string): BundleOcclusion => {
  let manifest: Manifest
  try { manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))) }
  catch (e) { throw new PlanError([`cannot read a bundle manifest in ${dir}: ${(e as Error).message.split("\n")[0]}`]) }
  const read = (rec: { readonly file: string; readonly bytes: number; readonly sha256?: string | undefined }, what: string): ArrayBuffer => {
    let bytes: Buffer
    try { bytes = readFileSync(join(dir, rec.file)) } catch (e) { throw new PlanError([`cannot read the baked ${what} ${rec.file}: ${(e as Error).message}`]) }
    if (bytes.length !== rec.bytes || (rec.sha256 !== undefined && createHash("sha256").update(bytes).digest("hex") !== rec.sha256)) {
      throw new PlanError([`${rec.file} does not match the manifest (size or sha256); re-run \`dlq-extract bake\``])
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
  const bvh = manifest.baked?.bvh
  const occlusion: Occlusion | undefined = bvh === undefined ? undefined : (() => {
    const rc = Raycaster.deserialize(read(bvh, "collision"))
    return { blocked: (from, to) => rc.occluded(from, to) }
  })()
  const nav = manifest.baked?.navmesh
  const floorAt = nav === undefined ? undefined : (() => {
    const mesh = NavMesh.load(read(nav, "navmesh"))
    return (x: number, y: number, nearZ: number, maxDist: number) => mesh.nearestPoint([x, y, nearZ], { maxDist })?.point[2]
  })()
  return { manifest, occlusion, floorAt }
}
