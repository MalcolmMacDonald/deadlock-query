import type { PanelDefinition } from "@deadlock-query/contracts"

type Direction = "left" | "right" | "above" | "below" | "within"

export interface PresetPanel {
  readonly id: string
  readonly title: string
  /** Placement relative to the previously placed panel; the first panel has none. */
  readonly position?: { readonly referencePanel: string; readonly direction: Direction }
  readonly initialWidth?: number
  readonly initialHeight?: number
  /** Added to its group without taking focus (so the first panel of a tab group stays in front). */
  readonly inactive?: boolean
}

/** Below this window width the default layout stacks the map over a tabbed editor group instead of three columns. */
export const NARROW_WIDTH = 700
/** Initial height in px of the editor group under the map in the compact layout. */
export const COMPACT_EDITOR_HEIGHT = 380

/** Initial width in px of the editor column in the default "Query" layout. */
export const EDITOR_WIDTH = 520
/** Initial width in px of the inspector when it gets its own column right of the map. */
export const INSPECTOR_WIDTH = 340
/** Initial width in px of the tools/layers column left of the map. */
export const SIDEBAR_WIDTH = 220
/** Initial height in px of the inspector under the editor, so the editor and its results table keep most of the column. */
export const INSPECTOR_HEIGHT = 240

interface PresetOptions {
  /** Dock the query editor (and results) right of the map. */
  readonly editor: boolean
  /** Dock these (e.g. metadata review) right of the map. */
  readonly extra?: ReadonlyArray<PanelDefinition>
  /** Split every other registered panel below the map (demo/dummy modules) instead of leaving it closed. */
  readonly rest: boolean
  /** Narrow screens: the map on top, everything else as tabs of one group below it. */
  readonly compact?: boolean
}

const buildPreset = (panels: ReadonlyArray<PanelDefinition>, opts: PresetOptions): ReadonlyArray<PresetPanel> => {
  const byId = new Map(panels.map((p) => [p.id, p]))
  const viewer = byId.get("viewer.main")
  const editor = opts.editor ? byId.get("query.editor") : undefined
  const tools = byId.get("viewer.tools")
  const layers = byId.get("viewer.layers")
  const inspector = byId.get("viewer.inspector")
  const extra = opts.extra ?? []
  const placed = new Set<PanelDefinition>([viewer, editor, tools, layers, inspector, ...extra].filter((p): p is PanelDefinition => p !== undefined))
  const out: PresetPanel[] = []
  if (viewer) out.push({ id: viewer.id, title: viewer.title })
  if (opts.compact) {
    // The editor (or, without one, the first sidebar panel) opens the group below the map; the rest join it as inactive tabs.
    const [first, ...rest] = [editor, tools, layers, inspector, ...extra].filter((p): p is PanelDefinition => p !== undefined)
    if (first) {
      out.push({ id: first.id, title: first.title, ...(viewer ? { position: { referencePanel: viewer.id, direction: "below" as const } } : {}), initialHeight: COMPACT_EDITOR_HEIGHT })
      for (const p of rest) out.push({ id: p.id, title: p.title, position: { referencePanel: first.id, direction: "within" }, inactive: true })
    }
    return out
  }
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
  for (const p of extra)
    out.push({
      id: p.id,
      title: p.title,
      ...(viewer ? { position: { referencePanel: viewer.id, direction: "right" as const } } : {}),
      initialWidth: EDITOR_WIDTH,
    })
  // The inspector sits under the editor when there is one, else in its own column right of the map.
  if (inspector) {
    if (editor) out.push({ id: inspector.id, title: inspector.title, position: { referencePanel: editor.id, direction: "below" }, initialHeight: INSPECTOR_HEIGHT })
    else
      out.push({
        id: inspector.id,
        title: inspector.title,
        ...(viewer ? { position: { referencePanel: viewer.id, direction: "right" as const } } : {}),
        initialWidth: INSPECTOR_WIDTH,
      })
  }
  // Anything else (dummy/demo modules) is split below the viewer so it stays visible; `shell.*` (About) and `metadata.*` (Review preset) panels open on demand.
  if (opts.rest)
    for (const p of panels)
      if (!placed.has(p) && !p.id.startsWith("shell.") && !p.id.startsWith("metadata.")) out.push({ id: p.id, title: p.title, ...(viewer ? { position: { referencePanel: viewer.id, direction: "below" as const } } : {}) })
  return out
}

/**
 * The default "Query" preset: tools (with layers below) docked left of the map viewer, query editor + results docked right.
 * Built only from the registered `panels`, so the layout never references a missing panel.
 */
export const queryPreset = (panels: ReadonlyArray<PanelDefinition>, compact = false): ReadonlyArray<PresetPanel> => buildPreset(panels, { editor: true, rest: !compact, compact })

/** "Explore": the map with its tools and layers, no editor. */
export const explorePreset = (panels: ReadonlyArray<PanelDefinition>, compact = false): ReadonlyArray<PresetPanel> => buildPreset(panels, { editor: false, rest: false, compact })

const isReviewPanel = (p: PanelDefinition) => p.id.startsWith("metadata.")

/** "Review": the map with its tools and layers plus the metadata review panels (`metadata.*`) docked right. */
export const reviewPreset = (panels: ReadonlyArray<PanelDefinition>, compact = false): ReadonlyArray<PresetPanel> =>
  buildPreset(panels, { editor: false, extra: panels.filter(isReviewPanel), rest: false, compact })

export interface Preset {
  readonly id: "query" | "explore" | "review"
  readonly title: string
  readonly build: (panels: ReadonlyArray<PanelDefinition>, compact?: boolean) => ReadonlyArray<PresetPanel>
  /** False when the registered panels cannot make this preset meaningful (e.g. Review before map-metadata ships). */
  readonly available: (panels: ReadonlyArray<PanelDefinition>) => boolean
}

const hasViewer = (panels: ReadonlyArray<PanelDefinition>) => panels.some((p) => p.id === "viewer.main")

export const PRESETS: ReadonlyArray<Preset> = [
  { id: "query", title: "Query", build: queryPreset, available: hasViewer },
  { id: "explore", title: "Explore", build: explorePreset, available: hasViewer },
  { id: "review", title: "Review", build: reviewPreset, available: (panels) => hasViewer(panels) && panels.some(isReviewPanel) },
]

/** The preset applied on first load and by "Reset layout". */
export const DEFAULT_PRESET_ID: Preset["id"] = "query"

export const availablePresets = (panels: ReadonlyArray<PanelDefinition>): ReadonlyArray<Preset> => PRESETS.filter((p) => p.available(panels))

type PanelPlacement = PanelDefinition["defaultPlacement"]

/** Where a reopened panel goes, as dockview `addPanel` options (relative to the whole layout, not a given panel). */
export const placementFor = (placement: PanelPlacement): { position?: { direction: Direction }; floating?: true } => {
  switch (placement) {
    case "left": return { position: { direction: "left" } }
    case "right": return { position: { direction: "right" } }
    case "top": return { position: { direction: "above" } }
    case "bottom": return { position: { direction: "below" } }
    case "float": return { floating: true }
    case "center": return {}
  }
}
