import { Effect, Layer } from "effect"
import { MockMapDataService, MockViewerService, ViewerService, type ModuleDefinition } from "@deadlock-query/contracts"
import type { ViewerController } from "@deadlock-query/map-viewer"

const VIEWER_PANEL_ID = "viewer.main"

const viewerPackage = () => import("@deadlock-query/map-viewer")

let controller: Promise<ViewerController> | undefined
/** The one ViewerController shared by the Map panel and the `ViewerService` layer. */
export const getViewerController = (): Promise<ViewerController> =>
  (controller ??= viewerPackage().then((v) => new v.ViewerController()))

/** Real `ViewerService` backed by the shared controller (loads the viewer chunk before the runtime builds). */
export const viewerServiceLayer: Layer.Layer<ViewerService> = Layer.unwrap(
  Effect.tryPromise(async () => (await viewerPackage()).makeViewerService(await getViewerController())).pipe(
    Effect.orElseSucceed(() => MockViewerService),
  ),
)

/**
 * Map viewer module. Three.js and the mini-map fixture load lazily on first mount so the
 * initial bundle stays small. Real published data replaces the fixture once the extractor
 * emits MapBundles (the data-25712201 release is raw extractor output, not a bundle).
 */
export const viewerModule: ModuleDefinition = {
  id: "map-viewer",
  layer: Layer.empty,
  panels: [
    {
      id: VIEWER_PANEL_ID,
      title: "Map",
      defaultPlacement: "center",
      component: {
        mount: (container: HTMLElement) => {
          let dispose = () => {}
          let cancelled = false
          void viewerPackage().then(async (v) => {
            const data = await Effect.runPromise(v.loadViewerData.pipe(Effect.provide(MockMapDataService)))
            const c = await getViewerController()
            if (cancelled) return
            dispose = v.makeViewerPanel(data, c).mount(container)
          }).catch((e) => {
            container.textContent = `Map failed to load: ${String(e)}`
          })
          return () => { cancelled = true; dispose() }
        },
      },
    },
  ],
}
