import type { Entity, OverlayFeature, OverlayStyle, Shot } from "@deadlock-query/contracts"
import type { PanelComponent } from "./ViewerPanel.ts"
import { LANE_STYLE, laneName } from "./lanes.ts"
import type { Annotation } from "./annotations.ts"
import type { ViewerController } from "./viewerService.ts"

export const VIEWER_INSPECTOR_PANEL_ID = "viewer.inspector"

export interface Field {
  readonly key: string
  readonly value: string
}

export interface Section {
  readonly name: string
  readonly fields: ReadonlyArray<Field>
}

/** Everything the inspector shows for one selected id. `raw` is the underlying JSON for copying. */
export interface InspectorItem {
  readonly id: string
  readonly title: string
  readonly subtitle: string
  readonly sections: ReadonlyArray<Section>
  readonly raw: unknown
}

const MAX_DEPTH = 6
const MAX_ITEMS = 50
const MAX_INLINE_NUMBERS = 12

const isNumberArray = (v: unknown): v is ReadonlyArray<number> =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number")

const scalar = (v: unknown): string =>
  v === null ? "null"
  : v === undefined ? "undefined"
  : typeof v === "string" ? v
  : typeof v === "bigint" ? `${v}n`
  : String(v)

/**
 * Flattens any JSON-ish value into `key -> display string` rows, so new fields (and odd keys such as `"0.0,"`) show
 * up without code changes. Short number arrays (positions, angles) stay on one row; nesting uses `.key` / `[i]` paths.
 */
export const flattenFields = (value: unknown, prefix = "", depth = 0): ReadonlyArray<Field> => {
  const key = prefix === "" ? "(value)" : prefix
  if (value === null || typeof value !== "object") return [{ key, value: scalar(value) }]
  if (isNumberArray(value)) {
    const shown = value.slice(0, MAX_INLINE_NUMBERS).join(", ")
    return [{ key, value: value.length > MAX_INLINE_NUMBERS ? `[${shown}, … ${value.length} numbers]` : `[${shown}]` }]
  }
  if (depth >= MAX_DEPTH) return [{ key, value: JSON.stringify(value) }]
  const children: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i): [string, unknown] => [`${prefix}[${i}]`, v])
    : Object.entries(value).map(([k, v]): [string, unknown] => [prefix === "" ? k : `${prefix}.${k}`, v])
  if (children.length === 0) return [{ key, value: Array.isArray(value) ? "[]" : "{}" }]
  const out = children.slice(0, MAX_ITEMS).flatMap(([k, v]) => flattenFields(v, k, depth + 1))
  if (children.length > MAX_ITEMS) out.push({ key: `${key} …`, value: `${children.length - MAX_ITEMS} more not shown` })
  return out
}

const ENTITY_FIELD_ORDER = ["id", "class", "kind", "team", "lane", "position", "rotation"] as const

/** Entity fields in a stable lead order, then any other top-level field; `properties` is its own section. */
export const entityItem = (e: Entity, featureId: string): InspectorItem => {
  const { properties, ...rest } = e as Entity & Record<string, unknown>
  const known = new Set<string>(ENTITY_FIELD_ORDER)
  const ordered: Record<string, unknown> = {}
  for (const k of ENTITY_FIELD_ORDER) if (k in rest) ordered[k] = k === "lane" && laneName(rest[k]) ? `${rest[k]} (${LANE_STYLE[laneName(rest[k])!].label})` : rest[k]
  for (const [k, v] of Object.entries(rest)) if (!known.has(k)) ordered[k] = v
  const props = properties as Record<string, unknown> | undefined
  const propFields = props ? Object.entries(props).flatMap(([k, v]) => flattenFields(v, k)) : []
  return {
    id: featureId,
    title: e.id,
    subtitle: [e.kind, e.class].filter(Boolean).join(" · "),
    sections: [
      { name: "Entity", fields: Object.entries(ordered).flatMap(([k, v]) => flattenFields(v, k)) },
      { name: "Properties", fields: propFields }
    ],
    raw: e
  }
}

/** An overlay feature (e.g. a query-result point with its row `properties`) plus the layer it belongs to. */
export const featureItem = (
  featureId: string, feature: OverlayFeature, layerId: string, index: number, style: OverlayStyle
): InspectorItem => {
  const { properties, ...geometry } = feature as OverlayFeature & { properties?: Record<string, unknown> }
  return {
    id: featureId,
    title: feature.label ?? `${layerId} #${index}`,
    subtitle: `${feature.type} · layer ${layerId}`,
    sections: [
      { name: "Feature", fields: [{ key: "layer", value: layerId }, { key: "index", value: String(index) }, ...flattenFields(geometry)] },
      { name: "Properties", fields: properties ? Object.entries(properties).flatMap(([k, v]) => flattenFields(v, k)) : [] },
      { name: "Layer style", fields: flattenFields(style) }
    ],
    raw: { layer: layerId, index, feature, style }
  }
}

/** A user annotation (point, label, polyline, polygon, measure). */
export const annotationItem = (a: Annotation, featureId: string): InspectorItem => ({
  id: featureId,
  title: ("text" in a && a.text) || a.id,
  subtitle: `annotation · ${a.kind}`,
  sections: [{ name: "Annotation", fields: flattenFields(a) }],
  raw: a
})

/** A screenshot marker or view cone. */
export const shotItem = (s: Shot, featureId: string): InspectorItem => ({
  id: featureId,
  title: s.id,
  subtitle: "screenshot",
  sections: [{ name: "Screenshot", fields: flattenFields(s) }],
  raw: s
})

export const unknownItem = (featureId: string): InspectorItem => ({
  id: featureId, title: featureId, subtitle: "no data for this id", sections: [], raw: { id: featureId }
})

const MAX_SHOWN_ITEMS = 25
const PANEL_CSS = "padding:8px;font:12px/1.4 sans-serif;color:var(--fg,#dfe3e8);background:var(--surface,#1b1e24);height:100%;box-sizing:border-box;overflow:auto"

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (css) n.style.cssText = css
  if (text !== undefined) n.textContent = text
  return n
}

/**
 * `viewer.inspector`: every field of what is selected on the map (entities, query-result features, annotations,
 * screenshots). Follows the controller's highlight list, so clicks, shift/ctrl-click multi-selection and
 * `ViewerService.highlight` all show up here. Built with `textContent` only.
 */
export const makeInspectorPanel = (controller: ViewerController): PanelComponent => ({
  mount: (container) => {
    const root = el("div", PANEL_CSS)
    root.dataset.testid = "inspector"
    const head = el("div", "display:flex;gap:6px;align-items:center;margin-bottom:6px")
    const count = el("strong", "flex:1")
    count.setAttribute("aria-live", "polite")
    const copy = el("button", "", "Copy JSON")
    const clear = el("button", "", "Clear")
    clear.onclick = () => controller.clearSelection()
    head.append(count, copy, clear)
    const body = el("div")
    root.append(head, body)
    container.appendChild(root)

    let items: ReadonlyArray<InspectorItem> = []
    copy.onclick = () => {
      const text = JSON.stringify(items.length === 1 ? items[0]!.raw : items.map((i) => i.raw), null, 2)
      void navigator.clipboard?.writeText(text).catch(() => {})
    }

    const render = (ids: ReadonlyArray<string>) => {
      items = ids.map((id) => controller.inspect(id))
      count.textContent = ids.length === 0 ? "Nothing selected" : ids.length === 1 ? "1 selected" : `${ids.length} selected`
      copy.disabled = clear.disabled = ids.length === 0
      body.replaceChildren()
      if (ids.length === 0) body.append(el("div", "color:var(--muted,#9aa3ad)", "Click a point on the map to see its metadata. Shift-click adds more."))
      items.slice(0, MAX_SHOWN_ITEMS).forEach((item, i) => {
        const box = el("details", "margin:6px 0;border-bottom:1px solid var(--border,#2c3137);padding-bottom:6px")
        box.open = items.length <= 3 || i === 0
        box.dataset.testid = "inspector-item"
        const sum = el("summary", "cursor:pointer;font-weight:600;word-break:break-all", item.title)
        if (item.subtitle) sum.append(el("span", "font-weight:400;color:var(--muted,#9aa3ad)", `  ${item.subtitle}`))
        box.append(sum)
        for (const s of item.sections) {
          if (s.fields.length === 0 && s.name === "Properties") continue
          box.append(el("div", "margin:6px 0 2px;color:var(--muted,#9aa3ad);text-transform:uppercase;font-size:10px;letter-spacing:.05em", `${s.name} (${s.fields.length})`))
          const table = el("table", "width:100%;border-collapse:collapse")
          for (const f of s.fields) {
            const tr = el("tr")
            tr.append(
              el("td", "vertical-align:top;padding:1px 6px 1px 0;color:var(--muted,#9aa3ad);word-break:break-all;width:40%", f.key),
              el("td", "vertical-align:top;padding:1px 0;word-break:break-all;font-family:monospace", f.value)
            )
            table.append(tr)
          }
          box.append(table)
        }
        body.append(box)
      })
      if (items.length > MAX_SHOWN_ITEMS) body.append(el("div", "color:var(--muted,#9aa3ad);padding:6px 0", `… ${items.length - MAX_SHOWN_ITEMS} more selected, not listed`))
    }
    render(controller.highlightedIds)
    const stop = controller.onHighlightChange(render)
    return () => { stop(); root.remove() }
  }
})
