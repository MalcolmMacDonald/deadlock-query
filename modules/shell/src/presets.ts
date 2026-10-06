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

/**
 * The default "Query" preset: map viewer filling the left, query editor + results docked right.
 * Built only from the registered `panels`, so the layout never references a missing panel.
 */
export const queryPreset = (panels: ReadonlyArray<PanelDefinition>): ReadonlyArray<PresetPanel> => {
  const byId = new Map(panels.map((p) => [p.id, p]))
  const viewer = byId.get("viewer.main")
  const editor = byId.get("query.editor")
  const rest = panels.filter((p) => p !== viewer && p !== editor)
  const out: PresetPanel[] = []
  if (viewer) out.push({ id: viewer.id, title: viewer.title })
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
