import type { Manifest, MetadataRecord, Vec3 } from "@deadlock-query/contracts"

/**
 * What the validators may ask of the map's collision. The editor builds one from the loaded `MapBundle`; the submit worker
 * has none and runs in degraded mode (bounds checks only).
 */
export interface CollisionProbe {
  /** Height of the highest solid surface at (x, y) at or below `zFrom`, or `undefined` when there is none. */
  readonly groundZ: (x: number, y: number, zFrom: number) => number | undefined
  /** The point lies inside solid geometry. */
  readonly insideSolid: (p: Vec3) => boolean
}

export interface ValidationContext {
  /** `manifest.bounds` of the loaded map: every point must lie inside, with `boundsMargin` slack. */
  readonly bounds?: Manifest["bounds"]
  readonly boundsMargin?: number
  /** Build and map the data must belong to. */
  readonly expect?: { readonly gameBuildId?: string; readonly mapName?: string }
  /** Absent = degraded mode: surface and solid checks are skipped. */
  readonly collision?: CollisionProbe
  /** Already accepted records of the same build: new points may not duplicate them, new regions are compared with them. */
  readonly existing?: ReadonlyArray<MetadataRecord>
  /** Largest allowed distance between a point's Z and the ground below it (default 24 units). */
  readonly surfaceEpsilon?: number
  /** Polygon area limits in square units (defaults: 1, and the bounds' footprint or 1e8 without bounds). */
  readonly minArea?: number
  readonly maxArea?: number
  /** Two walkable regions whose floor heights differ by less than this and that overlap are flagged (default 64 units). */
  readonly overlapFloorTolerance?: number
}

export const DEFAULT_SURFACE_EPSILON = 24
export const DEFAULT_MAX_AREA = 1e8
export const DEFAULT_OVERLAP_FLOOR_TOLERANCE = 64
