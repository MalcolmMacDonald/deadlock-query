import type { OverlayFeature, OverlayStyle, Vec3 } from "@deadlock-query/contracts"

/**
 * Viewer-local annotation model. The shared `Annotation` contract does not exist yet (see STATE.md "Blockers"), so
 * import/export waits on it; geometry is world-space Source units (Z-up), same as overlays.
 */
export type AnnotationKind = "point" | "label" | "polyline" | "polygon" | "measure"

export interface Annotation {
  readonly id: string
  readonly kind: AnnotationKind
  readonly points: ReadonlyArray<Vec3>
  /** Label text (`label` kind only). */
  readonly text?: string
}

export type NewAnnotation = Omit<Annotation, "id">

export const SOURCE_UNIT_METRES = 0.0254

const MAX_HISTORY = 200

/** Document of annotations with a linear undo/redo history; each edit is one history step. */
export class AnnotationStore {
  private doc: ReadonlyArray<Annotation> = []
  private past: Array<ReadonlyArray<Annotation>> = []
  private future: Array<ReadonlyArray<Annotation>> = []
  private nextId = 1
  private readonly listeners = new Set<() => void>()

  get annotations(): ReadonlyArray<Annotation> { return this.doc }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  add(a: NewAnnotation): Annotation {
    const made: Annotation = { ...a, id: `a${this.nextId++}` }
    this.commit([...this.doc, made])
    return made
  }

  remove(id: string): boolean {
    if (!this.doc.some((a) => a.id === id)) return false
    this.commit(this.doc.filter((a) => a.id !== id))
    return true
  }

  undo(): boolean {
    const prev = this.past.pop()
    if (!prev) return false
    this.future.push(this.doc)
    this.doc = prev
    this.emit()
    return true
  }

  redo(): boolean {
    const next = this.future.pop()
    if (!next) return false
    this.past.push(this.doc)
    this.doc = next
    this.emit()
    return true
  }

  private commit(next: ReadonlyArray<Annotation>) {
    this.past.push(this.doc)
    if (this.past.length > MAX_HISTORY) this.past.shift()
    this.future = []
    this.doc = next
    this.emit()
  }

  private emit() { for (const fn of [...this.listeners]) fn() }
}

export interface Measurement {
  /** Straight-line length along the whole path, Source units. */
  readonly distance: number
  /** Length of the path projected onto the XY plane, Source units. */
  readonly ground: number
  /** Net height change from first to last point, Source units. */
  readonly rise: number
}

export const measure = (pts: ReadonlyArray<Vec3>): Measurement => {
  let distance = 0, ground = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!
    distance += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ground += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return { distance, ground, rise: pts.length > 1 ? pts[pts.length - 1]![2] - pts[0]![2] : 0 }
}

export const formatMeasurement = (m: Measurement): string => {
  const u = (v: number) => `${v.toFixed(1)}u (${(v * SOURCE_UNIT_METRES).toFixed(2)} m)`
  return `3D ${u(m.distance)} · ground ${u(m.ground)} · rise ${u(m.rise)}`
}

/** One-line description for lists. */
export const describe = (a: Annotation): string => {
  switch (a.kind) {
    case "label": return `label "${a.text ?? ""}"`
    case "measure": return `measure ${formatMeasurement(measure(a.points))}`
    case "point": return "point"
    case "polyline": return `polyline (${a.points.length} pts)`
    case "polygon": return `polygon (${a.points.length} pts)`
  }
}

export interface AnnotationLayer {
  readonly id: string
  readonly label: string
  readonly style: OverlayStyle
  readonly features: ReadonlyArray<OverlayFeature>
  /** Annotation id for each entry of `features`. */
  readonly annotationIds: ReadonlyArray<string>
}

const KIND_LAYER: Record<AnnotationKind, { readonly id: string; readonly label: string; readonly style: OverlayStyle }> = {
  point: { id: "ann.points", label: "Annotation points", style: { color: "#ff5ec4", size: 9 } },
  label: { id: "ann.labels", label: "Annotation labels", style: { color: "#7ee8fa", size: 9 } },
  polyline: { id: "ann.lines", label: "Annotation lines", style: { color: "#ff9f43" } },
  polygon: { id: "ann.polygons", label: "Annotation polygons", style: { color: "#a0e86b" } },
  measure: { id: "ann.measures", label: "Measurements", style: { color: "#ffffff", size: 7 } }
}

export const ANNOTATION_LAYER_IDS: ReadonlyArray<string> = Object.values(KIND_LAYER).map((l) => l.id)

const toFeature = (a: Annotation): OverlayFeature => {
  switch (a.kind) {
    case "point": return { type: "point", at: a.points[0]! }
    case "label": return { type: "point", at: a.points[0]!, label: a.text ?? "" }
    case "polyline": return { type: "polyline", points: a.points }
    case "measure": return { type: "polyline", points: a.points, label: formatMeasurement(measure(a.points)) }
    case "polygon": return { type: "polygon", ring: a.points }
  }
}

/** One overlay layer per annotation kind that has entries; feature ids are `<layerId>:<index>`. */
export const annotationLayers = (doc: ReadonlyArray<Annotation>): ReadonlyArray<AnnotationLayer> => {
  const out: AnnotationLayer[] = []
  for (const spec of Object.values(KIND_LAYER)) {
    const kind = (Object.keys(KIND_LAYER) as AnnotationKind[]).find((k) => KIND_LAYER[k] === spec)!
    const items = doc.filter((a) => a.kind === kind)
    if (items.length) out.push({ ...spec, features: items.map(toFeature), annotationIds: items.map((a) => a.id) })
  }
  return out
}

/** Annotation behind an overlay feature id (`ann.lines:2`), if the id belongs to an annotation layer. */
export const annotationIdForFeature = (doc: ReadonlyArray<Annotation>, featureId: string): string | undefined => {
  const i = featureId.lastIndexOf(":")
  if (i < 0) return undefined
  const layer = annotationLayers(doc).find((l) => l.id === featureId.slice(0, i))
  return layer?.annotationIds[Number(featureId.slice(i + 1))]
}

export const featureIdForAnnotation = (doc: ReadonlyArray<Annotation>, annotationId: string): string | undefined => {
  for (const l of annotationLayers(doc)) {
    const i = l.annotationIds.indexOf(annotationId)
    if (i >= 0) return `${l.id}:${i}`
  }
  return undefined
}
