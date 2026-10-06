import { Effect, Layer, PubSub, Stream } from "effect"
import {
  ViewerService, type OverlayFeature, type OverlayStyle, type Vec3, type ViewerEvent
} from "@deadlock-query/contracts"
import { eyeOf, poseFromEye, type CameraPose } from "./camera.ts"
import {
  ANNOTATION_LAYER_IDS, AnnotationStore, annotationIdForFeature, annotationLayers, featureIdForAnnotation
} from "./annotations.ts"
import { LayerStore, type LayerAppearance } from "./layers.ts"
import { ToolMachine } from "./tools.ts"
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

  /** Layers panel state (visibility, colour, opacity, order) for every overlay layer, annotations included. */
  readonly layers = new LayerStore()
  readonly annotations = new AnnotationStore()
  readonly tools = new ToolMachine((a) => { this.annotations.add(a) })
  private selectedId: string | undefined
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
    this.tools.subscribe(() => this.surface?.setDraft(this.tools.draft()))
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

  get selectedAnnotation(): string | undefined { return this.selectedId }

  onSelectionChange(fn: () => void): () => void {
    this.selectionListeners.add(fn)
    return () => { this.selectionListeners.delete(fn) }
  }

  /** Selects an annotation (or clears with `undefined`) and highlights it; shares the viewer's one highlight slot. */
  selectAnnotation(id: string | undefined) {
    this.selectedId = id
    const fid = id ? featureIdForAnnotation(this.annotations.annotations, id) : undefined
    this.highlight(fid ? [fid] : [])
    for (const fn of [...this.selectionListeners]) fn()
  }

  /** Selects the annotation under an overlay feature id; other layers' ids are ignored. */
  selectFeature(featureId: string) {
    const id = annotationIdForFeature(this.annotations.annotations, featureId)
    if (id) this.selectAnnotation(id)
  }

  deleteSelected(): boolean {
    const id = this.selectedId
    if (!id || !this.annotations.remove(id)) return false
    return true
  }

  private syncAnnotations() {
    const doc = this.annotations.annotations
    const live = annotationLayers(doc)
    for (const id of ANNOTATION_LAYER_IDS) {
      const l = live.find((x) => x.id === id)
      if (l) this.setOverlay(l.id, l.features, l.style, l.label)
      else if (this.overlays.has(id)) this.removeOverlay(id)
    }
    if (this.selectedId && !doc.some((a) => a.id === this.selectedId)) this.selectAnnotation(undefined)
    else if (this.selectedId) this.selectAnnotation(this.selectedId)
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
