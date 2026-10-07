import * as THREE from "three"
import {
  planResidency, selectVisible, type ManifestTile, type PlannedTile, type SelectOptions, type TileCell
} from "./tiles.ts"
import { decodedBytes, type TileDecoder } from "./tileDecode.ts"

export const DEFAULT_TILE_BUDGET_BYTES = 512 * 1024 * 1024
export const DEFAULT_MAX_IN_FLIGHT = 4
/** Decoded size over file size, assumed until a tile has been measured (meshopt-compressed tiles inflate a lot). */
const INITIAL_INFLATION = 4

export interface StreamStats {
  /** Tiles whose geometry is resident (decoded, held in memory / on the GPU). */
  readonly resident: number
  readonly residentBytes: number
  readonly peakBytes: number
  readonly budgetBytes: number
  /** Tiles currently shown (one LOD per visible cell). */
  readonly displayed: number
  /** Cells the camera sees right now. */
  readonly visibleCells: number
  /** Tiles fetching or decoding. */
  readonly loading: number
  /** Tiles the plan wants that are not resident yet. */
  readonly missing: number
  readonly loaded: number
  readonly evicted: number
  readonly failed: number
  /** Cells showing a coarser LOD than their distance asks for (waiting for a finer one or held back by the budget). */
  readonly coarse: number
}

export interface StreamerOptions {
  readonly cells: ReadonlyArray<TileCell>
  /** Fetches a tile's GLB bytes. */
  readonly fetchTile: (tile: ManifestTile) => Promise<Uint8Array>
  readonly decoder: TileDecoder
  /** GLB-local -> Three space (`glbToThreeMatrix`). */
  readonly glbToThree: THREE.Matrix4
  readonly material: THREE.Material
  /** Material for tiles that carry vertex colours (default: `material`). */
  readonly colorMaterial?: THREE.Material
  readonly budgetBytes?: number
  readonly maxInFlight?: number
  readonly select?: SelectOptions
  /** Something changed that needs a redraw (a tile appeared or disappeared). */
  readonly onChange?: () => void
  /** Stats changed (loading progress). */
  readonly onStats?: (s: StreamStats) => void
}

interface Resident {
  readonly key: string
  readonly cellBase: string
  readonly index: number
  readonly mesh: THREE.Mesh
  readonly bytes: number
  readonly fileBytes: number
  lastUsed: number
}

const keyOf = (cell: TileCell, index: number) => cell.lods[index]!.tile.id

/**
 * Streams render tiles: picks the visible cells and LODs for a camera, fetches and decodes what is missing (nearest
 * first, a few at a time), shows one LOD per cell, and evicts least-recently-used tiles to stay within `budgetBytes`
 * of decoded geometry. Transient decode buffers (at most `maxInFlight` tiles) are not counted.
 */
export class TileStreamer {
  /** Parent of every tile mesh; add it to the scene. */
  readonly root = new THREE.Group()
  private readonly budget: number
  private readonly maxInFlight: number
  private readonly resident = new Map<string, Resident>()
  private readonly inFlight = new Set<string>()
  private readonly failedKeys = new Set<string>()
  /** Tiles that decoded but could not be given room under the current camera; retried when the camera moves. */
  private readonly blocked = new Set<string>()
  private wanted: ReadonlyArray<PlannedTile> = []
  private visibleCount = 0
  private inflation = INITIAL_INFLATION
  private frame = 0
  private bytes = 0
  private peak = 0
  private loaded = 0
  private evicted = 0
  private failed = 0
  private disposed = false
  private lastCamera: THREE.Camera | undefined
  private lastDisplayed = ""

  constructor(private readonly o: StreamerOptions) {
    this.budget = o.budgetBytes ?? DEFAULT_TILE_BUDGET_BYTES
    this.maxInFlight = o.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT
    this.root.matrixAutoUpdate = false
    this.root.matrix.copy(o.glbToThree)
  }

  /** Decoded size to plan with: measured when the tile is resident, else file size times the observed inflation. */
  private cost = (t: ManifestTile): number => this.resident.get(t.id)?.bytes ?? Math.ceil(t.bytes * this.inflation)

  /** Re-plans for `camera`: call whenever the camera moved. Cheap (culling + a sort over the cells). */
  update(camera: THREE.Camera): void {
    this.blocked.clear()
    this.replan(camera, true)
  }

  private replan(camera: THREE.Camera, moved = false): void {
    if (this.disposed) return
    this.lastCamera = camera
    if (moved) this.frame++
    const visible = selectVisible(this.o.cells, camera, this.o.select)
    this.visibleCount = visible.length
    this.wanted = planResidency(visible, this.budget, this.cost)
    this.show()
    this.pump()
    this.publish()
  }

  stats(): StreamStats {
    let coarse = 0
    for (const p of this.wanted) if (!this.resident.has(keyOf(p.cell, p.index))) coarse++
    return {
      resident: this.resident.size, residentBytes: this.bytes, peakBytes: this.peak, budgetBytes: this.budget,
      displayed: this.root.children.filter((c) => c.visible).length, visibleCells: this.visibleCount,
      loading: this.inFlight.size, missing: this.missing().length, loaded: this.loaded, evicted: this.evicted, failed: this.failed, coarse
    }
  }

  /** Resolves when nothing is loading and the plan has no missing tiles (or every missing one failed). */
  async idle(): Promise<void> {
    while (!this.disposed && (this.inFlight.size > 0 || this.missing().some((p) => this.retryable(keyOf(p.cell, p.index))))) {
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  dispose(): void {
    this.disposed = true
    for (const r of this.resident.values()) { r.mesh.geometry.dispose(); this.root.remove(r.mesh) }
    this.resident.clear()
    this.bytes = 0
    this.o.decoder.dispose()
  }

  private retryable(key: string): boolean { return !this.failedKeys.has(key) && !this.blocked.has(key) }

  private missing(): ReadonlyArray<PlannedTile> {
    return this.wanted.filter((p) => !this.resident.has(keyOf(p.cell, p.index)))
  }

  /** Starts loads for missing tiles, in plan (nearest-first) order, up to the in-flight limit. */
  private pump() {
    for (const p of this.missing()) {
      if (this.inFlight.size >= this.maxInFlight) return
      const key = keyOf(p.cell, p.index)
      if (this.inFlight.has(key) || !this.retryable(key)) continue
      void this.load(p.cell, p.index)
    }
  }

  private async load(cell: TileCell, index: number) {
    const entry = cell.lods[index]!
    const key = entry.tile.id
    this.inFlight.add(key)
    this.publish()
    try {
      const bytes = await this.o.fetchTile(entry.tile)
      const geo = await this.o.decoder.decode(bytes)
      if (this.disposed) return
      const size = decodedBytes(geo)
      this.inflation = size / Math.max(1, entry.tile.bytes || bytes.byteLength)
      if (!this.makeRoom(size, key)) { this.blocked.add(key); return } // everything resident is closer and needed
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.BufferAttribute(geo.positions, 3))
      g.setIndex(new THREE.BufferAttribute(geo.indices, 1))
      if (geo.colors) g.setAttribute("color", new THREE.BufferAttribute(geo.colors, 4, true))
      if (geo.positions.length >= 3) g.computeBoundingSphere() // an empty tile has nothing to bound
      const mesh = new THREE.Mesh(g, geo.colors && this.o.colorMaterial ? this.o.colorMaterial : this.o.material)
      mesh.visible = false
      mesh.frustumCulled = true
      this.root.add(mesh)
      this.resident.set(key, { key, cellBase: cell.base, index, mesh, bytes: size, fileBytes: entry.tile.bytes, lastUsed: this.frame })
      this.bytes += size
      this.peak = Math.max(this.peak, this.bytes)
      this.loaded++
    } catch (err) {
      this.failed++
      this.failedKeys.add(key)
      console.warn(`tile ${key} failed to load:`, err)
    } finally {
      this.inFlight.delete(key)
      if (!this.disposed) {
        // Re-plan with the camera we have: the new size changes the estimates, and a slot is free for the next tile.
        if (this.lastCamera) this.replan(this.lastCamera)
        this.o.onChange?.()
      }
    }
  }

  /**
   * Evicts until `needed` more bytes fit. Order: tiles the plan does not want (least recently used first), then
   * planned tiles from the farthest (the plan is nearest-first). Returns false if it cannot make room.
   */
  private makeRoom(needed: number, incomingKey: string): boolean {
    if (needed > this.budget) return false
    const plannedKeys = new Map<string, number>()
    this.wanted.forEach((p, i) => plannedKeys.set(keyOf(p.cell, p.index), i))
    // Incoming tile's own cell: its other LODs are replaceable too, but keep ones the plan wants.
    const victims = [...this.resident.values()]
      .filter((r) => r.key !== incomingKey)
      .sort((a, b) => {
        const pa = plannedKeys.get(a.key), pb = plannedKeys.get(b.key)
        if (pa === undefined && pb === undefined) return a.lastUsed - b.lastUsed
        if (pa === undefined) return -1
        if (pb === undefined) return 1
        return pb - pa // farthest planned first
      })
    const incomingRank = plannedKeys.get(incomingKey) ?? Infinity
    for (const v of victims) {
      if (this.bytes + needed <= this.budget) break
      const rank = plannedKeys.get(v.key)
      // Never evict something nearer than the tile that is arriving.
      if (rank !== undefined && rank < incomingRank) continue
      this.evict(v)
    }
    return this.bytes + needed <= this.budget
  }

  private evict(r: Resident) {
    this.root.remove(r.mesh)
    r.mesh.geometry.dispose()
    this.resident.delete(r.key)
    this.bytes -= r.bytes
    this.evicted++
  }

  /** Shows, per planned cell, the resident LOD closest to the planned one; hides everything else. */
  private show() {
    const shown = new Set<string>()
    for (const p of this.wanted) {
      let best: Resident | undefined
      for (let i = 0; i < p.cell.lods.length; i++) {
        const r = this.resident.get(keyOf(p.cell, i))
        if (!r) continue
        if (!best || Math.abs(i - p.index) < Math.abs(best.index - p.index)) best = r
      }
      if (best) { best.lastUsed = this.frame; shown.add(best.key) }
    }
    let changed = false
    for (const r of this.resident.values()) {
      const on = shown.has(r.key)
      if (r.mesh.visible !== on) { r.mesh.visible = on; changed = true }
    }
    const sig = [...shown].sort().join("|")
    if (changed || sig !== this.lastDisplayed) { this.lastDisplayed = sig; this.o.onChange?.() }
  }

  private publish() { this.o.onStats?.(this.stats()) }
}
