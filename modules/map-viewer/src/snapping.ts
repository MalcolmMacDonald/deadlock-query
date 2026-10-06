import type { OverlayFeature, Vec3 } from "@deadlock-query/contracts"
import type { OverlayLayerData, Project } from "./overlays.ts"
import { featureId } from "./overlays.ts"
import type { SurfaceHit } from "./picking.ts"

export interface SnapSettings {
  /** Place on the collision surface under the cursor (off: on the horizontal plane through the last point). */
  readonly surface: boolean
  /** Snap to the corners of the triangle under the cursor. */
  readonly vertices: boolean
  /** Snap to vertices of existing annotations, overlay layers and the shape being drawn. */
  readonly features: boolean
}

export const DEFAULT_SNAP: SnapSettings = { surface: true, vertices: true, features: true }

/** Pixels within which the cursor snaps to a vertex. */
export const SNAP_RADIUS_PX = 12

/** What a snapped point sits on, in priority order. `plane` is the fallback when nothing was hit. */
export type SnapKind = "feature" | "vertex" | "surface" | "plane"

export interface SnapResult {
  readonly point: Vec3
  readonly kind: SnapKind
}

/** Snap settings that outlive a panel mount, shared by the tools panel and the viewer surface. */
export class SnapState {
  private current: SnapSettings = DEFAULT_SNAP
  private readonly listeners = new Set<() => void>()

  get settings(): SnapSettings { return this.current }

  set(patch: Partial<SnapSettings>) {
    const next = { ...this.current, ...patch }
    if (next.surface === this.current.surface && next.vertices === this.current.vertices && next.features === this.current.features) return
    this.current = next
    for (const fn of [...this.listeners]) fn()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
}

const verticesOf = (f: OverlayFeature): ReadonlyArray<Vec3> =>
  f.type === "point" ? [f.at] : f.type === "polygon" ? f.ring : f.points

/** Hard cap so a huge query layer cannot stall pointer moves; layers are scanned bottom to top until it is hit. */
export const MAX_SNAP_CANDIDATES = 100_000

/**
 * Vertices of the visible overlay layers (annotations and query results alike) plus extra points, such as those
 * already placed in the shape being drawn. `skip` leaves features out by overlay feature id (`layer:index`), e.g. the
 * annotation being edited, which would otherwise snap to itself.
 */
export const snapCandidates = (
  layers: Iterable<readonly [string, OverlayLayerData]>,
  extra: ReadonlyArray<Vec3> = [],
  skip?: (featureId: string) => boolean
): ReadonlyArray<Vec3> => {
  const out: Vec3[] = [...extra]
  for (const [layerId, layer] of layers) {
    for (let i = 0; i < layer.features.length; i++) {
      if (skip?.(featureId(layerId, i))) continue
      for (const v of verticesOf(layer.features[i]!)) {
        if (out.length >= MAX_SNAP_CANDIDATES) return out
        out.push(v)
      }
    }
  }
  return out
}

export interface SnapInput {
  /** Surface hit under the cursor, if the surface is available and was hit. */
  readonly hit?: SurfaceHit | null | undefined
  /** Point on the fallback plane under the cursor. */
  readonly plane?: Vec3 | undefined
  /** Cursor in canvas pixels. */
  readonly cursor: readonly [number, number]
  readonly project: Project
  readonly candidates: ReadonlyArray<Vec3>
  readonly settings: SnapSettings
  readonly radiusPx?: number
}

const nearest = (
  pts: Iterable<Vec3>, project: Project, cx: number, cy: number, radius: number
): Vec3 | undefined => {
  let best: Vec3 | undefined
  let bestD = radius
  for (const p of pts) {
    const s = project(p)
    if (!s) continue
    const d = Math.hypot(s[0] - cx, s[1] - cy)
    if (d <= bestD) { bestD = d; best = p }
  }
  return best
}

/**
 * Resolves where a click or hover lands. Priority: existing feature vertex, then a corner of the triangle under the
 * cursor, then the surface hit, then the fallback plane. Vertex snaps use screen distance, so they work at any zoom.
 */
export const snap = (i: SnapInput): SnapResult | undefined => {
  const r = i.radiusPx ?? SNAP_RADIUS_PX
  const [cx, cy] = i.cursor
  if (i.settings.features) {
    const p = nearest(i.candidates, i.project, cx, cy, r)
    if (p) return { point: p, kind: "feature" }
  }
  if (i.hit) {
    if (i.settings.vertices && i.hit.triangle) {
      const p = nearest(i.hit.triangle, i.project, cx, cy, r)
      if (p) return { point: p, kind: "vertex" }
    }
    if (i.settings.surface) return { point: i.hit.point, kind: "surface" }
  }
  return i.plane ? { point: i.plane, kind: "plane" } : undefined
}
