/** Tunables for the semantics functions. Defaults are provisional (see PLACEHOLDER_SEMANTICS). */
export interface SemanticsParams {
  /** Viewer eye height above the source point (world units). */
  readonly eyeHeight: number
  /** Height above the target point that must be visible. */
  readonly targetHeight: number
  /** Maximum sight / wall search distance. */
  readonly maxRange: number
  /** Surfaces steeper than this many degrees from horizontal count as walls. */
  readonly wallMinSlope: number
  /** A point is interior when something solid is above it within this distance. */
  readonly interiorCeiling: number
  /** Number of horizontal directions sampled by `nearestWall`. */
  readonly wallRays: number
  /** Height above the point at which `nearestWall` samples. */
  readonly wallSampleHeight: number
}

export const DEFAULT_PARAMS: SemanticsParams = {
  eyeHeight: 64,
  targetHeight: 32,
  maxRange: 5000,
  wallMinSlope: 60,
  interiorCeiling: 1500,
  wallRays: 32,
  wallSampleHeight: 48
}
