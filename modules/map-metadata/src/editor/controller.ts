import { Effect } from "effect"
import { type MetadataRecord, type OverlayFeature, type Vec3, type ViewerService } from "@deadlock-query/contracts"
import type { ValidationContext } from "../context.ts"
import type { Issue, ValidationReport } from "../issues.ts"
import { KIND_IDS, kindDefinition } from "../kinds.ts"
import { validateRecords } from "../validate.ts"
import { DEFAULT_OPTIONS, type DrawOptions } from "./build.ts"
import type { DraftStore } from "./drafts.ts"
import { applyPatch } from "./fields.ts"
import { makeKindTools } from "./tools.ts"

export type ViewerServiceShape = (typeof ViewerService)["Service"]

export interface EditorControllerOptions {
  readonly viewer: ViewerServiceShape
  readonly drafts: DraftStore
  /** Read at every validation, so a collision probe or existing records that arrive later are picked up (M2). */
  readonly context?: () => ValidationContext
}

export interface EditorState {
  readonly options: DrawOptions
  readonly selectedId: string | undefined
  readonly records: ReadonlyArray<MetadataRecord>
  readonly report: ValidationReport
  readonly issuesById: ReadonlyMap<string, ReadonlyArray<Issue>>
  readonly skipped: number
}

export interface EditorController {
  readonly state: () => EditorState
  readonly subscribe: (fn: (s: EditorState) => void) => () => void
  readonly setOptions: (patch: Partial<DrawOptions>) => void
  readonly select: (id: string | undefined) => void
  /** Edit fields of a draft; refused (with the reason) when the result would not match the schema. */
  readonly edit: (id: string, patch: Readonly<Record<string, unknown>>) => string | undefined
  readonly remove: (id: string) => void
  readonly clearAll: () => void
  /** Move the camera to a draft or to the place a validation issue points at. */
  readonly focus: (target: string | Issue) => void
  readonly dispose: () => void
}

const anchor = (r: MetadataRecord): Vec3 => {
  switch (r.kind) {
    case "walkableRegion": return r.ring[0]!
    case "navLink": return r.from
    case "custom": return r.geometry.type === "point" ? r.geometry.at : r.geometry.type === "polygon" ? r.geometry.ring[0]! : r.geometry.points[0]!
    default: return r.position
  }
}

/** How far the camera stands from a focused feature (world units). */
const FOCUS_DISTANCE = 600

const featureOf = (r: MetadataRecord, issues: number): OverlayFeature => {
  const label = r.name ?? kindDefinition(r.kind).label
  const properties = { id: r.id, kind: r.kind, status: r.status, ...(issues > 0 ? { issues } : {}) }
  switch (r.kind) {
    case "walkableRegion": return { type: "polygon", ring: r.ring, label, properties }
    case "navLink": return { type: "segment", points: [r.from, r.to], label, properties }
    case "custom": {
      const g = r.geometry
      return g.type === "point" ? { type: "point", at: g.at, label, properties }
        : g.type === "polyline" ? { type: "polyline", points: g.points, label, properties }
        : { type: "polygon", ring: g.ring, label, properties }
    }
    default: return { type: "point", at: r.position, label, properties }
  }
}

const layerOf = (kind: string) => `metadata.drafts.${kind}`
const SELECTED_LAYER = "metadata.selected"

/**
 * The editor's logic without any DOM: registers the per-kind drawing tools with the viewer, keeps the drafts drawn as
 * overlays, validates them with the module's validators, and holds the panel's selection and options. The panel and the
 * tests both drive this.
 */
export const createEditorController = ({ viewer, drafts, context }: EditorControllerOptions): EditorController => {
  let options = DEFAULT_OPTIONS
  let selectedId: string | undefined
  let snapshot: EditorState
  const listeners = new Set<(s: EditorState) => void>()
  const run = (e: Effect.Effect<unknown>) => void Effect.runFork(e)

  const compute = (): EditorState => {
    const records = drafts.list()
    const report = validateRecords(records, context?.() ?? {})
    const by = new Map<string, Issue[]>()
    for (const i of report.issues) if (i.recordId !== undefined) (by.get(i.recordId) ?? by.set(i.recordId, []).get(i.recordId)!).push(i)
    if (selectedId !== undefined && !records.some((r) => r.id === selectedId)) selectedId = undefined
    return { options, selectedId, records, report, issuesById: by, skipped: drafts.skipped() }
  }

  const drawOverlays = (s: EditorState) => {
    for (const kind of KIND_IDS) {
      const of = s.records.filter((r) => r.kind === kind)
      const layer = layerOf(kind)
      if (of.length === 0) run(viewer.removeOverlay(layer))
      else run(viewer.setOverlay(layer, of.map((r) => featureOf(r, s.issuesById.get(r.id)?.length ?? 0)), { color: kindDefinition(kind).style.color, size: 10 }))
    }
    const sel = s.records.find((r) => r.id === s.selectedId)
    if (sel) run(viewer.setOverlay(SELECTED_LAYER, [featureOf(sel, 0)], { color: "#ffffff", size: 14 }))
    else run(viewer.removeOverlay(SELECTED_LAYER))
  }

  const update = () => { snapshot = compute(); drawOverlays(snapshot); for (const fn of listeners) fn(snapshot) }

  const tools = makeKindTools({ options: () => options, onRecord: (r) => { selectedId = r.id; drafts.add(r) } })
  const unregister = tools.map((t) => Effect.runSync(viewer.registerTool(t)))
  const unsubscribe = drafts.subscribe(update)
  snapshot = compute()
  drawOverlays(snapshot)

  return {
    state: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => void listeners.delete(fn) },
    setOptions: (patch) => { options = { ...options, ...patch }; update() },
    select: (id) => {
      selectedId = id
      update()
      const r = id === undefined ? undefined : drafts.get(id)
      if (r) run(viewer.flyTo(anchor(r), FOCUS_DISTANCE))
    },
    edit: (id, patch) => {
      const r = drafts.get(id)
      if (!r) return `no draft "${id}"`
      const out = applyPatch(r, patch)
      if ("error" in out) return out.error
      drafts.update(out.record)
      return undefined
    },
    remove: (id) => drafts.remove(id),
    clearAll: () => drafts.clear(),
    focus: (target) => {
      const at = typeof target === "string" ? (() => { const r = drafts.get(target); return r ? anchor(r) : undefined })() : target.at
      if (at) run(viewer.flyTo(at, FOCUS_DISTANCE))
    },
    dispose: () => {
      unsubscribe()
      for (const u of unregister) u()
      for (const k of KIND_IDS) run(viewer.removeOverlay(layerOf(k)))
      run(viewer.removeOverlay(SELECTED_LAYER))
      listeners.clear()
    }
  }
}

