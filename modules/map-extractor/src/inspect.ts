import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { EntitiesFile, Manifest, decodeVersioned } from "@deadlock-query/contracts"
import { gltfInfo, readGltfJson } from "./gltfInfo.ts"
import { worldBounds } from "./extract.ts"

export interface InspectReport { readonly ok: boolean; readonly errors: string[]; readonly warnings: string[]; readonly info: Record<string, unknown> }

const overlap = (a: { min: readonly number[]; max: readonly number[] }, b: { min: readonly number[]; max: readonly number[] }) =>
  [0, 1, 2].every((i) => a.min[i]! <= b.max[i]! && b.min[i]! <= a.max[i]!)

/** Validate a bundle against the contracts schemas and report sizes plus frame sanity. */
export const inspectBundle = async (dir: string): Promise<InspectReport> => {
  const errors: string[] = [], warnings: string[] = [], info: Record<string, unknown> = {}
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"))
  try {
    const manifest = await Effect.runPromise(decodeVersioned(Manifest, 1)(read("manifest.json")))
    const ents = await Effect.runPromise(decodeVersioned(EntitiesFile, 1)(read(manifest.entitiesFile)))
    info["entities"] = ents.entities.length
    info["entitiesWithKind"] = ents.entities.filter((e) => e.kind).length
    for (const t of manifest.tiles) {
      if (!existsSync(join(dir, t.file))) errors.push(`missing tile file ${t.file}`)
      else info[`tile:${t.id}:bytes`] = t.bytes
    }
    if (manifest.collision) {
      const p = join(dir, manifest.collision.file)
      if (!existsSync(p)) errors.push(`missing collision file ${manifest.collision.file}`)
      else {
        info["collisionBytes"] = statSync(p).size
        const wb = worldBounds(gltfInfo(readGltfJson(p)), manifest.collision.glbToWorld)
        info["collisionWorldBounds"] = wb
        const origins = ents.entities.map((e) => e.position)
        if (wb && origins.length) {
          const eb = { min: [0, 1, 2].map((i) => Math.min(...origins.map((p) => p[i]!))), max: [0, 1, 2].map((i) => Math.max(...origins.map((p) => p[i]!))) }
          info["entityBounds"] = eb
          if (!overlap(wb, eb)) warnings.push("collision bounds (after glbToWorld) do not overlap entity bounds: frame/scale suspect")
        }
      }
    } else warnings.push("manifest has no collision reference")
    const baked = manifest.baked as { navmesh?: { file: string; bytes: number; polygons?: number; components?: number; largestComponentShare?: number }; bvh?: { file: string; bytes: number }; sampleGrid?: { file: string; bytes: number }; placeholder?: boolean; semanticsVersion?: string } | undefined
    if (baked) {
      for (const [k, f] of [["bvh", baked.bvh], ["sampleGrid", baked.sampleGrid]] as const) {
        if (!f) errors.push(`manifest.baked.${k} missing`)
        else if (!existsSync(join(dir, f.file))) errors.push(`missing baked file ${f.file}`)
        else if (statSync(join(dir, f.file)).size !== f.bytes) errors.push(`baked file ${f.file} size differs from manifest (${statSync(join(dir, f.file)).size} != ${f.bytes}): re-run bake`)
      }
      const nav = baked.navmesh
      if (nav) {
        const p = join(dir, nav.file)
        if (!existsSync(p)) errors.push(`missing baked file ${nav.file}`)
        else if (statSync(p).size !== nav.bytes) errors.push(`baked file ${nav.file} size differs from manifest (${statSync(p).size} != ${nav.bytes}): re-run bake`)
        info["navmesh"] = { polygons: nav.polygons, components: nav.components, largestComponentShare: nav.largestComponentShare }
      }
      info["baked"] = { semanticsVersion: baked.semanticsVersion, placeholder: baked.placeholder }
      if (baked.placeholder) warnings.push("baked channels were computed with placeholder semantics")
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }
  return { ok: errors.length === 0, errors, warnings, info }
}
