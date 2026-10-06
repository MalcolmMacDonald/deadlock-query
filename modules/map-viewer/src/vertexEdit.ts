import type { Annotation, AnnotationKind, Vec3 } from "@deadlock-query/contracts"
import type { Project } from "./overlays.ts"

/** Fewest vertices a kind can keep; `point`/`label` have exactly one, `measure` exactly two. */
export const MIN_VERTICES: Record<AnnotationKind, number> = { point: 1, label: 1, measure: 2, polyline: 2, polygon: 3 }

/** Kinds whose vertex count can change (insert/delete a vertex). */
export const hasVariableVertices = (a: Annotation): boolean => a.kind === "polyline" || a.kind === "polygon"

const withPoints = (a: Annotation, points: ReadonlyArray<Vec3>): Annotation => ({ ...a, points } as Annotation)

export const moveVertex = (a: Annotation, index: number, to: Vec3): Annotation => {
  if (index < 0 || index >= a.points.length) return a
  return withPoints(a, a.points.map((p, i) => (i === index ? to : p)))
}

/** Inserts `at` after vertex `after` (a polygon's closing edge is `after = last`); undefined for fixed-size kinds. */
export const insertVertex = (a: Annotation, after: number, at: Vec3): Annotation | undefined => {
  if (!hasVariableVertices(a) || after < 0 || after >= a.points.length) return undefined
  return withPoints(a, [...a.points.slice(0, after + 1), at, ...a.points.slice(after + 1)])
}

/** Removes a vertex; undefined when the shape would fall below its minimum. */
export const removeVertex = (a: Annotation, index: number): Annotation | undefined => {
  if (!hasVariableVertices(a) || a.points.length <= MIN_VERTICES[a.kind] || index < 0 || index >= a.points.length) return undefined
  return withPoints(a, a.points.filter((_, i) => i !== index))
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/**
 * Edge of `a` closest to a pixel, within `radiusPx`: `after` is the index of the edge's first vertex and `point` the
 * world point on the edge under the cursor. Polygons include the closing edge.
 */
export const nearestEdge = (
  a: Annotation, project: Project, px: number, py: number, radiusPx = 8
): { readonly after: number; readonly point: Vec3 } | undefined => {
  if (!hasVariableVertices(a)) return undefined
  const n = a.points.length
  const edges = a.kind === "polygon" ? n : n - 1
  let best: { after: number; point: Vec3 } | undefined
  let bestD = radiusPx
  for (let i = 0; i < edges; i++) {
    const p = a.points[i]!, q = a.points[(i + 1) % n]!
    const s = project(p), e = project(q)
    if (!s || !e) continue
    const dx = e[0] - s[0], dy = e[1] - s[1]
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - s[0]) * dx + (py - s[1]) * dy) / len2))
    const d = Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy))
    if (d <= bestD) { bestD = d; best = { after: i, point: lerp(p, q, t) } }
  }
  return best
}

/** Index of the vertex of `points` within `radiusPx` of a pixel (nearest wins), for grabbing a handle. */
export const nearestVertex = (
  points: ReadonlyArray<Vec3>, project: Project, px: number, py: number, radiusPx = 9
): number | undefined => {
  let best: number | undefined
  let bestD = radiusPx
  points.forEach((p, i) => {
    const s = project(p)
    if (!s) return
    const d = Math.hypot(s[0] - px, s[1] - py)
    if (d <= bestD) { bestD = d; best = i }
  })
  return best
}
