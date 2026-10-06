import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { Manifest, decodeVersioned } from "@deadlock-query/contracts"
import { Document, Logger, NodeIO } from "@gltf-transform/core"
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions"
import { cloneDocument, meshopt, prune, simplify, weld } from "@gltf-transform/functions"
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer"

/**
 * M3: turns the lite render tiles into streamable tiles. Every tile `<id>` gets a compressed LOD0 (same file, rewritten
 * with EXT_meshopt_compression + KHR_mesh_quantization) and simplified LODs written as `<id>.lod<n>.glb`.
 * LOD tiles share the base tile's bounds and appear in the manifest as separate tiles with id `<id>#lod<n>`
 * (contracts' `Tile` has no `lod` field yet; see STATE.md "Blockers / Requests").
 */

export const TILE_BUDGET_BYTES = 20 * 1024 * 1024

export interface TileOptions {
  /** Total LODs per tile including LOD0 (default 2). */
  readonly lods?: number
  /** Triangle fraction kept by each next LOD relative to the previous one (default 0.25). */
  readonly lodRatio?: number
  /** Simplifier error bound relative to the mesh extent (default 0.02). */
  readonly lodError?: number
  /** Keep material textures (embedded in the GLB). The lite tier is untextured by default (PLAN §5.9). */
  readonly keepTextures?: boolean
  /** Per-tile byte budget (default 20 MB). */
  readonly maxTileBytes?: number
  readonly log?: ((m: string) => void) | undefined
}

export interface TileReportEntry { readonly id: string; readonly file: string; readonly lod: number; readonly bytes: number; readonly triangles: number }
export interface TileReport {
  readonly ok: boolean
  readonly dir: string
  readonly errors: string[]
  readonly warnings: string[]
  readonly tiles: TileReportEntry[]
  readonly largestTileBytes: number
  readonly bytesBefore: number
  readonly bytesAfter: number
  readonly removedTextureBytes: number
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

const triangleCount = (doc: Document): number =>
  doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() ?? p.getAttribute("POSITION")?.getCount() ?? 0) / 3, 0), 0)

/** Whether a tile id is an LOD entry produced by this stage. */
export const isLodTile = (id: string) => id.includes("#lod")
export const lodId = (id: string, lod: number) => (lod === 0 ? id : `${id}#lod${lod}`)
export const lodFile = (file: string, lod: number) => (lod === 0 ? file : file.replace(/\.glb$/, `.lod${lod}.glb`))

const imageUris = (doc: Document): string[] =>
  doc.getRoot().listTextures().map((t) => t.getURI()).filter((u) => u && !u.startsWith("data:"))

const removeEmptyDirs = (dir: string, stop: string) => {
  for (let d = dir; d.startsWith(stop) && d !== stop; d = dirname(d)) {
    try { if (readdirSync(d).length === 0) rmdirSync(d); else return } catch { return }
  }
}

/** Compress (and optionally simplify) the tiles of a lite bundle in place, rewriting `manifest.json`. */
export const tileBundle = async (dir: string, opts: TileOptions = {}): Promise<TileReport> => {
  const lods = Math.max(1, opts.lods ?? 2)
  const ratio = opts.lodRatio ?? 0.25
  const maxBytes = opts.maxTileBytes ?? TILE_BUDGET_BYTES
  const errors: string[] = [], warnings: string[] = []
  const entries: TileReportEntry[] = []
  const empty: TileReport = { ok: false, dir, errors, warnings, tiles: entries, largestTileBytes: 0, bytesBefore: 0, bytesAfter: 0, removedTextureBytes: 0 }

  const manifestPath = join(dir, "manifest.json")
  if (!existsSync(manifestPath)) return { ...empty, errors: ["manifest.json not found"] }
  let manifest: Manifest
  try {
    manifest = await Effect.runPromise(decodeVersioned(Manifest, 1)(JSON.parse(readFileSync(manifestPath, "utf8"))))
  } catch (e) {
    return { ...empty, errors: [`manifest validation failed: ${e instanceof Error ? e.message : String(e)}`] }
  }
  if (manifest.tier !== "lite") return { ...empty, errors: [`expected tier "lite", got "${manifest.tier}": the full tier is one multi-GB glTF and is not tiled`] }
  if (manifest.tiles.some((t) => isLodTile(t.id))) return { ...empty, errors: ["bundle is already tiled (found #lod entries); re-run `extract --tier lite --force` first"] }
  if (manifest.tiles.some((t) => !t.file.endsWith(".glb"))) return { ...empty, errors: ["only .glb render tiles can be compressed"] }

  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready])
  const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ "meshopt.encoder": MeshoptEncoder })

  const outTiles: Manifest["tiles"][number][] = []
  let bytesBefore = 0, bytesAfter = 0, removedTextureBytes = 0
  const staleTextures = new Set<string>()

  for (const tile of manifest.tiles) {
    const path = join(dir, tile.file)
    bytesBefore += statSync(path).size
    const source = await io.read(path)
    for (const u of imageUris(source)) staleTextures.add(join(dirname(path), decodeURIComponent(u)))
    if (!opts.keepTextures) source.getRoot().listTextures().forEach((t) => t.dispose())
    source.setLogger(new Logger(Logger.Verbosity.WARN))
    await source.transform(weld())
    for (let lod = 0; lod < lods; lod++) {
      const doc = cloneDocument(source).setLogger(new Logger(Logger.Verbosity.WARN))
      await doc.transform(
        ...(lod > 0 ? [simplify({ simplifier: MeshoptSimplifier, ratio: ratio ** lod, error: opts.lodError ?? 0.02 })] : []),
        prune({ keepAttributes: true }),
        meshopt({ encoder: MeshoptEncoder, level: "high" })
      )
      const bin = await io.writeBinary(doc)
      const file = lodFile(tile.file, lod)
      writeFileSync(join(dir, file), bin)
      const tris = triangleCount(doc)
      outTiles.push({
        id: lodId(tile.id, lod), bounds: tile.bounds, file, bytes: bin.length, sha256: sha256(bin),
        ...(tile.materials ? { materials: tile.materials } : {})
      })
      entries.push({ id: lodId(tile.id, lod), file, lod, bytes: bin.length, triangles: tris })
      if (bin.length > maxBytes) errors.push(`tile ${lodId(tile.id, lod)} is ${(bin.length / 1048576).toFixed(1)} MB, over the ${(maxBytes / 1048576).toFixed(0)} MB budget`)
      bytesAfter += bin.length
      opts.log?.(`${lodId(tile.id, lod)}: ${(bin.length / 1024).toFixed(0)} KB, ${tris} triangles`)
    }
  }

  if (!opts.keepTextures) {
    for (const f of staleTextures) {
      if (!existsSync(f)) continue
      removedTextureBytes += statSync(f).size
      rmSync(f)
      removeEmptyDirs(dirname(f), dir)
    }
    if (removedTextureBytes) warnings.push(`removed ${(removedTextureBytes / 1048576).toFixed(1)} MB of texture files (lite tier is untextured)`)
  }

  writeFileSync(manifestPath, JSON.stringify({ ...manifest, tiles: outTiles }, null, 2) + "\n")
  return { ok: errors.length === 0, dir, errors, warnings, tiles: entries, largestTileBytes: Math.max(0, ...entries.map((e) => e.bytes)), bytesBefore, bytesAfter, removedTextureBytes }
}
