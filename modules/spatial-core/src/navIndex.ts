import { Triangle, Vector3 } from "three"
import type { Vec3 } from "@deadlock-query/contracts"
import type { NavMeshData } from "./navmesh.ts"

/**
 * Uniform XY grid over the fan triangles of a polygon soup, for nearest-point queries.
 * Triangles are listed in every cell their XY bounds overlap; queries expand rings of cells
 * around the query point and stop once no unexplored cell can beat the best 3D distance
 * (XY distance is a lower bound of 3D distance, so stacked floors are handled exactly).
 * Ties go to the lowest triangle id, which equals a linear scan in polygon order.
 */
export class NavIndex {
  private readonly triPoly: Uint32Array
  private readonly triK: Uint32Array
  private readonly cellStart: Uint32Array
  private readonly cellTris: Uint32Array
  private readonly minX: number
  private readonly minY: number
  private readonly cs: number
  private readonly nx: number
  private readonly ny: number
  private readonly stamp: Uint32Array
  private stampId = 0

  constructor(private readonly data: NavMeshData) {
    const { vertices: V, offsets: O, indices: I } = data
    const polyCount = O.length - 1
    let triCount = 0
    for (let p = 0; p < polyCount; p++) triCount += Math.max(0, O[p + 1]! - O[p]! - 2)
    this.triPoly = new Uint32Array(triCount)
    this.triK = new Uint32Array(triCount)
    let t = 0
    for (let p = 0; p < polyCount; p++) for (let k = O[p]! + 1; k + 1 < O[p + 1]!; k++) { this.triPoly[t] = p; this.triK[t] = k; t++ }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < V.length; i += 3) {
      const x = V[i]!, y = V[i + 1]!
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    if (triCount === 0) { minX = minY = 0; maxX = maxY = 1 }
    const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6)
    // About two triangles per cell, capped so a huge bounds box cannot allocate millions of empty cells.
    let cs = Math.sqrt((w * h) / Math.max(triCount, 1)) * 1.4
    while ((Math.floor(w / cs) + 1) * (Math.floor(h / cs) + 1) > 4_000_000) cs *= 1.5
    this.minX = minX; this.minY = minY; this.cs = cs
    this.nx = Math.floor(w / cs) + 1; this.ny = Math.floor(h / cs) + 1

    const cells = this.nx * this.ny
    const counts = new Uint32Array(cells + 1)
    const range = (tri: number): [number, number, number, number] => {
      const p = this.triPoly[tri]!, k = this.triK[tri]!
      const a = I[O[p]!]! * 3, b = I[k]! * 3, c = I[k + 1]! * 3
      const x0 = Math.min(V[a]!, V[b]!, V[c]!), x1 = Math.max(V[a]!, V[b]!, V[c]!)
      const y0 = Math.min(V[a + 1]!, V[b + 1]!, V[c + 1]!), y1 = Math.max(V[a + 1]!, V[b + 1]!, V[c + 1]!)
      return [this.cellX(x0), this.cellX(x1), this.cellY(y0), this.cellY(y1)]
    }
    for (let tri = 0; tri < triCount; tri++) {
      const [cx0, cx1, cy0, cy1] = range(tri)
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) counts[cy * this.nx + cx + 1]!++
    }
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!
    this.cellStart = counts
    this.cellTris = new Uint32Array(counts[cells]!)
    const fill = counts.slice(0, cells)
    for (let tri = 0; tri < triCount; tri++) {
      const [cx0, cx1, cy0, cy1] = range(tri)
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.cellTris[fill[cy * this.nx + cx]!++] = tri
    }
    this.stamp = new Uint32Array(triCount)
  }

  private cellX(x: number): number { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cs))) }
  private cellY(y: number): number { return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.minY) / this.cs))) }

  nearest(p: Vec3, maxDist = Infinity): { point: Vec3; poly: number; distance: number } | null {
    const { vertices: V, indices: I, offsets: O } = this.data
    if (this.triPoly.length === 0) return null
    const tri = new Triangle(), t = new Vector3(), q = new Vector3(p[0], p[1], p[2]), best = new Vector3()
    const id = ++this.stampId
    let bd = Infinity, bt = -1
    const scan = (cx: number, cy: number) => {
      const cell = cy * this.nx + cx
      for (let i = this.cellStart[cell]!, e = this.cellStart[cell + 1]!; i < e; i++) {
        const ti = this.cellTris[i]!
        if (this.stamp[ti] === id) continue
        this.stamp[ti] = id
        const poly = this.triPoly[ti]!, k = this.triK[ti]!
        tri.a.fromArray(V, I[O[poly]!]! * 3); tri.b.fromArray(V, I[k]! * 3); tri.c.fromArray(V, I[k + 1]! * 3)
        tri.closestPointToPoint(q, t)
        const d = t.distanceTo(q)
        if (d < bd || (d === bd && ti < bt)) { bd = d; bt = ti; best.copy(t) }
      }
    }
    const cx = this.cellX(p[0]), cy = this.cellY(p[1])
    for (let r = 0; ; r++) {
      const x0 = cx - r, x1 = cx + r, y0 = cy - r, y1 = cy + r
      for (let y = Math.max(y0, 0); y <= Math.min(y1, this.ny - 1); y++) {
        if (y === y0 || y === y1) for (let x = Math.max(x0, 0); x <= Math.min(x1, this.nx - 1); x++) scan(x, y)
        else {
          if (x0 >= 0) scan(x0, y)
          if (x1 < this.nx) scan(x1, y)
        }
      }
      // Lower bound (XY) for anything outside the explored window; sides at the grid edge hold nothing further.
      let lb = Infinity
      if (x0 > 0) lb = Math.min(lb, Math.max(0, p[0] - (this.minX + x0 * this.cs)))
      if (x1 < this.nx - 1) lb = Math.min(lb, Math.max(0, this.minX + (x1 + 1) * this.cs - p[0]))
      if (y0 > 0) lb = Math.min(lb, Math.max(0, p[1] - (this.minY + y0 * this.cs)))
      if (y1 < this.ny - 1) lb = Math.min(lb, Math.max(0, this.minY + (y1 + 1) * this.cs - p[1]))
      if (lb === Infinity || lb > bd || lb > maxDist) break
    }
    if (bt < 0 || bd > maxDist) return null
    return { point: [best.x, best.y, best.z], poly: this.triPoly[bt]!, distance: bd }
  }
}
