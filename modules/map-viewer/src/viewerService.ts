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
  private readonly selectionListeners = new Set<() => void>()

  constructor() {
    this.layers.subscribe(() => {
      for (const l of this.layers.list()) this.surface?.setAppearance(l.id, this.layers.appearance(l.id))
    })
    this.tools.subscribe(() => this.surface?.setDraft(this.tools.draft()))
    this.annotations.subscribe(() => this.syncAnnotations())
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
