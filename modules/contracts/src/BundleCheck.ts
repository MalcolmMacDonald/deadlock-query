import { tileBaseId, tileLod, type Manifest } from "./MapBundle.ts"

/** Reads files relative to the bundle directory. `size` is undefined when the file is missing; `sha256` is lazy because hashing is slow. */
export interface BundleFiles {
  readonly size: (file: string) => number | undefined
  readonly sha256: (file: string) => string
}

export interface BundleCheck {
  readonly errors: string[]
  readonly warnings: string[]
}

const sameBounds = (a: Manifest["bounds"], b: Manifest["bounds"]) =>
  a.min.every((v, i) => v === b.min[i]) && a.max.every((v, i) => v === b.max[i])

/**
 * Structural checks on tiles and LODs: ids are unique, every LOD tile points at a LOD0 tile with the same bounds, LOD
 * numbers are consistent between the `lod`/`lodOf` fields and the `#lod<n>` id convention, and each LOD0 tile has every
 * level from 1 to the maximum (a gap means a streaming viewer would have nothing to switch to).
 */
export const checkTiles = (manifest: Pick<Manifest, "tiles">): BundleCheck => {
  const errors: string[] = []
  const warnings: string[] = []
  const byId = new Map<string, Manifest["tiles"][number]>()
  for (const t of manifest.tiles) {
    if (byId.has(t.id)) errors.push(`duplicate tile id ${t.id}`)
    byId.set(t.id, t)
  }
  const levels = new Map<string, Set<number>>()
  for (const t of manifest.tiles) {
    const lod = tileLod(t)
    const base = tileBaseId(t)
    if (t.lod !== undefined && /#lod\d+$/.test(t.id) && t.lod !== tileLod({ id: t.id })) {
      errors.push(`tile ${t.id}: lod ${t.lod} disagrees with the id suffix`)
    }
    if (lod === 0) {
      if (t.lodOf !== undefined) errors.push(`tile ${t.id}: lodOf is set on a LOD0 tile`)
      if (!levels.has(t.id)) levels.set(t.id, new Set())
      continue
    }
    const b = byId.get(base)
    if (!b) { errors.push(`tile ${t.id}: LOD base tile ${base} not found`); continue }
    if (tileLod(b) !== 0) errors.push(`tile ${t.id}: LOD base ${base} is itself LOD ${tileLod(b)}`)
    if (!sameBounds(t.bounds, b.bounds)) errors.push(`tile ${t.id}: bounds differ from its base tile ${base}`)
    const seen = levels.get(base) ?? new Set<number>()
    if (seen.has(lod)) errors.push(`tile ${base}: LOD ${lod} appears more than once`)
    seen.add(lod)
    levels.set(base, seen)
  }
  for (const [base, seen] of levels) {
    const max = Math.max(0, ...seen)
    for (let l = 1; l <= max; l++) if (!seen.has(l)) warnings.push(`tile ${base}: LOD ${l} missing (has up to LOD ${max})`)
  }
  const counts = new Set([...levels.values()].map((s) => s.size))
  if (counts.size > 1) warnings.push(`LOD0 tiles have differing LOD counts (${[...counts].sort().join(", ")})`)
  return { errors, warnings }
}

/**
 * File checks for every file the manifest references: tiles, collision, entities and baked data. A file must exist and
 * match its recorded byte length; when the manifest records a `sha256` it must match too. Baked grid and navmesh are
 * also checked for internal consistency (channel list, cell counts, polygon counts).
 */
export const checkFiles = (manifest: Manifest, files: BundleFiles, opts: { readonly hash?: boolean } = {}): BundleCheck => {
  const errors: string[] = []
  const warnings: string[] = []
  const hash = opts.hash ?? true
  const verify = (what: string, file: string, bytes?: number, sha?: string) => {
    const size = files.size(file)
    if (size === undefined) { errors.push(`missing ${what} file ${file}`); return }
    if (bytes !== undefined && size !== bytes) errors.push(`${what} ${file}: ${size} bytes on disk, manifest says ${bytes}`)
    else if (hash && sha !== undefined && files.sha256(file) !== sha) errors.push(`${what} ${file}: sha256 does not match the manifest`)
  }
  for (const t of manifest.tiles) verify("tile", t.file, t.bytes, t.sha256)
  if (manifest.collision) verify("collision", manifest.collision.file)
  verify("entities", manifest.entitiesFile)
  const baked = manifest.baked
  if (baked) {
    verify("baked bvh", baked.bvh.file, baked.bvh.bytes, baked.bvh.sha256)
    verify("baked sample grid", baked.sampleGrid.file, baked.sampleGrid.bytes, baked.sampleGrid.sha256)
    if (baked.navmesh) verify("baked navmesh", baked.navmesh.file, baked.navmesh.bytes, baked.navmesh.sha256)
    const g = baked.sampleGrid
    if (g.nx <= 0 || g.ny <= 0 || g.cellSize <= 0) errors.push(`sample grid has non-positive dimensions (${g.nx} x ${g.ny} cells of ${g.cellSize})`)
    if (g.channels.length === 0) errors.push("sample grid lists no channels")
    if (!g.channels.includes("floorHeight")) errors.push("sample grid has no floorHeight channel")
    if (new Set(g.channels).size !== g.channels.length) errors.push("sample grid channel names are not unique")
    if (baked.bvh.triangles <= 0) errors.push("baked bvh has no triangles")
    if (baked.navmesh && baked.navmesh.polygons <= 0) errors.push("baked navmesh has no polygons")
    if (baked.placeholder) warnings.push("baked data was built with placeholder semantics: interior/wallDistance are provisional")
    if (!baked.navmesh) warnings.push("manifest.baked has no navmesh (navmesh stage not run)")
    if (!manifest.collision) errors.push("manifest.baked is present but the manifest has no collision reference")
  }
  return { errors, warnings }
}
