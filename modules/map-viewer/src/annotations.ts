import * as THREE from "three"
import type {
  Annotation, AnnotationDocument, AnnotationKind, AnnotationLayer as DocumentLayer, OverlayFeature, OverlayStyle, Vec3
} from "@deadlock-query/contracts"

/**
 * The annotation model is the contracts `Annotation` (geometry is world-space Source units, Z-up, same as overlays);
 * the store holds exactly what import/export and autosave read and write.
 */
export type { Annotation, AnnotationKind, DocumentLayer }

/** An annotation before the store assigns its id. */
export type NewAnnotation = Annotation extends infer A ? (A extends unknown ? Omit<A, "id"> : never) : never

export const SOURCE_UNIT_METRES = 0.0254

const MAX_HISTORY = 200

/** Document of annotations with a linear undo/redo history; each edit is one history step. */
export class AnnotationStore {
  private doc: ReadonlyArray<Annotation> = []
  private docLayers: AnnotationDocument["layers"]
  private past: Array<ReadonlyArray<Annotation>> = []
  private future: Array<ReadonlyArray<Annotation>> = []
  private nextId = 1
  /** Document before a live edit began; set while a drag is in progress. */
  private editBase: ReadonlyArray<Annotation> | undefined
  private readonly listeners = new Set<() => void>()

  get annotations(): ReadonlyArray<Annotation> { return this.doc }
  /** Document-level layer definitions carried through an import so an export does not drop them. */
  get layers(): AnnotationDocument["layers"] { return this.docLayers }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** True between the first `edit` and its `commitEdit` / `cancelEdit`. */
  get editing(): boolean { return this.editBase !== undefined }

  /**
   * Live edit (a vertex drag): replaces annotation `next.id` without touching history. The whole gesture becomes one
   * undo step on `commitEdit`; `cancelEdit` puts the document back.
   */
  edit(next: Annotation): boolean {
    const i = this.doc.findIndex((a) => a.id === next.id)
    if (i < 0) return false
    this.editBase ??= this.doc
    this.doc = this.doc.map((a, k) => (k === i ? next : a))
    this.emit()
    return true
  }

  commitEdit() {
    const base = this.editBase
    if (!base) return
    this.editBase = undefined
    if (this.doc === base) return
    this.past.push(base)
    if (this.past.length > MAX_HISTORY) this.past.shift()
    this.future = []
    this.emit()
  }

  cancelEdit() {
    const base = this.editBase
    if (!base) return
    this.editBase = undefined
    this.doc = base
    this.emit()
  }

  /** One-step replacement of a single annotation (insert / delete vertex, recolour). */
  update(next: Annotation): boolean {
    this.commitEdit()
    const i = this.doc.findIndex((a) => a.id === next.id)
    if (i < 0) return false
    this.commit(this.doc.map((a, k) => (k === i ? next : a)))
    return true
  }

  add(a: NewAnnotation): Annotation {
    this.commitEdit()
    const made = { ...a, id: this.freshId() } as Annotation
    this.commit([...this.doc, made])
    return made
  }

  /** Replaces the whole document as one undoable step (import). */
  replace(annotations: ReadonlyArray<Annotation>, layers?: AnnotationDocument["layers"]) {
    this.commitEdit()
    this.docLayers = layers
    this.commit(annotations)
    this.bumpIds(annotations)
  }

  /** Replaces the document and forgets history (restoring autosave, where there is nothing to undo back to). */
  reset(annotations: ReadonlyArray<Annotation>, layers?: AnnotationDocument["layers"]) {
    this.editBase = undefined
    this.docLayers = layers
    this.past = []
    this.future = []
    this.doc = annotations
    this.bumpIds(annotations)
    this.emit()
  }

  private freshId(): string {
    const taken = new Set(this.doc.map((a) => a.id))
    let id = `a${this.nextId++}`
    while (taken.has(id)) id = `a${this.nextId++}`
    return id
  }

  /** Keeps generated ids clear of imported `a<N>` ids. */
  private bumpIds(annotations: ReadonlyArray<Annotation>) {
    for (const a of annotations) {
      const n = /^a(\d+)$/.exec(a.id)
      if (n) this.nextId = Math.max(this.nextId, Number(n[1]) + 1)
    }
  }

  remove(id: string): boolean { return this.removeMany([id]) }

  /** Removes several annotations as one undo step; false when none of the ids exist. */
  removeMany(ids: ReadonlyArray<string>): boolean {
    this.commitEdit()
    const drop = new Set(ids)
    if (!this.doc.some((a) => drop.has(a.id))) return false
    this.commit(this.doc.filter((a) => !drop.has(a.id)))
    return true
  }

  /** Puts annotations into document layer `layer` (`undefined` = no layer) as one undo step. */
  assignLayer(ids: ReadonlyArray<string>, layer: string | undefined): boolean {
    this.commitEdit()
    const set = new Set(ids)
    let changed = false
    const next = this.doc.map((a) => {
      if (!set.has(a.id) || a.layer === layer) return a
      changed = true
      const { layer: _old, ...rest } = a
      return (layer === undefined ? rest : { ...rest, layer }) as Annotation
    })
    if (!changed) return false
    this.commit(next)
    return true
  }

  /** Replaces the document layer definitions (visibility, lock, colour). Layer settings are not part of undo history. */
  setLayers(layers: AnnotationDocument["layers"]) {
    this.docLayers = layers
    this.emit()
  }

  /** Adds a document layer with a fresh id; returns it. */
  addLayer(name?: string): DocumentLayer {
    const layers = this.docLayers ?? []
    let n = layers.length + 1
    while (layers.some((l) => l.id === `L${n}`)) n++
    const layer: DocumentLayer = { id: `L${n}`, name: name?.trim() || `Layer ${n}`, visible: true, locked: false }
    this.setLayers([...layers, layer])
    return layer
  }

  patchLayer(id: string, p: Partial<Pick<DocumentLayer, "name" | "visible" | "locked" | "color">>) {
    const layers = this.docLayers
    if (!layers?.some((l) => l.id === id)) return
    this.setLayers(layers.map((l) => (l.id === id ? { ...l, ...p } : l)))
  }

  undo(): boolean {
    this.commitEdit()
    const prev = this.past.pop()
    if (!prev) return false
    this.future.push(this.doc)
    this.doc = prev
    this.emit()
    return true
  }

  redo(): boolean {
    this.commitEdit()
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
    case "label": return `label "${a.text}"`
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

/** Overlay layers made from annotations all have ids under this prefix. */
export const isAnnotationLayerId = (id: string): boolean => id.startsWith("ann.")

/**
 * Normalises a CSS colour string (`#rgb`, `#rrggbb`, a CSS colour name, `rgb()`/`hsl()`) to `#rrggbb`; undefined when
 * it is not a colour, so a bad `Annotation.color` falls back to the kind's default instead of drawing black.
 */
export const normalizeColor = (css: string | undefined): string | undefined => {
  if (css === undefined) return undefined
  const s = css.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (hex) {
    const h = hex[1]!
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`
  }
  const named = (THREE.Color.NAMES as Record<string, number>)[s]
  if (named !== undefined) return `#${named.toString(16).padStart(6, "0")}`
  if (/^(rgb|hsl)a?\([^)]*\)$/.test(s)) return `#${new THREE.Color().setStyle(s).getHexString()}`
  return undefined
}

/** Colour an annotation is drawn in: its own `color`, else its document layer's, else the kind's default (undefined). */
export const annotationColor = (a: Annotation, layers: AnnotationDocument["layers"]): string | undefined =>
  normalizeColor(a.color) ?? normalizeColor(layers?.find((l) => l.id === a.layer)?.color)

const layerOf = (a: Annotation, layers: AnnotationDocument["layers"]): DocumentLayer | undefined =>
  a.layer === undefined ? undefined : layers?.find((l) => l.id === a.layer)

/** True when the annotation sits in a document layer that is locked: it cannot be selected, edited or deleted. */
export const isLocked = (a: Annotation, layers: AnnotationDocument["layers"]): boolean => layerOf(a, layers)?.locked === true

/** True when the annotation's document layer is switched off (`visible: false`): it is neither drawn nor picked. */
export const isHidden = (a: Annotation, layers: AnnotationDocument["layers"]): boolean => layerOf(a, layers)?.visible === false

const toFeature = (a: Annotation): OverlayFeature => {
  switch (a.kind) {
    case "point": return { type: "point", at: a.points[0]! }
    case "label": return { type: "point", at: a.points[0]!, label: a.text }
    case "polyline": return { type: "polyline", points: a.points }
    case "measure": return { type: "polyline", points: a.points, label: formatMeasurement(measure(a.points)) }
    case "polygon": return { type: "polygon", ring: a.points }
  }
}

const KINDS = Object.keys(KIND_LAYER) as AnnotationKind[]

/**
 * Overlay layers for the annotations: one per kind and colour. Annotations without a colour share the kind's layer
 * (`ann.lines`); each distinct colour gets `ann.lines.<rrggbb>`, so ids stay stable as annotations come and go.
 * Feature ids are `<layerId>:<index>`. Pass the document's `layers` so layer colours are honoured.
 */
export const annotationLayers = (
  doc: ReadonlyArray<Annotation>, layers?: AnnotationDocument["layers"]
): ReadonlyArray<AnnotationLayer> => {
  const out: AnnotationLayer[] = []
  for (const kind of KINDS) {
    const spec = KIND_LAYER[kind]
    const groups = new Map<string | undefined, Annotation[]>()
    for (const a of doc) {
      if (a.kind !== kind || isHidden(a, layers)) continue
      const c = annotationColor(a, layers)
      groups.set(c, [...(groups.get(c) ?? []), a])
    }
    // Default colour first, then colours in order of first use.
    const keys = [...(groups.has(undefined) ? [undefined] : []), ...[...groups.keys()].filter((k) => k !== undefined)]
    for (const color of keys) {
      const items = groups.get(color)!
      out.push({
        id: color === undefined ? spec.id : `${spec.id}.${color.slice(1)}`,
        label: color === undefined ? spec.label : `${spec.label} ${color}`,
        style: color === undefined ? spec.style : { ...spec.style, color },
        features: items.map(toFeature),
        annotationIds: items.map((a) => a.id)
      })
    }
  }
  return out
}

/** Annotation behind an overlay feature id (`ann.lines:2`), if the id belongs to an annotation layer. */
export const annotationIdForFeature = (
  doc: ReadonlyArray<Annotation>, featureId: string, layers?: AnnotationDocument["layers"]
): string | undefined => {
  const i = featureId.lastIndexOf(":")
  if (i < 0) return undefined
  const layer = annotationLayers(doc, layers).find((l) => l.id === featureId.slice(0, i))
  return layer?.annotationIds[Number(featureId.slice(i + 1))]
}

export const featureIdForAnnotation = (
  doc: ReadonlyArray<Annotation>, annotationId: string, layers?: AnnotationDocument["layers"]
): string | undefined => {
  for (const l of annotationLayers(doc, layers)) {
    const i = l.annotationIds.indexOf(annotationId)
    if (i >= 0) return `${l.id}:${i}`
  }
  return undefined
}
