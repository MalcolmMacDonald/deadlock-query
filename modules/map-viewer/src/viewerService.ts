import { Effect, Layer, PubSub, Stream } from "effect"
import {
  ViewerService, type OverlayFeature, type OverlayStyle, type Vec3, type ViewerEvent
} from "@deadlock-query/contracts"
import { eyeOf, poseFromEye, type CameraPose } from "./camera.ts"

/** What a mounted panel gives the controller; absent until a panel mounts. */
export interface ViewerSurface {
  readonly setOverlay: (layerId: string, features: ReadonlyArray<Vec3> | ReadonlyArray<OverlayFeature>, style?: OverlayStyle) => void
  readonly removeOverlay: (layerId: string) => void
  readonly highlight: (ids: ReadonlyArray<string>) => void
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

  emit(e: ViewerEvent) { PubSub.publishUnsafe(this.bus, e) }

  attach(surface: ViewerSurface): () => void {
    this.surface = surface
    for (const [id, [f, s]] of this.overlays) surface.setOverlay(id, f, s)
    if (this.highlighted.length) surface.highlight(this.highlighted)
    return () => { if (this.surface === surface) { this.pose = surface.getPose(); this.surface = undefined } }
  }

  setOverlay(id: string, f: ReadonlyArray<Vec3> | ReadonlyArray<OverlayFeature>, s?: OverlayStyle) {
    this.overlays.set(id, [f, s])
    this.surface?.setOverlay(id, f, s)
  }
  removeOverlay(id: string) { this.overlays.delete(id); this.surface?.removeOverlay(id) }
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
