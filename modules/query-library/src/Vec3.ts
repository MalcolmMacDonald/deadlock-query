import { requireSemantics, requireSpatial } from "./active.ts"
import { travelCost } from "./nav.ts"
import type { VisibleOpts } from "./spatial.ts"

/**
 * A point or vector in Source world units (right-handed, Z-up).
 * @example vec(0, 0, 0).distanceTo(vec(3, 4, 0)) // 5
 * @category Geometry
 */
export class Vec3 {
  constructor(readonly x: number, readonly y: number, readonly z: number) {}

  /**
   * Straight-line distance to another point, in Source units. O(1).
   * @example map.guardians.first()!.position.distanceTo(vec(0, 0, 0))
   * @category Geometry
   */
  distanceTo(other: Vec3): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }

  /**
   * Straight-line ("as the crow flies") distance; alias of {@link Vec3.distanceTo}.
   * @example vec(0, 0, 0).crowFliesTo(vec(0, 0, 10))
   * @category Geometry
   */
  crowFliesTo(other: Vec3): number {
    return this.distanceTo(other)
  }

  /**
   * Elevation above the lowest point of the map bounds, in Source units. O(1).
   * @example map.sample.grid(300).filter(p => p.height() > 800)
   * @category Geometry
   */
  height(): number {
    return this.z - requireSpatial("height()").raycaster.bounds.min[2]
  }

  /**
   * Whether the point is inside a building/room (owner-authored semantics; needs spatial backend).
   * @example map.healingOrbs.where(o => o.position.isInterior())
   * @category Geometry
   */
  isInterior(): boolean {
    const { s, sem } = requireSemantics("isInterior()")
    return sem.isInterior(s.raycaster, this.toArray(), s.params ?? {})
  }

  /**
   * The nearest wall surface to the point, or `undefined` when none is in range
   * (owner-authored semantics).
   * @example vec(0, 0, 0).nearestWall()?.distance
   * @category Geometry
   */
  nearestWall(): { readonly point: Vec3; readonly normal: Vec3; readonly distance: number } | undefined {
    const { s, sem } = requireSemantics("nearestWall()")
    const w = sem.nearestWall(s.raycaster, this.toArray(), s.params ?? {})
    return w ? { point: new Vec3(...w.point), normal: new Vec3(...w.normal), distance: w.distance } : undefined
  }

  /**
   * True when this point is visible from the given viewpoint, or from any of several
   * (owner-authored semantics). O(viewpoints) ray tests.
   * @example map.creepCamps.where(c => c.position.visibleFrom(map.guardians.select(g => g.position)))
   * @category Geometry
   */
  visibleFrom(from: Vec3 | Iterable<Vec3>, opts: VisibleOpts = {}): boolean {
    const { s, sem } = requireSemantics("visibleFrom()")
    const params = { ...(s.params ?? {}), ...(opts.eyeHeight === undefined ? {} : { eyeHeight: opts.eyeHeight }), ...(opts.targetHeight === undefined ? {} : { targetHeight: opts.targetHeight }), ...(opts.maxRange === undefined ? {} : { maxRange: opts.maxRange }) }
    for (const v of from instanceof Vec3 ? [from] : from) if (sem.isVisible(s.raycaster, v.toArray(), this.toArray(), params)) return true
    return false
  }

  /**
   * Walking travel time to another point in seconds (navmesh, ziplines), `Infinity` if
   * unreachable. Distance fields are cached per start point, so many targets from one start are cheap.
   * @example map.guardians.first()!.position.travelTimeTo(map.healingOrbs.first()!.position)
   * @category Navigation
   */
  travelTimeTo(other: Vec3): number {
    return travelCost("travelTimeTo()", "time", this, other)
  }

  /**
   * Length in Source units of the quickest route to another point (navmesh, ziplines),
   * `Infinity` if unreachable. Compare with {@link Vec3.crowFliesTo}.
   * @example vec(0, 0, 0).travelDistanceTo(vec(1000, 0, 0))
   * @category Navigation
   */
  travelDistanceTo(other: Vec3): number {
    return travelCost("travelDistanceTo()", "distance", this, other)
  }

  /**
   * Component-wise equality.
   * @example vec(1, 2, 3).equals(vec(1, 2, 3)) // true
   * @category Geometry
   */
  equals(other: Vec3): boolean {
    return this.x === other.x && this.y === other.y && this.z === other.z
  }

  /**
   * The point as an `[x, y, z]` tuple (the shape `QueryResult` point cells use).
   * @example vec(1, 2, 3).toArray() // [1, 2, 3]
   * @category Geometry
   */
  toArray(): [number, number, number] {
    return [this.x, this.y, this.z]
  }
}

/**
 * Construct a {@link Vec3}.
 * @example vec(100, 200, 0)
 * @category Geometry
 */
export const vec = (x: number, y: number, z: number): Vec3 => new Vec3(x, y, z)
