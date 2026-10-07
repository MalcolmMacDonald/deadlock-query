/** A hit from a ray test (structural match for spatial-core's `Hit`). @category Spatial */
export interface RayHit {
  readonly point: readonly [number, number, number]
  readonly normal: readonly [number, number, number]
  readonly distance: number
}

/**
 * The slice of spatial-core's `Raycaster` this library uses. Structural, so the published
 * `.d.ts` never imports spatial-core.
 * @category Spatial
 */
export interface RaycasterLike {
  readonly bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }
  raycastFirst(origin: readonly [number, number, number], dir: readonly [number, number, number], opts?: { max?: number; backfaces?: boolean }): RayHit | null
  occluded(a: readonly [number, number, number], b: readonly [number, number, number]): boolean
}

/** Numeric knobs forwarded unchanged to the owner-authored semantics functions. @category Spatial */
export type SemanticsParams = Readonly<Record<string, number>>

/** Result of a nearest-wall lookup. @category Spatial */
export interface WallHit {
  readonly point: readonly [number, number, number]
  readonly normal: readonly [number, number, number]
  readonly distance: number
}

/**
 * The owner-authored semantics (spatial-core `semantics/`). This library only wraps them;
 * pass them to `MapContext.fromBundle` as `spatial.semantics`.
 * @category Spatial
 */
export interface SemanticsLike {
  /** True while these are the provisional placeholder implementations. */
  readonly placeholder?: boolean
  isInterior(rc: RaycasterLike, p: readonly [number, number, number], params: SemanticsParams): boolean
  isVisible(rc: RaycasterLike, from: readonly [number, number, number], to: readonly [number, number, number], params: SemanticsParams): boolean
  nearestWall(rc: RaycasterLike, p: readonly [number, number, number], params: SemanticsParams): WallHit | null
}

/** Walking/link speeds in Source units per second. @category Navigation */
export interface MovementModelLike {
  readonly speed: number
  /** Speed per off-mesh link kind; links of unlisted kinds are unusable. */
  readonly linkSpeeds?: Readonly<Record<string, number>>
}

/** The slice of spatial-core's `NavMesh` this library uses (structural). @category Navigation */
export interface NavMeshLike {
  findPath(from: readonly [number, number, number], to: readonly [number, number, number], model: MovementModelLike, opts?: { radius?: number }): { readonly points: ReadonlyArray<readonly [number, number, number]>; readonly cost: number } | null
  /** Optional: straight segment stays on the mesh (spatial-core `NavMesh.walkable`). */
  walkable?(a: readonly [number, number, number], b: readonly [number, number, number]): boolean
  distanceField(sources: readonly (readonly [number, number, number])[], model: MovementModelLike): { costAt(p: readonly [number, number, number], maxSnap?: number): number; readonly costs?: ArrayLike<number> }
}

/**
 * Navigation backend: a spatial-core `NavMesh` plus the travel model.
 * Defaults (hero speed 7 m/s, zipline 15 m/s, `navConnection` at the hero speed) are proposals for the owner to confirm.
 * @category Navigation
 */
export interface NavInput {
  readonly mesh: NavMeshLike
  /** Walking speed in Source units per second. Default `meters(7)`. */
  readonly heroSpeed?: number
  /**
   * Off-mesh link speeds by kind, Source units per second, merged over the defaults
   * `{ zipline: meters(15), navConnection: heroSpeed }`; a kind set to 0 is not travelled.
   */
  readonly linkSpeeds?: Readonly<Record<string, number>>
  /** Max distance from a point to the mesh before it counts as off-mesh (unreachable). Default 900 units (floating pickups on the real map sit up to ~855 above the mesh; points are snapped to the nearest mesh point in 3D). */
  readonly maxSnap?: number
}

/** Spatial backend handed to `MapContext.fromBundle`. @category Spatial */
export interface SpatialInput {
  readonly raycaster: RaycasterLike
  /** Navmesh + travel model; without it travel-time functions throw. */
  readonly nav?: NavInput
  readonly semantics?: SemanticsLike
  readonly params?: SemanticsParams
}

/** Per-call overrides for visibility tests. @category Spatial */
export interface VisibleOpts {
  /** Overrides `eyeHeight` for the viewpoints. */
  readonly eyeHeight?: number
  /** Overrides `targetHeight` for the tested point. */
  readonly targetHeight?: number
  /** Overrides `maxRange`. */
  readonly maxRange?: number
}
