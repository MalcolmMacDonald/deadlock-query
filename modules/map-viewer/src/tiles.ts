import * as THREE from "three"
import type { Manifest, Vec3 } from "@deadlock-query/contracts"

/** A manifest tile. `lod` is read when contracts adds it (M3); until then the `<id>#lod<n>` id convention applies. */
export type ManifestTile = Manifest["tiles"][number] & { readonly lod?: number }

export const parseTileId = (id: string): { readonly base: string; readonly lod: number } => {
  const m = /^(.*)#lod(\d+)$/.exec(id)
  return m ? { base: m[1]!, lod: Number(m[2]) } : { base: id, lod: 0 }
}

export const tileLod = (t: ManifestTile): number => (typeof t.lod === "number" ? t.lod : parseTileId(t.id).lod)

export interface TileEntry { readonly tile: ManifestTile; readonly lod: number }

/** One spatial cell of the map: every LOD of a tile (they share bounds), finest first. */
export interface TileCell {
  readonly base: string
  /** Bounds in Three space (Y up), where the camera lives. */
  readonly box: THREE.Box3
  readonly lods: ReadonlyArray<TileEntry>
}

const worldToThreeBox = (min: Vec3, max: Vec3): THREE.Box3 =>
  new THREE.Box3(new THREE.Vector3(min[0], min[2], -max[1]), new THREE.Vector3(max[0], max[2], -min[1]))

/** Groups manifest tiles into cells by base id. A cell's box is the union of its LODs' bounds. */
export const buildTileIndex = (tiles: ReadonlyArray<ManifestTile>): ReadonlyArray<TileCell> => {
  const cells = new Map<string, { box: THREE.Box3; lods: TileEntry[] }>()
  for (const tile of tiles) {
    const { base } = parseTileId(tile.id)
    const box = worldToThreeBox(tile.bounds.min, tile.bounds.max)
    const cell = cells.get(base)
    if (cell) { cell.box.union(box); cell.lods.push({ tile, lod: tileLod(tile) }) }
    else cells.set(base, { box, lods: [{ tile, lod: tileLod(tile) }] })
  }
  return [...cells].map(([base, c]) => ({ base, box: c.box, lods: c.lods.sort((a, b) => a.lod - b.lod) }))
}

export interface SelectOptions {
  /** Distance, in tile diagonals, within which a tile shows its finest LOD (default 1.5). Each doubling beyond steps one LOD down. */
  readonly lod0Range?: number
}

export const DEFAULT_LOD0_RANGE = 1.5

/** Index into `lods` for a camera `distance` from a tile whose box diagonal is `size`. */
export const lodIndexForDistance = (distance: number, size: number, lodCount: number, lod0Range = DEFAULT_LOD0_RANGE): number => {
  if (lodCount <= 1 || size <= 0) return 0
  const ratio = distance / (size * lod0Range)
  if (!(ratio > 1)) return 0
  return Math.min(lodCount - 1, 1 + Math.floor(Math.log2(ratio)))
}

export interface VisibleCell {
  readonly cell: TileCell
  /** Camera (eye) distance to the cell's box; 0 when the eye is inside. */
  readonly distance: number
  /** Index into `cell.lods` the distance asks for. */
  readonly want: number
}

const frustum = new THREE.Frustum()
const clip = new THREE.Matrix4()

/** Cells that intersect the camera frustum, nearest first, each with the LOD its distance asks for. */
export const selectVisible = (
  cells: ReadonlyArray<TileCell>, camera: THREE.Camera, opts: SelectOptions = {}
): ReadonlyArray<VisibleCell> => {
  camera.updateMatrixWorld()
  clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(clip)
  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
  const size = new THREE.Vector3()
  const out: VisibleCell[] = []
  for (const cell of cells) {
    if (!frustum.intersectsBox(cell.box)) continue
    const distance = cell.box.distanceToPoint(eye)
    const diagonal = cell.box.getSize(size).length()
    out.push({ cell, distance, want: lodIndexForDistance(distance, diagonal, cell.lods.length, opts.lod0Range) })
  }
  return out.sort((a, b) => a.distance - b.distance)
}

export interface PlannedTile {
  readonly cell: TileCell
  /** Index into `cell.lods` that should be resident and shown. */
  readonly index: number
}

/**
 * Chooses what to hold resident for the visible cells within `budgetBytes`. Every visible cell first gets its coarsest
 * LOD (so the view has no holes), nearest cells first, dropping the farthest when even that does not fit; then cells
 * are upgraded towards the LOD their distance asks for, nearest first, while the budget allows.
 * `cost(tile)` is the (estimated) decoded size of a tile in bytes.
 */
export const planResidency = (
  visible: ReadonlyArray<VisibleCell>, budgetBytes: number, cost: (t: ManifestTile) => number
): ReadonlyArray<PlannedTile> => {
  const plan: { cell: TileCell; want: number; index: number }[] = []
  let used = 0
  for (const v of visible) {
    const index = v.cell.lods.length - 1
    const c = cost(v.cell.lods[index]!.tile)
    if (used + c > budgetBytes) continue
    used += c
    plan.push({ cell: v.cell, want: v.want, index })
  }
  for (const p of plan) {
    while (p.index > p.want) {
      const delta = cost(p.cell.lods[p.index - 1]!.tile) - cost(p.cell.lods[p.index]!.tile)
      if (used + delta > budgetBytes) break
      used += delta
      p.index--
    }
  }
  return plan.map((p) => ({ cell: p.cell, index: p.index }))
}

/** Sum of bytes the plan expects to be resident. */
export const plannedBytes = (plan: ReadonlyArray<PlannedTile>, cost: (t: ManifestTile) => number): number =>
  plan.reduce((n, p) => n + cost(p.cell.lods[p.index]!.tile), 0)
