import type { ExternalTool, MetadataKind, MetadataRecord, OverlayFeature, ToolContext, Vec3 } from "@deadlock-query/contracts"
import { buildRecord, clicksNeeded, minPoints, newDraftId, type DrawOptions } from "./build.ts"
import { KIND_IDS, kindDefinition } from "../kinds.ts"

export interface KindToolHooks {
  /** Current panel options (read at each click, so changing them takes effect without re-registering). */
  readonly options: () => DrawOptions
  /** A finished record: the editor stores it as a draft. */
  readonly onRecord: (record: MetadataRecord) => void
}

const preview = (kind: MetadataKind, points: ReadonlyArray<Vec3>, cursor: Vec3 | undefined, o: DrawOptions): ReadonlyArray<OverlayFeature> => {
  const pts = cursor ? [...points, cursor] : points
  if (pts.length === 0) return []
  const closed = kind === "walkableRegion" || (kind === "custom" && o.customShape === "polygon")
  const out: OverlayFeature[] = points.map((at) => ({ type: "point", at }))
  if (pts.length >= 3 && closed) out.push({ type: "polygon", ring: pts })
  else if (pts.length >= 2) out.push({ type: "polyline", points: pts })
  return out
}

/** One drawing tool for a kind: clicks collect points (the viewer snaps them to a surface), Enter finishes, Escape backs out. */
export const makeKindTool = (kind: MetadataKind, hooks: KindToolHooks): ExternalTool => {
  const def = kindDefinition(kind)
  let ctx: ToolContext | undefined
  let points: Vec3[] = []

  const refresh = (cursor?: Vec3) => ctx?.setDraft(preview(kind, points, cursor, hooks.options()))
  const status = () => {
    const o = hooks.options()
    const need = clicksNeeded(kind, o.customShape)
    const min = minPoints(kind, o.customShape)
    if (points.length === 0) return `${def.tool.hint}.`
    if (need === "many") return `${points.length} point${points.length === 1 ? "" : "s"}. ${points.length >= min ? "Enter finishes, " : `${min - points.length} more needed, `}Esc removes the last.`
    return `${points.length} of ${need} placed.`
  }
  const finish = () => {
    const o = hooks.options()
    const record = buildRecord(kind, newDraftId(kind), points, o)
    if (!record) { ctx?.setStatus(`Needs at least ${minPoints(kind, o.customShape)} points. ${status()}`); return }
    points = []
    ctx?.setDraft([])
    hooks.onRecord(record)
    ctx?.setStatus(`Saved to your drafts. ${def.tool.hint} for another, or Esc when done.`)
  }

  return {
    id: def.tool.id,
    label: def.tool.label,
    hint: def.tool.hint,
    activate: (c) => { ctx = c; points = []; c.setStatus(`${def.tool.hint}.`) },
    deactivate: () => { points = []; ctx?.setDraft([]); ctx?.setStatus(undefined); ctx = undefined },
    click: (p) => {
      points.push(p)
      const need = clicksNeeded(kind, hooks.options().customShape)
      if (need !== "many" && points.length >= need) finish()
      else { refresh(); ctx?.setStatus(status()) }
    },
    move: (p) => { if (points.length > 0) refresh(p) },
    finish,
    cancel: () => {
      // Escape steps back: remove the last point, and leave the tool when nothing is left.
      if (points.length === 0) { ctx?.done(); return }
      points.pop()
      refresh()
      ctx?.setStatus(points.length === 0 ? `${def.tool.hint}.` : status())
    }
  }
}

export const makeKindTools = (hooks: KindToolHooks): ReadonlyArray<ExternalTool> => KIND_IDS.map((k) => makeKindTool(k, hooks))
