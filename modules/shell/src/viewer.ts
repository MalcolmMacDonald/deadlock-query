import { Effect, Layer } from "effect"
import { MockMapDataService, type ModuleDefinition } from "@deadlock-query/contracts"

const VIEWER_PANEL_ID = "viewer.main"

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
          void import("@deadlock-query/map-viewer").then(async (v) => {
            const data = await Effect.runPromise(v.loadViewerData.pipe(Effect.provide(MockMapDataService)))
            if (cancelled) return
            dispose = v.makeViewerPanel(data).mount(container)
          }).catch((e) => {
            container.textContent = `Map failed to load: ${String(e)}`
          })
          return () => { cancelled = true; dispose() }
        },
      },
    },
  ],
}
