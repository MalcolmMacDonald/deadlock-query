import type { ModuleDefinition } from "@deadlock-query/contracts"
import { Layer } from "effect"
import { ViewerController } from "./viewerService.ts"
import { VIEWER_PANEL_ID, makeViewerPanel, type ViewerData } from "./ViewerPanel.ts"
import { VIEWER_INSPECTOR_PANEL_ID, makeInspectorPanel } from "./inspector.ts"
import { VIEWER_LAYERS_PANEL_ID, VIEWER_TOOLS_PANEL_ID, makeLayersPanel, makeToolsPanel } from "./panels.ts"

export * from "./ViewerPanel.ts"
export * from "./projection.ts"
export * from "./camera.ts"
export * from "./hashState.ts"
export * from "./overlays.ts"
export * from "./layers.ts"
export * from "./surfaces.ts"
export * from "./labels.ts"
export * from "./entities.ts"
export * from "./lanes.ts"
export * from "./ziplines.ts"
export * from "./screenshots.ts"
export * from "./annotations.ts"
export * from "./tools.ts"
export * from "./picking.ts"
export * from "./snapping.ts"
export * from "./vertexEdit.ts"
export * from "./persistence.ts"
export * from "./panels.ts"
export * from "./inspector.ts"
export * from "./viewerService.ts"
export * from "./tiles.ts"
export * from "./tileStreamer.ts"
export * from "./tileDecode.ts"
export { defaultDecoder, DEFAULT_DECODE_WORKERS } from "./defaultDecoder.ts"
export { buildScene, glbToThreeMatrix, makeColoredTerrainMaterial, makeTerrainMaterial, setSurfaceVisible, WORLD_TO_THREE } from "./scene.ts"

export const makeViewerModule = (data: ViewerData, controller = new ViewerController()): ModuleDefinition => ({
  id: "map-viewer",
  // ViewerService cannot ride this layer (typed `Layer<never>`); the shell wires `makeViewerService(controller)`.
  layer: Layer.empty,
  panels: [
    { id: VIEWER_PANEL_ID, title: "Map", component: makeViewerPanel(data, controller), defaultPlacement: "center" },
    { id: VIEWER_LAYERS_PANEL_ID, title: "Layers", component: makeLayersPanel(controller), defaultPlacement: "right" },
    { id: VIEWER_TOOLS_PANEL_ID, title: "Tools", component: makeToolsPanel(controller), defaultPlacement: "left" },
    { id: VIEWER_INSPECTOR_PANEL_ID, title: "Inspector", component: makeInspectorPanel(controller), defaultPlacement: "right" }
  ]
})
export * from "./shotPopup.ts"
