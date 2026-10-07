import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { Manifest, decodeVersioned, type Aabb, type Mat4 } from "@deadlock-query/contracts"
import { NodeIO } from "@gltf-transform/core"
import {
  DEFAULT_PARAMS, PLACEHOLDER_SEMANTICS, Raycaster, SampleGrid, isInterior, nearestWall,
  type ChannelSpec, type SemanticsParams
} from "@deadlock-query/spatial-core"
import { mulMat4 } from "./mat4.ts"
import { WALKABLE_NAV_FILE, loadWalkable, triangulate, type WalkableStats } from "./walkable.ts"

/**
 * M4: bakes derived spatial data next to a bundle's manifest.
 *   baked/collision.bvh      spatial-core `Raycaster.serialize()` over the collision GLB, in Source units
 *   baked/sample-grid.bin    spatial-core `SampleGrid.serialize()`: `floorHeight` + the semantics channels
 * `floorHeight` comes from the walkable surface (the game's nav faces, `collision/walkable.nav`) when the bundle has one, because
 * `world_physics` holds only clip volumes: its topmost surface is a clip lid, not the ground. The semantics channels still ray-cast the
 * collision BVH, starting from that floor.
 * The manifest gets a `baked` record (files, sha256, cell size, semanticsVersion, placeholder flag, cache key).
 */

export const BAKE_VERSION = "1.1.0"
/** Layers that must not become solid world geometry: the sky box would make every point "interior". */
export const DEFAULT_EXCLUDE_LAYERS: ReadonlyArray<string> = ["sky", "Citadel_Skyclip"]
export const DEFAULT_CELL_SIZE = 64
/** Walkable surfaces closer than this in z count as one level when looking for multi-level cells. */
const WALKABLE_LEVEL_GAP = 48

/** Extra channels (nav-sourced floors only): the walkable levels of a cell beyond the topmost one `floorHeight` holds. */
export const FLOOR_LEVELS_CHANNEL = "floorLevels"
export const FLOOR_LOWER_CHANNEL = "floorHeightLower"

/** Distinct walkable levels at (x, y), top first: surfaces closer than `gap` to the previous level are merged into it. */
export const walkableLevels = (rc: Raycaster, x: number, y: number, top: number, gap: number): number[] => {
  const zs = rc.raycastAll([x, y, top], [0, 0, -1], { backfaces: true }).map((h) => h.point[2]).sort((a, b) => b - a)
  const levels: number[] = []
  for (const z of zs) if (levels.length === 0 || levels[levels.length - 1]! - z > gap) levels.push(z)
  return levels
}

/** Channels written to the sample grid. `floorHeight` is built in; the rest call the owner-authored semantics. */
export const INTERIOR_CHANNEL = "interior"
export const WALL_DISTANCE_CHANNEL = "wallDistance"

export interface BakeOptions {
  /** World units per grid cell (default 64). */
  readonly cellSize?: number
  /** Collision layers (glTF `InteractAs`) left out of the BVH. A node is dropped when any of its layers is excluded. */
  readonly excludeLayers?: ReadonlyArray<string>
  readonly params?: Partial<SemanticsParams>
  /** `auto` (default): the walkable nav faces when the bundle has them, else the topmost collision surface. */
  readonly floorSource?: "auto" | "game-nav" | "collision"
  readonly force?: boolean
  readonly log?: ((m: string) => void) | undefined
}

export interface BakedFile { readonly file: string; readonly bytes: number; readonly sha256: string }
export interface BakedRecord {
  readonly bakeVersion: string
  /** Hash of the semantics sources (+ params) the channels were computed with; re-bake when it changes. */
  readonly semanticsVersion: string
  /** True while spatial-core's semantics are unreviewed placeholders: channel values are provisional. */
  readonly placeholder: boolean
  /** Everything the output depends on; equal key + files present = nothing to do. */
  readonly inputKey: string
  /** Raw-only extras (not in the contracts schema yet). Absent on older bakes (= collision). */
  readonly floorSource?: "game-nav" | "collision"
  readonly walkable?: WalkableStats & { readonly file: string; readonly sha256: string; readonly triangles: number; readonly coveredCells: number; readonly totalCells: number; readonly multiLevelCells: number }
  readonly bvh: BakedFile & { readonly triangles: number; readonly vertices: number; readonly excludedLayers: ReadonlyArray<string>; readonly skippedNodes: number }
  readonly sampleGrid: BakedFile & {
    readonly cellSize: number; readonly nx: number; readonly ny: number
    readonly origin: readonly [number, number]
    readonly channels: ReadonlyArray<string>
    readonly params: SemanticsParams
  }
}

export interface BakeReport {
  readonly ok: boolean
  readonly cached: boolean
  readonly dir: string
  readonly errors: string[]
  readonly warnings: string[]
  readonly baked?: BakedRecord
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

/** Content hash of spatial-core's `semantics/` sources: changes whenever the owner edits the functions or defaults. */
export const semanticsVersion = (params: SemanticsParams): string => {
  const h = createHash("sha256")
  try {
    const dir = join(dirname(fileURLToPath(import.meta.resolve("@deadlock-query/spatial-core"))), "semantics")
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) h.update(f).update(readFileSync(join(dir, f)))
  } catch {
    h.update("sources-unavailable")
  }
  h.update(JSON.stringify(params))
  return h.digest("hex").slice(0, 16)
}

export interface CollisionMesh { readonly positions: Float32Array; readonly indices: Uint32Array; readonly skippedNodes: number }

/**
 * Merges every triangle mesh of a collision GLB into one soup in world (Source) units:
 * `glbToWorld * nodeWorldMatrix * position`. Nodes carrying an excluded `InteractAs` layer are skipped.
 */
export const loadCollisionMesh = async (path: string, glbToWorld: Mat4, exclude: ReadonlyArray<string>): Promise<CollisionMesh> => {
  const doc = await new NodeIO().read(path)
  const skip = new Set(exclude)
  const pos: number[][] = []
  const idx: number[][] = []
  let vertexBase = 0, triangles = 0, skipped = 0
  const v: number[] = [0, 0, 0]
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const layers = (node.getExtras() as { InteractAs?: unknown }).InteractAs
    if (Array.isArray(layers) && layers.some((l) => typeof l === "string" && skip.has(l))) { skipped++; continue }
    const m = mulMat4(glbToWorld, node.getWorldMatrix() as Mat4)
    // A mirroring transform flips triangle winding; keep front faces consistent.
    const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!)
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue
      const p = prim.getAttribute("POSITION")
      if (!p) continue
      const out = new Array<number>(p.getCount() * 3)
      for (let i = 0; i < p.getCount(); i++) {
        p.getElement(i, v)
        out[i * 3] = m[0]! * v[0]! + m[4]! * v[1]! + m[8]! * v[2]! + m[12]!
        out[i * 3 + 1] = m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]!
        out[i * 3 + 2] = m[2]! * v[0]! + m[6]! * v[1]! + m[10]! * v[2]! + m[14]!
      }
      const ia = prim.getIndices()
      const n = ia ? ia.getCount() : p.getCount()
      const tri = new Array<number>(n - (n % 3))
      for (let i = 0; i < tri.length; i += 3) {
        const a = ia ? ia.getScalar(i) : i, b = ia ? ia.getScalar(i + 1) : i + 1, c = ia ? ia.getScalar(i + 2) : i + 2
        tri[i] = vertexBase + a; tri[i + 1] = vertexBase + (det < 0 ? c : b); tri[i + 2] = vertexBase + (det < 0 ? b : c)
      }
      pos.push(out); idx.push(tri)
      vertexBase += p.getCount(); triangles += tri.length / 3
    }
  }
  const positions = new Float32Array(vertexBase * 3)
  let o = 0
  for (const a of pos) { positions.set(a, o); o += a.length }
  const indices = new Uint32Array(triangles * 3)
  o = 0
  for (const a of idx) { indices.set(a, o); o += a.length }
  return { positions, indices, skippedNodes: skipped }
}

/** Channel generators wiring the owner-authored semantics into the grid (`cell.floorZ` is NaN where nothing is below). */
export const semanticsChannels = (params: Partial<SemanticsParams>, maxRange: number, collision?: Raycaster): Record<string, ChannelSpec> => ({
  [INTERIOR_CHANNEL]: {
    type: "u8",
    gen: (c) => (Number.isNaN(c.floorZ) ? 0 : isInterior(collision ?? c.rc, [c.x, c.y, c.floorZ], params) ? 1 : 0)
  },
  [WALL_DISTANCE_CHANNEL]: {
    type: "f32",
    // Saturates at `maxRange` when no wall is in range; NaN where there is no floor to sample from.
    gen: (c) => (Number.isNaN(c.floorZ) ? NaN : (nearestWall(collision ?? c.rc, [c.x, c.y, c.floorZ], params)?.distance ?? maxRange))
  }
})

const inputKey = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)

export const bakeBundle = async (dir: string, o: BakeOptions = {}): Promise<BakeReport> => {
  const errors: string[] = [], warnings: string[] = []
  const fail = (e: string): BakeReport => ({ ok: false, cached: false, dir, errors: [...errors, e], warnings })
  let manifest: Manifest
  try {
    manifest = await Effect.runPromise(decodeVersioned(Manifest, 1)(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))))
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  if (!manifest.collision) return fail("manifest has no collision reference: nothing to bake (run extract first)")
  const collisionPath = join(dir, manifest.collision.file)
  if (!existsSync(collisionPath)) return fail(`missing collision file ${manifest.collision.file}`)
  const cellSize = o.cellSize ?? DEFAULT_CELL_SIZE
  if (!(cellSize > 0)) return fail("--cell-size must be > 0")
  const exclude = [...(o.excludeLayers ?? DEFAULT_EXCLUDE_LAYERS)].sort()
  const params: SemanticsParams = { ...DEFAULT_PARAMS, ...o.params }
  const semVersion = semanticsVersion(params)
  const walkablePath = join(dir, WALKABLE_NAV_FILE)
  const floorSource = o.floorSource ?? "auto"
  if (floorSource === "game-nav" && !existsSync(walkablePath)) return fail(`no walkable nav file at ${WALKABLE_NAV_FILE}: re-run extract on a map that ships a .nav`)
  const useNav = floorSource !== "collision" && existsSync(walkablePath)
  const key = inputKey({
    bake: BAKE_VERSION, collision: sha256(readFileSync(collisionPath)), glbToWorld: manifest.collision.glbToWorld,
    exclude, cellSize, semVersion, placeholder: PLACEHOLDER_SEMANTICS,
    floor: useNav ? sha256(readFileSync(walkablePath)) : "collision"
  })

  const prev = manifest.baked as Partial<BakedRecord> | undefined
  const bvhPath = join(dir, "baked", "collision.bvh"), gridPath = join(dir, "baked", "sample-grid.bin")
  if (!o.force && prev?.inputKey === key && existsSync(bvhPath) && existsSync(gridPath)) {
    o.log?.("bake: cached")
    return { ok: true, cached: true, dir, errors, warnings, baked: prev as BakedRecord }
  }

  o.log?.("bake: loading collision")
  const mesh = await loadCollisionMesh(collisionPath, manifest.collision.glbToWorld as Mat4, exclude)
  if (mesh.indices.length === 0) return fail(`no collision triangles left after excluding layers ${exclude.join(", ") || "(none)"}`)
  o.log?.(`bake: ${mesh.indices.length / 3} triangles${mesh.skippedNodes ? ` (${mesh.skippedNodes} nodes excluded by layer)` : ""}, building BVH`)
  const rc = Raycaster.fromGeometry(mesh.positions, mesh.indices)
  const bvhBytes = new Uint8Array(rc.serialize())

  // Snap XY to multiples of the cell size: the BVH bounds carry a tiny epsilon, and world-aligned cells keep grids
  // comparable across game builds and cell sizes.
  const snap = (v: number, f: (n: number) => number) => f(v / cellSize) * cellSize
  let floorRc = rc
  let walkable: BakedRecord["walkable"]
  let walkSoupStats: { stats: WalkableStats; triangles: number } | undefined
  if (useNav) {
    o.log?.("bake: loading the walkable nav faces for the floor")
    try {
      const w = loadWalkable(walkablePath)
      const tri = triangulate(w.soup)
      floorRc = Raycaster.fromGeometry(tri.positions, tri.indices)
      walkSoupStats = { stats: w.stats, triangles: tri.indices.length / 3 }
    } catch (e) {
      return fail(`cannot read ${WALKABLE_NAV_FILE}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const bounds: Aabb = {
    min: [snap(floorRc.bounds.min[0], Math.floor), snap(floorRc.bounds.min[1], Math.floor), floorRc.bounds.min[2]],
    max: [snap(floorRc.bounds.max[0], Math.ceil), snap(floorRc.bounds.max[1], Math.ceil), floorRc.bounds.max[2]]
  }
  let lastPct = -1
  const levelChannels: Record<string, ChannelSpec> = useNav ? {
    [FLOOR_LEVELS_CHANNEL]: { type: "u8", gen: (c) => Math.min(255, walkableLevels(floorRc, c.x, c.y, bounds.max[2] + 1, WALKABLE_LEVEL_GAP).length) },
    // The level just under the topmost one (NaN where the cell has a single level), so a query can reach floors under bridges and roofs.
    [FLOOR_LOWER_CHANNEL]: { type: "f32", gen: (c) => walkableLevels(floorRc, c.x, c.y, bounds.max[2] + 1, WALKABLE_LEVEL_GAP)[1] ?? NaN }
  } : {}
  const grid = SampleGrid.build(floorRc, bounds, cellSize, { ...semanticsChannels(params, params.maxRange, rc), ...levelChannels }, {
    onProgress: (done, total) => {
      const pct = Math.floor((done / total) * 10) * 10
      if (pct !== lastPct) { lastPct = pct; o.log?.(`bake: sample grid ${pct}%`) }
    }
  })
  const gridBytes = new Uint8Array(grid.serialize())
  const floor = grid.raw("floorHeight") as Float32Array
  const covered = floor.reduce((n, h) => (Number.isNaN(h) ? n : n + 1), 0)
  if (covered === 0) warnings.push("sample grid has no floor hits: collision may be in the wrong frame")
  else o.log?.(`bake: ${covered}/${floor.length} cells have a floor (${useNav ? "walkable nav faces" : "topmost collision surface"})`)
  if (useNav && walkSoupStats) {
    // `floorHeight` is the topmost walkable surface; the other levels live in `floorLevels` / `floorHeightLower`.
    const levels = grid.raw(FLOOR_LEVELS_CHANNEL) as Uint8Array
    let multi = 0
    for (const n of levels) if (n > 1) multi++
    walkable = { ...walkSoupStats.stats, file: WALKABLE_NAV_FILE, sha256: sha256(readFileSync(walkablePath)), triangles: walkSoupStats.triangles, coveredCells: covered, totalCells: floor.length, multiLevelCells: multi }
    if (multi > 0) warnings.push(`${multi} of ${covered} floor cells have walkable surfaces on more than one level; floorHeight keeps the topmost, floorHeightLower holds the next level down`)
  }
  if (PLACEHOLDER_SEMANTICS) warnings.push("semantics are placeholders: interior/wallDistance channels are provisional until the owner finalises spatial-core/semantics")

  mkdirSync(join(dir, "baked"), { recursive: true })
  writeFileSync(bvhPath, bvhBytes)
  writeFileSync(gridPath, gridBytes)
  const baked: BakedRecord = {
    bakeVersion: BAKE_VERSION,
    semanticsVersion: semVersion,
    placeholder: PLACEHOLDER_SEMANTICS,
    inputKey: key,
    floorSource: useNav ? "game-nav" : "collision",
    ...(walkable ? { walkable } : {}),
    bvh: {
      file: "baked/collision.bvh", bytes: bvhBytes.length, sha256: sha256(bvhBytes),
      triangles: mesh.indices.length / 3, vertices: mesh.positions.length / 3, excludedLayers: exclude, skippedNodes: mesh.skippedNodes
    },
    sampleGrid: {
      file: "baked/sample-grid.bin", bytes: gridBytes.length, sha256: sha256(gridBytes),
      cellSize, nx: grid.nx, ny: grid.ny, origin: grid.origin, channels: grid.channelNames, params
    }
  }
  // Rewrite the manifest as raw JSON so unrelated fields round-trip untouched.
  const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>
  // The navmesh stage (`bakeNavmesh`) owns `baked.navmesh`; keep it across a collision/grid re-bake (it re-keys itself).
  const prevNavmesh = (raw["baked"] as { navmesh?: unknown } | undefined)?.navmesh
  raw["baked"] = prevNavmesh ? { ...baked, navmesh: prevNavmesh } : baked
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(raw, null, 2) + "\n")
  return { ok: true, cached: false, dir, errors, warnings, baked }
}
