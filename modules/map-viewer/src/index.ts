import { Layer } from "effect"
import type { ModuleDefinition } from "@deadlock-query/contracts"
import { VIEWER_PANEL_ID, makeViewerPanel, type ViewerData } from "./ViewerPanel.ts"

export * from "./ViewerPanel.ts"
export * from "./projection.ts"

export const makeViewerModule = (data: ViewerData): ModuleDefinition => ({
  id: "map-viewer",
  layer: Layer.empty,
  panels: [{ id: VIEWER_PANEL_ID, title: "Map", component: makeViewerPanel(data), defaultPlacement: "center" }]
})
