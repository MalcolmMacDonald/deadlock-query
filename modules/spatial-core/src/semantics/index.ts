import type { Vec3 } from "@deadlock-query/contracts"
import type { Raycaster } from "../raycaster.ts"
import { DEFAULT_PARAMS, type SemanticsParams } from "./params.ts"

export { DEFAULT_PARAMS, type SemanticsParams } from "./params.ts"

/**
 * True while the bodies below are first-pass implementations (naive ray tests).
 * Results carrying this flag must be shown as provisional; flip it off when the
 * owner has reviewed and finalised the behaviour against `test/semantics/cases.json`.
 */
export const PLACEHOLDER_SEMANTICS = true

const params = (p?: Partial<SemanticsParams>): SemanticsParams => ({ ...DEFAULT_PARAMS, ...p })

/** Something solid within `interiorCeiling` straight above `p`. */
export function isInterior(rc: Raycaster, p: Vec3, opts?: Partial<SemanticsParams>): boolean {
  const s = params(opts)
  return rc.raycastFirst([p[0], p[1], p[2] + 1], [0, 0, 1], { max: s.interiorCeiling, backfaces: true }) !== null
}

/** Segment from eye height at `from` to target height at `to` is unobstructed and within range. */
export function isVisible(rc: Raycaster, from: Vec3, to: Vec3, opts?: Partial<SemanticsParams>): boolean {
  const s = params(opts)
  const a: Vec3 = [from[0], from[1], from[2] + s.eyeHeight]
  const b: Vec3 = [to[0], to[1], to[2] + s.targetHeight]
  if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > s.maxRange) return false
  return !rc.occluded(a, b)
}

/** Closest steep surface found by casting `wallRays` horizontal rays around `p`. */
export function nearestWall(rc: Raycaster, p: Vec3, opts?: Partial<SemanticsParams>): { point: Vec3; normal: Vec3; distance: number } | null {
  const s = params(opts)
  const origin: Vec3 = [p[0], p[1], p[2] + s.wallSampleHeight]
  const maxNz = Math.cos((s.wallMinSlope * Math.PI) / 180)
  let best: { point: Vec3; normal: Vec3; distance: number } | null = null
  for (let i = 0; i < s.wallRays; i++) {
    const a = (i / s.wallRays) * Math.PI * 2
    const h = rc.raycastFirst(origin, [Math.cos(a), Math.sin(a), 0], { max: s.maxRange, backfaces: true })
    if (h && Math.abs(h.normal[2]) <= maxNz && (!best || h.distance < best.distance)) best = { point: h.point, normal: h.normal, distance: h.distance }
  }
  return best
}
