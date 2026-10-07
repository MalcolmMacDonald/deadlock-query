import type { MetadataKind, MetadataRecord, MetadataStatus } from "@deadlock-query/contracts"
import { KIND_IDS, kindDefinition } from "../kinds.ts"
import { PANEL_STYLE } from "../editor/panel.ts"
import { historyRows, statusCounts, type HistoryFilter } from "./history.ts"

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Array<Node | string | undefined>): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) { if (v === true) el.setAttribute(k, ""); else if (v !== undefined && v !== false) el.setAttribute(k, v) }
  for (const c of children) if (c !== undefined) el.append(c)   // text nodes only
  return el
}

/**
 * The `metadata.history` panel: every record of the loaded build with who sent it and who decided, filterable by status,
 * kind and text. `records` is a getter so the panel shows data that arrives later; call the returned `update`.
 * `onPick` is for flying the camera to a record.
 */
export const mountHistoryPanel = (root: HTMLElement, records: () => ReadonlyArray<MetadataRecord>, onPick?: (id: string) => void): { readonly update: () => void; readonly dispose: () => void } => {
  const body = h("div", { class: "dlq-md", role: "region", "aria-label": "Metadata history" })
  root.replaceChildren(h("style", {}, PANEL_STYLE), body)
  const f: { status?: MetadataStatus; kind?: MetadataKind; text: string } = { text: "" }

  const select = (id: string, label: string, options: ReadonlyArray<string>, value: string | undefined, set: (v: string | undefined) => void) => {
    const el = h("select", { id }, h("option", { value: "" }, "all"), ...options.map((o) => h("option", { value: o, selected: o === value }, o)))
    el.addEventListener("change", () => { set(el.value || undefined); render() })
    return [h("label", { for: id }, `${label} `), el, " "]
  }
  const render = () => {
    const all = records()
    const filter: HistoryFilter = { ...(f.status ? { status: f.status } : {}), ...(f.kind ? { kind: f.kind } : {}), text: f.text }
    const rows = historyRows(all, filter)
    const c = statusCounts(all)
    const text = h("input", { id: "dlq-hi-text", type: "search", value: f.text, "aria-label": "Search history" })
    text.addEventListener("input", () => { f.text = text.value; render(); document.getElementById("dlq-hi-text")?.focus() })
    body.replaceChildren(
      h("h3", {}, "History"),
      h("p", {}, `${all.length} records: ${c.accepted} accepted, ${c.proposed} proposed, ${c.rejected} rejected, ${c.stale} stale.`),
      h("div", {}, ...select("dlq-hi-status", "Status", ["accepted", "proposed", "rejected", "stale"], f.status, (v) => { if (v) f.status = v as MetadataStatus; else delete f.status }),
        ...select("dlq-hi-kind", "Kind", KIND_IDS, f.kind, (v) => { if (v) f.kind = v as MetadataKind; else delete f.kind }), text),
      rows.length === 0 ? h("p", { class: "empty" }, "Nothing matches.") : h("ul", { "aria-label": "Records" }, ...rows.map((r) => {
        const pick = h("button", { type: "button", class: "pick" }, `${kindDefinition(r.kind).style.glyph} ${r.label} · ${r.status}`)
        pick.addEventListener("click", () => onPick?.(r.id))
        return h("li", { class: "draft", style: "display:block" }, pick, ...r.events.map((e) => h("div", { class: "empty", style: "padding:0 0 0 18px" }, e)))
      })))
  }
  render()
  return { update: render, dispose: () => root.replaceChildren() }
}
