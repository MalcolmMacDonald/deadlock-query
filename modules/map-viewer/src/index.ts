import type { ModuleDefinition } from "@deadlock-query/contracts"
import { Layer } from "effect"
import { ViewerController } from "./viewerService.ts"
import { VIEWER_PANEL_ID, makeViewerPanel, type ViewerData } from "./ViewerPanel.ts"

export * from "./ViewerPanel.ts"
export * from "./projection.ts"
export * from "./camera.ts"
export * from "./hashState.ts"
export * from "./overlays.ts"
export * from "./viewerService.ts"
export { buildScene, glbToThreeMatrix, WORLD_TO_THREE } from "./scene.ts"

export const makeViewerModule = (data: ViewerData, controller = new ViewerController()): ModuleDefinition => ({
  id: "map-viewer",
  // ViewerService cannot ride this layer (typed `Layer<never>`); the shell wires `makeViewerService(controller)`.
  layer: Layer.empty,
  panels: [{ id: VIEWER_PANEL_ID, title: "Map", component: makeViewerPanel(data, controller), defaultPlacement: "center" }]
})
