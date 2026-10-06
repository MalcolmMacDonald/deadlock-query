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

/** Spatial backend handed to `MapContext.fromBundle`. @category Spatial */
export interface SpatialInput {
  readonly raycaster: RaycasterLike
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
