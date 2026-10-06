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
