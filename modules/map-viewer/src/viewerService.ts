import { Effect, Layer, PubSub, Stream } from "effect"
import {
  ViewerService, type OverlayFeature, type OverlayStyle, type Vec3, type ViewerEvent
} from "@deadlock-query/contracts"
import { eyeOf, poseFromEye, type CameraPose } from "./camera.ts"
import {
  AnnotationStore, annotationIdForFeature, annotationLayers, featureIdForAnnotation, isHidden, isLocked, type Annotation
} from "./annotations.ts"
import { SnapState } from "./snapping.ts"
import { insertVertex, moveVertex, removeVertex } from "./vertexEdit.ts"
import { LayerStore, type LayerAppearance } from "./layers.ts"
import { ToolMachine } from "./tools.ts"
import type { StreamStats } from "./tileStreamer.ts"
import { DEFAULT_COLOR } from "./overlays.ts"
import {
  autosaveKey, indexedDbStorage, parseDocument, serializeDocument, toDocument, type AnnotationStorage, type MapIdentity, type ParsedDocument
} from "./persistence.ts"

const AUTOSAVE_DELAY_MS = 400

/** What a mounted panel gives the controller; absent until a panel mounts. */
export interface ViewerSurface {
  readonly setOverlay: (layerId: string, features: ReadonlyArray<Vec3> | ReadonlyArray<OverlayFeature>, style?: OverlayStyle) => void
  readonly removeOverlay: (layerId: string) => void
  readonly highlight: (ids: ReadonlyArray<string>) => void
  readonly setAppearance: (layerId: string, a: LayerAppearance) => void
  readonly setDraft: (features: ReadonlyArray<OverlayFeature>) => void
  /** Vertex handles of the selected annotation (`active` is the selected vertex). Empty clears them. */
  readonly setHandles: (points: ReadonlyArray<Vec3>, active: number | undefined) => void
  readonly getPose: () => CameraPose
  readonly setPose: (pose: CameraPose) => void
  readonly capture: () => Promise<Uint8Array>
  readonly loadBundle: (manifestUrl: string) => Promise<void>
}

const DEFAULT_POSE: CameraPose = { target: [0, 0, 0], yaw: 0, pitch: -1.55, distance: 1000 }

/**
 * Owns viewer state that must outlive a panel mount: overlays, highlight and pose are remembered and replayed
 * onto the next surface, so `ViewerService` calls made before the panel mounts are not lost.
 */
export class ViewerController {
  private surface: ViewerSurface | undefined
  private readonly overlays = new Map<string, readonly [ReadonlyArray<Vec3> | ReadonlyArray<OverlayFeature>, OverlayStyle | undefined]>()
  private highlighted: ReadonlyArray<string> = []
  private pose: CameraPose = DEFAULT_POSE
  private readonly bus = Effect.runSync(PubSub.sliding<ViewerEvent>(256))

  readonly events: Stream.Stream<ViewerEvent> = Stream.fromPubSub(this.bus)

  private readonly progressBus = Effect.runSync(PubSub.sliding<StreamStats>(64))
  private latestStats: StreamStats | undefined
  /** Tile streaming progress: one value whenever loading, residency or eviction changes (none for eagerly loaded maps). */
  readonly progress: Stream.Stream<StreamStats> = Stream.fromPubSub(this.progressBus)
  /** Latest streaming stats, if the map is streamed. */
  get tileStats(): StreamStats | undefined { return this.latestStats }
  emitProgress(s: StreamStats) { this.latestStats = s; PubSub.publishUnsafe(this.progressBus, s) }

  /** Layers panel state (visibility, colour, opacity, order) for every overlay layer, annotations included. */
  readonly layers = new LayerStore()
  readonly annotations = new AnnotationStore()
  readonly tools = new ToolMachine((a) => {
    this.annotations.add(this.activeLayerId === undefined ? a : ({ ...a, layer: this.activeLayerId } as typeof a))
  })
  /** Snap-to-surface/vertex/feature switches for the annotation tools. */
  readonly snapping = new SnapState()
  private selectedIds: ReadonlyArray<string> = []
  private activeLayerId: string | undefined
  private selectedVertexIndex: number | undefined
  private liveAnnotationLayers = new Set<string>()
  private map: MapIdentity = {}
  private storage: AnnotationStorage | undefined
  private autosaveReady = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private autosaveDelay = AUTOSAVE_DELAY_MS
  private readonly selectionListeners = new Set<() => void>()

  constructor() {
    this.layers.subscribe(() => {
      for (const l of this.layers.list()) this.surface?.setAppearance(l.id, this.layers.appearance(l.id))
    })
    this.tools.subscribe(() => { this.surface?.setDraft(this.tools.draft()); this.syncHandles() })
    this.annotations.subscribe(() => { this.syncAnnotations(); this.scheduleSave() })
  }

  get mapIdentity(): MapIdentity { return this.map }

  /** Records which map is shown; annotations are exported with it and autosaved under its name. */
  setMap(map: MapIdentity) {
    const changed = autosaveKey(map) !== autosaveKey(this.map)
    this.map = map
    if (this.storage && (changed || !this.autosaveReady)) void this.restore()
  }

  /** Turns on autosave (debounced) to `storage` and restores the saved document for the current map, if any. */
  useStorage(storage: AnnotationStorage | undefined, delayMs = AUTOSAVE_DELAY_MS) {
    this.storage = storage
    this.autosaveDelay = delayMs
    this.autosaveReady = false
    if (storage && this.map.mapName !== undefined) void this.restore()
  }

  /** Autosaves to IndexedDB unless a storage was already chosen (no-op where IndexedDB is unavailable). */
  useDefaultStorage() {
    if (!this.storage) this.useStorage(indexedDbStorage())
  }

  /** Current annotations as a schema-valid `AnnotationDocument` serialized to JSON. */
  exportJson(): string {
    return serializeDocument(toDocument(this.annotations.annotations, this.annotations.layers, this.map))
  }

  /** Replaces the annotations with an exported document (one undoable step); returns why it was refused, if so. */
  importJson(text: string): ParsedDocument {
    const parsed = parseDocument(text, this.map)
    if (parsed.ok) {
      this.annotations.replace(parsed.doc.annotations, parsed.doc.layers)
      this.selectAnnotation(undefined)
    }
    return parsed
  }

  /** Writes the autosave now instead of waiting for the debounce. */
  async flushAutosave(): Promise<void> {
    if (this.saveTimer !== undefined) { clearTimeout(this.saveTimer); this.saveTimer = undefined }
    const storage = this.storage
    if (!storage || !this.autosaveReady) return
    await storage.save(autosaveKey(this.map), this.exportJson()).catch(() => undefined)
  }

  private scheduleSave() {
    if (!this.storage || !this.autosaveReady) return
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.flushAutosave() }, this.autosaveDelay)
  }

  /** Loads the autosave for the current map unless the user already drew something; saving starts afterwards. */
  private async restore() {
    const storage = this.storage
    const key = autosaveKey(this.map)
    const before = this.annotations.annotations
    this.autosaveReady = false
    let saved: string | undefined
    try { saved = await storage?.load(key) } catch { saved = undefined }
    if (this.storage !== storage || autosaveKey(this.map) !== key) return
    const untouched = this.annotations.annotations === before
    const parsed = saved !== undefined && untouched ? parseDocument(saved) : undefined
    if (parsed?.ok) {
      this.annotations.reset(parsed.doc.annotations, parsed.doc.layers)
      this.selectAnnotation(undefined)
    }
    this.autosaveReady = true
    if (!untouched) this.scheduleSave()
  }

  emit(e: ViewerEvent) { PubSub.publishUnsafe(this.bus, e) }

  attach(surface: ViewerSurface): () => void {
    this.surface = surface
    for (const l of this.layers.list()) surface.setAppearance(l.id, this.layers.appearance(l.id))
    for (const [id, [f, s]] of this.overlays) surface.setOverlay(id, f, s)
    surface.setDraft(this.tools.draft())
    this.syncHandles()
    if (this.highlighted.length) surface.highlight(this.highlighted)
    return () => { if (this.surface === surface) { this.pose = surface.getPose(); this.surface = undefined } }
  }

  setOverlay(id: string, f: ReadonlyArray<Vec3> | ReadonlyArray<OverlayFeature>, s?: OverlayStyle, label?: string) {
    this.overlays.set(id, [f, s])
    this.layers.ensure(id, { baseColor: s?.color ?? DEFAULT_COLOR, ...(label ? { label } : {}) })
    // Appearance first so a layer is never drawn once with default look.
    this.surface?.setAppearance(id, this.layers.appearance(id))
    this.surface?.setOverlay(id, f, s)
  }
  removeOverlay(id: string) {
    this.overlays.delete(id)
    this.surface?.removeOverlay(id)
    this.layers.drop(id)
  }

  /** Primary selection (the last one added); vertex editing only applies when exactly one annotation is selected. */
  get selectedAnnotation(): string | undefined { return this.selectedIds[this.selectedIds.length - 1] }

  /** Every selected annotation id, in selection order. */
  get selection(): ReadonlyArray<string> { return this.selectedIds }

  onSelectionChange(fn: () => void): () => void {
    this.selectionListeners.add(fn)
    return () => { this.selectionListeners.delete(fn) }
  }

  /** Whether the annotation is in a locked document layer (it then cannot be selected or changed). */
  isLocked(id: string): boolean {
    const a = this.annotations.annotations.find((x) => x.id === id)
    return a !== undefined && isLocked(a, this.annotations.layers)
  }

  private selectable(a: Annotation): boolean {
    const layers = this.annotations.layers
    return !isLocked(a, layers) && !isHidden(a, layers)
  }

  /**
   * Replaces the selection. Unknown ids, annotations in locked or hidden layers and duplicates are dropped. The
   * selection is shown through the viewer's single highlight slot, so it replaces any query highlight until cleared.
   */
  setSelection(ids: ReadonlyArray<string>) {
    const doc = this.annotations.annotations
    const next = [...new Set(ids)].filter((id) => { const a = doc.find((x) => x.id === id); return a !== undefined && this.selectable(a) })
    const same = next.length === this.selectedIds.length && next.every((id, i) => id === this.selectedIds[i])
    if (next.length !== 1 || next[0] !== this.selectedIds[0] || this.selectedIds.length !== 1) this.selectedVertexIndex = undefined
    this.selectedIds = next
    const layers = this.annotations.layers
    this.highlight(next.flatMap((id) => featureIdForAnnotation(doc, id, layers) ?? []))
    this.syncHandles()
    if (!same) for (const fn of [...this.selectionListeners]) fn()
  }

  /** Selects one annotation (or clears with `undefined`). */
  selectAnnotation(id: string | undefined) { this.setSelection(id ? [id] : []) }

  /** Adds the annotation to the selection, or removes it when already selected. */
  toggleAnnotation(id: string) {
    this.setSelection(this.selectedIds.includes(id) ? this.selectedIds.filter((x) => x !== id) : [...this.selectedIds, id])
  }

  /** Selects the annotation under an overlay feature id (`additive`: toggle it in the selection); other layers' ids are ignored. */
  selectFeature(featureId: string, additive = false) {
    const id = annotationIdForFeature(this.annotations.annotations, featureId, this.annotations.layers)
    if (!id) return
    if (additive) this.toggleAnnotation(id)
    else this.selectAnnotation(id)
  }

  /** Selects every annotation that can be selected (not locked, not hidden). */
  selectAll() {
    this.setSelection(this.annotations.annotations.filter((a) => this.selectable(a)).map((a) => a.id))
  }

  /** Deletes the whole selection as one undo step. */
  deleteSelected(): boolean {
    return this.selectedIds.length > 0 && this.annotations.removeMany(this.selectedIds)
  }

  /** Document layer new annotations are drawn into (`undefined`: none). */
  get activeLayer(): string | undefined { return this.activeLayerId }

  /** Refuses layers that do not exist or are locked/hidden, since nothing drawn there could be edited afterwards. */
  setActiveLayer(id: string | undefined): boolean {
    if (id !== undefined) {
      const l = this.annotations.layers?.find((x) => x.id === id)
      if (!l || l.locked === true || l.visible === false) return false
    }
    this.activeLayerId = id
    for (const fn of [...this.selectionListeners]) fn()
    return true
  }

  /** Moves the selected annotations into layer `layer` (`undefined`: out of any layer). */
  moveSelectionToLayer(layer: string | undefined): boolean {
    if (layer !== undefined && !this.annotations.layers?.some((l) => l.id === layer)) return false
    return this.annotations.assignLayer(this.selectedIds, layer)
  }

  /** Vertex of the selected annotation that Delete removes and a drag moves. */
  get selectedVertex(): number | undefined { return this.selectedVertexIndex }

  selectVertex(index: number | undefined) {
    if (index === this.selectedVertexIndex) return
    this.selectedVertexIndex = index
    this.syncHandles()
    for (const fn of [...this.selectionListeners]) fn()
  }

  /** The selected annotation when exactly one is selected (vertex editing works on that one only). */
  private selected() {
    const id = this.selectedIds.length === 1 ? this.selectedIds[0] : undefined
    return id ? this.annotations.annotations.find((a) => a.id === id) : undefined
  }

  /** Vertices the user can grab: those of the selected annotation, only while the Select tool is active. */
  vertexHandles(): ReadonlyArray<Vec3> {
    return this.tools.tool === "select" ? this.selected()?.points ?? [] : []
  }

  private syncHandles() {
    const pts = this.vertexHandles()
    if (this.selectedVertexIndex !== undefined && this.selectedVertexIndex >= pts.length) this.selectedVertexIndex = undefined
    this.surface?.setHandles(pts, this.selectedVertexIndex)
  }

  /** Live drag of the selected annotation's vertex; nothing is undoable until `commitVertexEdit`. */
  moveVertex(index: number, to: Vec3): boolean {
    const a = this.selected()
    return a !== undefined && this.annotations.edit(moveVertex(a, index, to))
  }
  commitVertexEdit() { this.annotations.commitEdit() }
  cancelVertexEdit() { this.annotations.cancelEdit() }

  /** Adds a vertex after `after` on the selected polyline/polygon and selects it. */
  insertVertexAfter(after: number, at: Vec3): boolean {
    const a = this.selected()
    const next = a && insertVertex(a, after, at)
    if (!next || !this.annotations.update(next)) return false
    this.selectVertex(after + 1)
    return true
  }

  /**
   * Delete on a selected vertex removes it; a shape already at its minimum (and a single-point annotation) is deleted
   * whole instead. Without a selected vertex it deletes the annotation.
   */
  deleteVertexOrSelected(): boolean {
    const a = this.selected()
    const i = this.selectedVertexIndex
    if (a && i !== undefined) {
      const next = removeVertex(a, i)
      if (next && this.annotations.update(next)) { this.selectVertex(undefined); return true }
    }
    return this.deleteSelected()
  }

  private syncAnnotations() {
    const doc = this.annotations.annotations
    const live = annotationLayers(doc, this.annotations.layers)
    const liveIds = new Set(live.map((l) => l.id))
    for (const id of [...this.liveAnnotationLayers]) if (!liveIds.has(id)) this.removeOverlay(id)
    this.liveAnnotationLayers = liveIds
    for (const l of live) this.setOverlay(l.id, l.features, l.style, l.label)
    if (this.activeLayerId !== undefined) {
      const l = this.annotations.layers?.find((x) => x.id === this.activeLayerId)
      if (!l || l.locked === true || l.visible === false) this.activeLayerId = undefined
    }
    this.setSelection(this.selectedIds)
  }
  highlight(ids: ReadonlyArray<string>) { this.highlighted = ids; this.surface?.highlight(ids) }
  getPose(): CameraPose { return this.surface?.getPose() ?? this.pose }
  setPose(p: CameraPose) { this.pose = p; this.surface?.setPose(p) }
  capture(): Promise<Uint8Array> { return this.surface ? this.surface.capture() : Promise.reject(new Error("viewer panel is not mounted")) }
  loadBundle(url: string): Promise<void> { return this.surface ? this.surface.loadBundle(url) : Promise.reject(new Error("viewer panel is not mounted")) }
}

export const makeViewerService = (c: ViewerController): Layer.Layer<ViewerService> =>
  Layer.succeed(ViewerService)({
    loadBundle: (url) => Effect.tryPromise({ try: () => c.loadBundle(url), catch: (e) => e instanceof Error ? e : new Error(String(e)) }),
    getCamera: Effect.sync(() => { const p = c.getPose(); return { position: eyeOf(p), target: p.target } }),
    setCamera: (position, target) => Effect.sync(() => c.setPose(poseFromEye(position, target))),
    flyTo: (target, distance) => Effect.sync(() => { const p = c.getPose(); c.setPose({ ...p, target, distance: distance ?? p.distance }) }),
    setOverlay: (id, f, s) => Effect.sync(() => c.setOverlay(id, f, s)),
    removeOverlay: (id) => Effect.sync(() => c.removeOverlay(id)),
    highlight: (ids) => Effect.sync(() => c.highlight(ids)),
    events: c.events,
    captureImage: Effect.tryPromise({ try: () => c.capture(), catch: (e) => e instanceof Error ? e : new Error(String(e)) })
  })
