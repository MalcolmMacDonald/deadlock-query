import { KIND_IDS, kindDefinition } from "../kinds.ts"
import type { Issue } from "../issues.ts"
import type { EditorController, EditorState } from "./controller.ts"
import { postSubmission, type PostResult } from "../submit/client.ts"
import { DEFAULT_SUBMIT_SERVICE, type SubmitService } from "../submit/service.ts"
import type { TagController, TagState } from "../tagging/controller.ts"

type Child = Node | string | undefined | false
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) { if (v === true) el.setAttribute(k, ""); else if (v !== undefined && v !== false) el.setAttribute(k, v) }
  for (const c of children) if (c !== undefined && c !== false) el.append(c)   // strings become text nodes: user text is never markup
  return el
}

export const PANEL_STYLE = `
.dlq-md{font:13px/1.4 system-ui,sans-serif;color:var(--fg,#e6e6e6);background:var(--bg,#1b1d21);height:100%;overflow:auto;padding:10px;box-sizing:border-box}
.dlq-md h3{margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
.dlq-md button,.dlq-md select,.dlq-md input{font:inherit;color:inherit;background:#2a2d33;border:1px solid #444;border-radius:4px;padding:3px 6px}
.dlq-md button{cursor:pointer}.dlq-md button:focus-visible,.dlq-md input:focus-visible,.dlq-md select:focus-visible{outline:2px solid #6aa9ff;outline-offset:1px}
.dlq-md .kinds{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:4px}
.dlq-md .kinds button{text-align:left;padding:4px 6px;border-left:4px solid var(--c);background:#23262b;border-radius:3px}
.dlq-md .kinds small{display:block;opacity:.7}
.dlq-md ul{list-style:none;margin:0;padding:0}
.dlq-md li.draft{display:flex;gap:6px;align-items:center;padding:3px 4px;border-radius:3px}
.dlq-md li.draft[aria-selected=true]{background:#33415c}
.dlq-md li.draft .pick{flex:1;text-align:left;background:none;border:0;padding:2px}
.dlq-md .badge{font-size:11px;padding:0 5px;border-radius:8px}.dlq-md .err{background:#7a2b2b}.dlq-md .warn{background:#6b5a1f}
.dlq-md .detail{display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center;margin-top:6px}
.dlq-md .problem{padding:3px 0;border-bottom:1px solid #333}.dlq-md .problem button{background:none;border:0;text-align:left;padding:0;width:100%}
.dlq-md .tags{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px}
.dlq-md .tags button{text-align:left;padding:6px 8px;border-left:6px solid var(--c);background:#23262b;border-radius:3px}
.dlq-md .tags button[aria-pressed=true]{background:var(--c);color:#111;font-weight:600}
.dlq-md .tags small{display:block;opacity:.8}
.dlq-md details{margin-top:12px}.dlq-md summary{cursor:pointer;font-size:12px;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
.dlq-md .empty{opacity:.7;padding:6px 0}.dlq-md .status{min-height:1.4em;color:#f0b0b0}
`

const badge = (issues: ReadonlyArray<Issue>): Node | undefined => {
  const errors = issues.filter((i) => i.severity === "error").length
  const warnings = issues.length - errors
  if (issues.length === 0) return undefined
  return h("span", { class: `badge ${errors > 0 ? "err" : "warn"}`, title: issues.map((i) => i.message).join("\n") }, errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : `${warnings} warning${warnings === 1 ? "" : "s"}`)
}

export interface EditorPanelOptions {
  /** Where "Send for review" posts the file; `false` leaves only the download and issue fallback. Default: the live worker. */
  readonly submitService?: SubmitService | false
  /** Tests inject this; the default is `fetch`. */
  readonly fetch?: typeof fetch
  /** When given, the panel opens with the tagging section: select entities on the map, then press a tag. */
  readonly tags?: TagController
}

/**
 * Mounts the one metadata panel into `root`: tag the selected entities (when `tags` is given), draw shapes (collapsed),
 * then send everything for review. All text from drafts goes in as text nodes. Returns `dispose`.
 */
export const mountEditorPanel = (root: HTMLElement, c: EditorController, opts: EditorPanelOptions = {}): { readonly dispose: () => void } => {
  const service = opts.submitService === undefined ? DEFAULT_SUBMIT_SERVICE : opts.submitService
  const style = h("style", {}, PANEL_STYLE)
  const body = h("div", { class: "dlq-md", role: "region", "aria-label": "Map metadata" })
  root.replaceChildren(style, body)
  let message = ""
  const remembered = (() => { try { return JSON.parse(localStorage.getItem("dlq-md-submitter") ?? "{}") as { name?: string } } catch { return {} } })()
  const form = { name: remembered.name ?? "" }
  let outcome: ReturnType<EditorController["submit"]> | undefined
  let posting = false
  let posted: PostResult | undefined
  let drawOpen = false

  const tagSection = (t: TagState): Node => {
    const n = t.selected.length
    const buttons = t.rows.map((r) => {
      const all = n > 0 && r.onSelected === n
      const b = h("button", { type: "button", style: `--c:${r.tag.color}`, "aria-pressed": String(all), title: r.tag.hint, disabled: n === 0 },
        r.tag.label, h("small", {}, n > 0 && r.onSelected > 0 && !all ? `${r.onSelected} of ${n} tagged · ${r.total} in all` : `${r.total} tagged`))
      b.addEventListener("click", () => opts.tags!.toggle(r.tag.id))
      return b
    })
    return h("div", {},
      h("h3", {}, "Tag"),
      h("p", { class: n === 0 ? "empty" : "", role: "status", "aria-live": "polite" }, n === 0 ? "Click entities on the map (shift-click adds more), or send a query result here." : `${n} selected: press a tag to apply it to all, press again to remove it.`),
      h("div", { class: "tags" }, ...buttons))
  }

  const sendSection = (s: EditorState, t: TagState | undefined): Node => {
    const count = s.records.length
    const name = h("input", { id: "dlq-md-sub-name", type: "text", maxlength: "80", value: form.name })
    name.addEventListener("input", () => { form.name = name.value })
    const go = h("button", { type: "button", disabled: count === 0 || posting }, posting ? "Sending…" : "Send for review")
    go.addEventListener("click", async () => {
      try { localStorage.setItem("dlq-md-submitter", JSON.stringify({ name: form.name })) } catch { /* private mode */ }
      outcome = c.submit({ name: form.name })
      posted = undefined
      if (outcome.ok && service) {
        posting = true; render(c.state())
        posted = await postSubmission(outcome.text, { url: service.url, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
        posting = false
      }
      render(c.state())
    })
    const result: Node[] = []
    if (outcome && !outcome.ok) result.push(h("ul", {}, ...outcome.report.issues.filter((i) => i.severity === "error").map((i) => h("li", { class: "problem" }, `Error: ${i.message}`))))
    if (outcome?.ok) {
      const o = outcome
      if (posted?.ok) result.push(h("p", { role: "status" }, "Sent. ", h("a", { href: posted.url, target: "_blank", rel: "noopener noreferrer" }, "See your pull request")))
      else {
        if (posted) result.push(h("p", { class: "status", role: "alert" }, posted.message), ...(posted.issues ? [h("ul", {}, ...posted.issues.slice(0, 5).map((i) => h("li", { class: "problem" }, i.message)))] : []))
        const dl = h("button", { type: "button" }, `Download ${o.fileName}`)
        dl.addEventListener("click", () => {
          const url = URL.createObjectURL(new Blob([o.text], { type: "application/json" }))
          const a = h("a", { href: url, download: o.fileName }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
        })
        result.push(h("p", {}, service ? "You can also send it by hand: " : "Download the file, then open the issue and " + (o.issueInlined ? "paste it (already filled in) or attach the file." : "drag the file into it."), " "),
          h("p", {}, dl, " ", h("a", { href: o.issueUrl, target: "_blank", rel: "noopener noreferrer" }, "Open GitHub issue")))
      }
    }
    const problems = s.report.issues.filter((i) => i.severity === "error").length
    return h("div", {}, h("h3", {}, "Send"),
      h("p", {}, `${count} item${count === 1 ? "" : "s"} ready${t ? ` (${t.rows.reduce((a, r) => a + r.total, 0)} tags)` : ""}${problems > 0 ? `, ${problems} to fix` : ""}.`),
      h("div", { class: "detail" }, h("label", { for: "dlq-md-sub-name" }, "Your name"), name),
      h("p", {}, go), ...result)
  }

  const drawSection = (s: EditorState): Node => {
    const shapes = s.records.filter((r) => !(r.kind === "custom" && r.geometry.type === "point" && r.properties?.entityId !== undefined))
    const kinds = h("div", { class: "kinds" }, ...KIND_IDS.map((k) => {
      const d = kindDefinition(k)
      const el = h("button", { type: "button", style: `--c:${d.style.color}`, title: d.tool.hint }, `${d.style.glyph} ${d.label}`)
      el.addEventListener("click", () => { if (!c.activate(k)) { message = `Pick "${d.tool.label}" in the Tools panel.`; render(c.state()) } })
      return el
    }))
    const list = shapes.length === 0 ? h("p", { class: "empty" }, "Pick a shape, then click the map. Drafts are saved in this browser.")
      : h("ul", { "aria-label": "Your drawn shapes" }, ...shapes.map((r) => {
          const d = kindDefinition(r.kind)
          const pick = h("button", { class: "pick", id: `dlq-md-pick-${r.id}`, type: "button" }, `${d.style.glyph} ${r.name ?? d.label}`)
          pick.addEventListener("click", () => c.select(r.id))
          const del = h("button", { type: "button", "aria-label": `Delete ${r.name ?? d.label}` }, "Delete")
          del.addEventListener("click", () => c.remove(r.id))
          return h("li", { class: "draft", "aria-selected": String(r.id === s.selectedId) }, pick, badge(s.issuesById.get(r.id) ?? []), del)
        }))
    const d = h("details", { ...(drawOpen || shapes.length > 0 ? { open: true } : {}) }, h("summary", {}, `Draw shapes (${shapes.length})`), kinds, list)
    d.addEventListener("toggle", () => { drawOpen = d.open })
    return d
  }

  const render = (s: EditorState) => {
    const active = document.activeElement
    const keep = active instanceof HTMLElement && body.contains(active) ? active.id : ""
    const t = opts.tags?.state()
    body.replaceChildren(
      ...(t ? [tagSection(t)] : []),
      drawSection(s),
      h("p", { class: "status", role: "status", "aria-live": "polite" }, message || (s.skipped > 0 ? `${s.skipped} saved draft${s.skipped === 1 ? "" : "s"} could not be read and were skipped.` : "")),
      sendSection(s, t)
    )
    if (keep) document.getElementById(keep)?.focus()
  }

  render(c.state())
  const off = c.subscribe((s) => { message = ""; outcome = undefined; posted = undefined; render(s) })
  const offTags = opts.tags?.subscribe(() => render(c.state()))
  return { dispose: () => { off(); offTags?.(); root.replaceChildren() } }
}
