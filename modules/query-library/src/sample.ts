import { Seq } from "./Seq.ts"
import { Vec3 } from "./Vec3.ts"
import { requireSemantics, requireSpatial } from "./active.ts"

/** Options for {@link SampleApi.grid}. @category Sampling */
export interface GridOpts {
  /** Restrict to an XY box (Source units); z is ignored. */
  readonly region?: { readonly min: readonly [number, number]; readonly max: readonly [number, number] }
  /** Minimum surface normal z to count as walkable floor. Default 0.7 (about 45 degrees). */
  readonly minNormalZ?: number
}

/**
 * Samplers over the map geometry (`map.sample`). Output order is deterministic (x-major).
 * @example map.sample.grid(300).count()
 * @category Sampling
 */
export class SampleApi {
  /**
   * Points on walkable floors, one per `spacing` Source units, found by casting rays straight
   * down from above the map. O(cells) ray tests.
   * @example map.sample.grid(300, { region: { min: [0, 0], max: [2000, 2000] } })
   * @category Sampling
   */
  grid(spacing: number, opts: GridOpts = {}): Seq<Vec3> {
    if (!(spacing > 0)) throw new Error("grid(spacing): spacing must be > 0")
    const { raycaster: rc } = requireSpatial("sample.grid()")
    const minNz = opts.minNormalZ ?? 0.7
    const b = rc.bounds
    const x0 = Math.max(b.min[0], opts.region?.min[0] ?? -Infinity), x1 = Math.min(b.max[0], opts.region?.max[0] ?? Infinity)
    const y0 = Math.max(b.min[1], opts.region?.min[1] ?? -Infinity), y1 = Math.min(b.max[1], opts.region?.max[1] ?? Infinity)
    const top = b.max[2] + 1
    return new Seq({
      *[Symbol.iterator]() {
        for (let x = Math.ceil(x0 / spacing) * spacing; x <= x1; x += spacing)
          for (let y = Math.ceil(y0 / spacing) * spacing; y <= y1; y += spacing) {
            const h = rc.raycastFirst([x, y, top], [0, 0, -1])
            if (h && h.normal[2] >= minNz) yield new Vec3(h.point[0], h.point[1], h.point[2])
          }
      },
    })
  }

  /**
   * Points along wall bases: the nearest wall point (owner semantics) from each floor grid
   * point, de-duplicated to one per `spacing` cell. O(cells) wall lookups.
   * @example map.sample.walls(200).take(10)
   * @category Sampling
   */
  walls(spacing: number): Seq<Vec3> {
    const { s, sem } = requireSemantics("sample.walls()")
    const floor = this.grid(spacing)
    return new Seq({
      *[Symbol.iterator]() {
        const seen = new Set<string>()
        for (const p of floor) {
          const w = sem.nearestWall(s.raycaster, p.toArray(), s.params ?? {})
          if (!w) continue
          const key = `${Math.round(w.point[0] / spacing)},${Math.round(w.point[1] / spacing)},${Math.round(w.point[2] / spacing)}`
          if (seen.has(key)) continue
          seen.add(key)
          yield new Vec3(w.point[0], w.point[1], w.point[2])
        }
      },
    })
  }
}
