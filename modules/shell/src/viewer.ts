import { Effect, Layer } from "effect"
import { MockMapDataService, MockViewerService, ViewerService, type ModuleDefinition } from "@deadlock-query/contracts"
import type { ViewerController } from "@deadlock-query/map-viewer"

const VIEWER_PANEL_ID = "viewer.main"
const LAYERS_PANEL_ID = "viewer.layers"
const TOOLS_PANEL_ID = "viewer.tools"

/** Where the deploy unzips the published bundle (`tools/fetch-data.ts` → `<site>/data/<map>`). */
export const BUNDLE_MANIFEST_URL = "./data/dl_midtown/manifest.json"

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

/** Mounts a map-viewer side panel built over the shared controller (the viewer chunk loads lazily). */
const sidePanel = (make: (v: Awaited<ReturnType<typeof viewerPackage>>, c: ViewerController) => { mount: (container: HTMLElement) => () => void }) => ({
  mount: (container: HTMLElement) => {
    let dispose = () => {}
    let cancelled = false
    void Promise.all([viewerPackage(), getViewerController()]).then(([v, c]) => {
      if (!cancelled) dispose = make(v, c).mount(container)
    }).catch((e) => {
      container.textContent = `Panel failed to load: ${String(e)}`
    })
    return () => { cancelled = true; dispose() }
  },
})

/**
 * Map viewer module. Three.js and the mini-map fixture load lazily on first mount so the
 * initial bundle stays small. The zipped bundle published to the data Release (unzipped into
 * `./data/<map>` at deploy) is loaded over the fixture; the fixture remains the fallback.
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
            // Prefer the published bundle; keep the fixture when it is absent (local dev, no fetch-data).
            await c.loadBundle(BUNDLE_MANIFEST_URL).catch((e) => console.warn("bundle not loaded, using fixture:", e))
          }).catch((e) => {
            container.textContent = `Map failed to load: ${String(e)}`
          })
          return () => { cancelled = true; dispose() }
        },
      },
    },
    { id: TOOLS_PANEL_ID, title: "Tools", defaultPlacement: "left", component: sidePanel((v, c) => v.makeToolsPanel(c)) },
    { id: LAYERS_PANEL_ID, title: "Layers", defaultPlacement: "left", component: sidePanel((v, c) => v.makeLayersPanel(c)) },
  ],
}
