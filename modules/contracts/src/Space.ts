/**
 * Canonical space: Source 2 world units, right-handed, Z-up (D5).
 * Plain tuples only; classes live in spatial-core / query-library.
 */
export type Vec3 = readonly [x: number, y: number, z: number]
export type Aabb = { readonly min: Vec3; readonly max: Vec3 }
/** Column-major 4x4 matrix, 16 numbers. */
export type Mat4 = readonly number[]

export const IDENTITY_MAT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** glTF is Y-up right-handed: world (x,y,z) <- glb (x,-z,y). Column-major. */
export const DEFAULT_GLB_TO_WORLD: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]

export const transformPoint = (m: Mat4, p: Vec3): Vec3 => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!
]

/** World (Z-up) -> Three.js (Y-up): (x,y,z) -> (x,z,-y). */
export const worldToThree = (p: Vec3): Vec3 => [p[0], p[2], -p[1]]
export const threeToWorld = (p: Vec3): Vec3 => [p[0], -p[2], p[1]]

/** Approximate Source unit conversions: 1 unit = 1/16 ft (0.01905 m). */
export const UNITS_PER_METER = 1 / 0.01905
export const unitsToMeters = (u: number): number => u * 0.01905
export const metersToUnits = (m: number): number => m / 0.01905

export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
