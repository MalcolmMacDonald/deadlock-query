import type { PanelDefinition } from "@deadlock-query/contracts"

type Direction = "left" | "right" | "above" | "below" | "within"

export interface PresetPanel {
  readonly id: string
  readonly title: string
  /** Placement relative to the previously placed panel; the first panel has none. */
  readonly position?: { readonly referencePanel: string; readonly direction: Direction }
  readonly initialWidth?: number
}

/** Initial width in px of the editor column in the default "Query" layout. */
export const EDITOR_WIDTH = 520
/** Initial width in px of the tools/layers column left of the map. */
export const SIDEBAR_WIDTH = 220

/**
 * The default "Query" preset: tools (with layers below) docked left of the map viewer, query editor + results docked right.
 * Built only from the registered `panels`, so the layout never references a missing panel.
 */
export const queryPreset = (panels: ReadonlyArray<PanelDefinition>): ReadonlyArray<PresetPanel> => {
  const byId = new Map(panels.map((p) => [p.id, p]))
  const viewer = byId.get("viewer.main")
  const editor = byId.get("query.editor")
  const tools = byId.get("viewer.tools")
  const layers = byId.get("viewer.layers")
  const rest = panels.filter((p) => p !== viewer && p !== editor && p !== tools && p !== layers)
  const out: PresetPanel[] = []
  if (viewer) out.push({ id: viewer.id, title: viewer.title })
  if (tools)
    out.push({
      id: tools.id,
      title: tools.title,
      ...(viewer ? { position: { referencePanel: viewer.id, direction: "left" as const } } : {}),
      initialWidth: SIDEBAR_WIDTH,
    })
  if (layers) {
    const anchor = tools ?? viewer
    out.push({
      id: layers.id,
      title: layers.title,
      ...(anchor ? { position: { referencePanel: anchor.id, direction: tools ? ("below" as const) : ("left" as const) } } : {}),
      ...(!tools ? { initialWidth: SIDEBAR_WIDTH } : {}),
    })
  }
  if (editor)
    out.push({
      id: editor.id,
      title: editor.title,
      ...(viewer ? { position: { referencePanel: viewer.id, direction: "right" as const } } : {}),
      initialWidth: EDITOR_WIDTH,
    })
  // Anything else (dummy/demo modules) is split below the viewer so it stays visible.
  for (const p of rest) out.push({ id: p.id, title: p.title, ...(viewer ? { position: { referencePanel: viewer.id, direction: "below" as const } } : {}) })
  return out
}
