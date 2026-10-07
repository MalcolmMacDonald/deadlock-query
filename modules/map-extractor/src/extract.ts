import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { SCHEMA_VERSION, type Aabb, type EntitiesFile, type Manifest, type Mat4, IDENTITY_MAT4, transformPoint } from "@deadlock-query/contracts"
import { ExportFailed } from "./errors.ts"
import { gltfInfo, readGltfJson, type GltfInfo } from "./gltfInfo.ts"
import { invertAffine } from "./mat4.ts"
import { args, firstExceptionLine, lastRunOutput, run, type S2VRunner } from "./s2v.ts"
import { buildLiteTiles, liteReady, type LiteOptions } from "./liteRender.ts"
import { toEntities, parseVents } from "./vents.ts"
import { WALKABLE_FLOW_FILE, WALKABLE_NAV_FILE } from "./walkable.ts"

/** Unchanged by the `nav` stage on purpose: adding it must not invalidate the cached multi-GB render stages. */
export const EXTRACTOR_VERSION = "0.4.0"
export type Tier = "full" | "lite"

export interface ExtractOptions {
  readonly vpk: string
  readonly map: string
  readonly buildId: string
  readonly s2vVersion: string
  readonly tier: Tier
  readonly outRoot: string // data/bundles
  readonly runner: S2VRunner
  readonly force?: boolean
  /** Lite tier: triangle/tile budgets for the reduced render. */
  readonly lite?: LiteOptions
  /** Lite tier: keep the multi-GB full render export in `.work` after deriving the lite tiles. */
  readonly keepWork?: boolean
  /** Pass `--gltf_export_materials` to the render export (off by default; see `args.render`). */
  readonly materials?: boolean
  readonly log?: (msg: string) => void
}

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex")
const stageKey = (o: ExtractOptions, stage: string) => `${o.buildId}|${stage}|${o.s2vVersion}|${EXTRACTOR_VERSION}|${o.map}`

/** Idempotent stage: skipped when its stamp matches and all outputs exist. */
const stage = async (o: ExtractOptions, dir: string, name: string, outputs: string[], fn: () => Promise<void>): Promise<void> => {
  const stamp = join(dir, `.stage-${name}`)
  const key = stageKey(o, name)
  if (!o.force && existsSync(stamp) && readFileSync(stamp, "utf8") === key && outputs.every(existsSync)) {
    o.log?.(`${name}: cached`)
    return
  }
  o.log?.(`${name}: running`)
  await fn()
  const missing = outputs.filter((f) => !existsSync(f))
  if (missing.length) {
    const last = lastRunOutput.get(name)
    const cause = last && firstExceptionLine(last)
    throw new ExportFailed({ stage: name, stderr: `expected output missing: ${missing.map((m) => basename(m)).join(", ")}${cause ? `; tool reported: ${cause} (check free disk space)` : ""}` })
  }
  writeFileSync(stamp, key)
}

/** Exact `<dir>/*_physics.glb` the CLI writes next to the requested output (S2: `phys.glb` is an empty stub). */
const findPhysicsGlb = (dir: string): string | undefined => {
  const f = readdirSync(dir).filter((n) => n.endsWith("_physics.glb")).sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size)[0]
  return f && join(dir, f)
}

/** A file the CLI exported: `out` itself when it is a file, else `name` anywhere below the folder `out`. */
const findExported = (out: string, name: string): string | undefined => {
  if (!existsSync(out)) return undefined
  if (statSync(out).isFile()) return basename(out) === name || name.endsWith(".nav") ? out : undefined
  return readdirSync(out, { recursive: true, withFileTypes: true }).find((e) => e.isFile() && e.name === name)
    ?.parentPath.concat("/", name)
}

const unionAabb = (a: Aabb | undefined, b: Aabb | undefined): Aabb | undefined =>
  !a ? b : !b ? a : { min: a.min.map((v, i) => Math.min(v, b.min[i]!)) as unknown as Aabb["min"], max: a.max.map((v, i) => Math.max(v, b.max[i]!)) as unknown as Aabb["max"] }

/** Bounds of a file in world space, applying `glbToWorld` to its loaded-space bounds. */
export const worldBounds = (info: GltfInfo, glbToWorld: Mat4): Aabb | undefined => {
  const b = info.loadedBounds
  if (!b) return undefined
  let out: Aabb | undefined
  for (let c = 0; c < 8; c++) {
    const p = transformPoint(glbToWorld, [c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]])
    out = unionAabb(out, { min: p, max: p })
  }
  return out
}

/**
 * Per-file `glbToWorld`: a file whose nodes all share a non-identity matrix M gets M^-1, so loader-applied
 * node matrices are undone and positions land in Source units. Otherwise the file is assumed already in Source units.
 */
export const fileGlbToWorld = (info: GltfInfo): { matrix: Mat4; note?: string } => {
  const [first, ...rest] = info.nodeMatrices
  if (!first) return { matrix: IDENTITY_MAT4 }
  return { matrix: invertAffine(first.matrix), ...(rest.length ? { note: `${rest.length + 1} distinct node matrices; used the most common (${first.count} nodes)` } : {}) }
}

export interface ExtractResult { readonly dir: string; readonly manifest: Manifest; readonly warnings: string[] }

export const extract = async (o: ExtractOptions): Promise<ExtractResult> => {
  const dir = join(o.outRoot, o.buildId, o.tier)
  const work = join(dir, ".work")
  mkdirSync(join(dir, "collision"), { recursive: true })
  mkdirSync(join(dir, "render"), { recursive: true })
  mkdirSync(work, { recursive: true })
  // Bundles are game-derived and huge: keep them out of git without a root .gitignore change (module-scope rule).
  const ignore = join(o.outRoot, ".gitignore")
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n")
  const warnings: string[] = []

  const entitiesRaw = join(work, "default_ents.vents")
  await stage(o, dir, "entities", [entitiesRaw], async () => { await run(o.runner, "entities", args.entities(o.vpk, o.map, entitiesRaw)) })

  const physOut = join(dir, "collision", "physics.glb")
  await stage(o, dir, "collision", [physOut], async () => {
    const tmp = join(work, "phys")
    rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true })
    await run(o.runner, "collision", args.collision(o.vpk, o.map, join(tmp, "phys")))
    const found = findPhysicsGlb(tmp)
    if (!found) throw new ExportFailed({ stage: "collision", stderr: "no *_physics.glb written" })
    copyFileSync(found, physOut)
  })

  // The game's own nav faces are the walkable surface (world_physics holds only clip volumes); bake reads them from the bundle.
  const navOut = join(dir, WALKABLE_NAV_FILE), flowOut = join(dir, WALKABLE_FLOW_FILE)
  try {
    await stage(o, dir, "nav", [navOut], async () => {
      const tmp = join(work, "nav")
      rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true })
      await run(o.runner, "nav", args.nav(o.vpk, o.map, join(tmp, `${o.map}.nav`)))
      const nav = findExported(join(tmp, `${o.map}.nav`), `${o.map}.nav`)
      if (nav) copyFileSync(nav, navOut)
      rmSync(flowOut, { force: true })
      const flow = findExported(join(tmp, `${o.map}.nav`), `${o.map}.navflowmap`)
      if (flow && flow !== nav) copyFileSync(flow, flowOut)
      rmSync(tmp, { recursive: true, force: true })
    })
  } catch (e) {
    if (!(e instanceof ExportFailed)) throw e
    warnings.push(`nav: no walkable nav file exported (${e.stderr}); bake will fall back to the collision surface`)
  }

  const tiles: Manifest["tiles"][number][] = []
  let renderInfo: GltfInfo | undefined
  let renderMatrix: Mat4 = IDENTITY_MAT4
  if (o.tier === "full") {
    const gltf = join(dir, "render", "n0.gltf")
    await stage(o, dir, "render", [gltf], async () => {
      for (const f of readdirSync(join(dir, "render"))) rmSync(join(dir, "render", f), { recursive: true, force: true })
      await run(o.runner, "render", args.render(o.vpk, o.map, gltf, o.materials))
    })
    renderInfo = gltfInfo(readGltfJson(gltf))
    // Render nodes carry per-instance placement matrices (thousands of distinct ones, near-identity rotation) in the same
    // loaded frame as the physics GLB (metres, Y-up; confirmed on the full dl_midtown render), so the render shares the
    // physics file's glbToWorld instead of inverting its own most common node matrix.
    renderMatrix = fileGlbToWorld(gltfInfo(readGltfJson(physOut))).matrix
    // Everything the export wrote (gltf, bins, material textures) counts toward the tile size.
    const bytes = readdirSync(join(dir, "render"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0)
    tiles.push({
      id: "n0", bounds: worldBounds(renderInfo, renderMatrix) ?? { min: [0, 0, 0], max: [0, 0, 0] },
      file: "render/n0.gltf", bytes, sha256: sha256(gltf), materials: renderInfo.materials
    })
  } else {
    // The lite render is derived from a full export of the world node (cached in .work), then reduced.
    const fullGltf = join(work, "render-full", "n0.gltf")
    const liteDir = join(dir, "render")
    const manifestTiles = join(work, "lite-tiles.json")
    const liteKey = `render-lite-${createHash("sha256").update(JSON.stringify({ ...o.lite, log: undefined, materials: o.materials === true })).digest("hex").slice(0, 8)}`
    await stage(o, dir, liteKey, [manifestTiles], async () => {
      if (o.force || !existsSync(fullGltf)) {
        rmSync(join(work, "render-full"), { recursive: true, force: true }); mkdirSync(join(work, "render-full"), { recursive: true })
        await run(o.runner, "render", args.render(o.vpk, o.map, fullGltf, o.materials))
      }
      for (const f of readdirSync(liteDir)) rmSync(join(liteDir, f), { recursive: true, force: true })
      await liteReady
      const r = buildLiteTiles(fullGltf, liteDir, { ...o.lite, log: o.log })
      warnings.push(...r.warnings.map((w) => `lite render: ${w}`))
      writeFileSync(manifestTiles, JSON.stringify({ tiles: r.tiles, keptTriangles: r.keptTriangles, totalTriangles: r.totalTriangles, textureBytes: r.textureBytes }))
    })
    const built = JSON.parse(readFileSync(manifestTiles, "utf8")) as { tiles: Array<{ id: string; file: string; bounds: Aabb; bytes: number; sha256: string; materials: string[] }>; keptTriangles: number; totalTriangles: number; textureBytes: number }
    renderMatrix = fileGlbToWorld(gltfInfo(readGltfJson(physOut))).matrix
    for (const t of built.tiles) tiles.push({ id: t.id, bounds: worldBounds({ loadedBounds: t.bounds } as GltfInfo, renderMatrix) ?? t.bounds, file: `render/${t.file}`, bytes: t.bytes, sha256: t.sha256, materials: t.materials })
    warnings.push(`lite render: ${built.keptTriangles}/${built.totalTriangles} triangles in ${built.tiles.length} tiles; textures ${(built.textureBytes / 1048576).toFixed(1)} MB (copied unmodified)`)
    if (!o.keepWork) rmSync(join(work, "render-full"), { recursive: true, force: true })
  }

  const physInfo = gltfInfo(readGltfJson(physOut))
  const pm = fileGlbToWorld(physInfo)
  if (pm.note) warnings.push(`collision: ${pm.note}`)
  const collisionBounds = worldBounds(physInfo, pm.matrix)

  const entities = toEntities(parseVents(readFileSync(entitiesRaw, "utf8")))
  const entitiesFile: EntitiesFile = { schemaVersion: SCHEMA_VERSION, entities }
  writeFileSync(join(dir, "entities.json"), JSON.stringify(entitiesFile))

  const bounds = unionAabb(collisionBounds, tiles[0]?.bounds) ?? { min: [0, 0, 0] as const, max: [0, 0, 0] as const }
  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    gameBuildId: o.buildId,
    mapName: o.map,
    tier: o.tier,
    coordinateSystem: { up: "Z", unit: "source", glbToWorld: renderMatrix },
    bounds,
    tiles,
    collision: { file: "collision/physics.glb", format: "glb", glbToWorld: pm.matrix, layers: [...physInfo.layers] },
    entitiesFile: "entities.json",
    provenance: { extractorVersion: EXTRACTOR_VERSION, s2vVersion: o.s2vVersion }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  return { dir, manifest, warnings }
}
