import type { MetadataRecord } from "@deadlock-query/contracts"
import { KIND_IDS, kindDefinition } from "../kinds.ts"
import type { Issue } from "../issues.ts"
import type { EditorController, EditorState } from "./controller.ts"
import { fieldsFor, type FieldSpec } from "./fields.ts"
import { postSubmission, type PostResult } from "../submit/client.ts"
import { DEFAULT_SUBMIT_SERVICE, renderTurnstile, type RenderTurnstile, type SubmitService } from "../submit/service.ts"

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
.dlq-md .empty{opacity:.7;padding:6px 0}.dlq-md .status{min-height:1.4em;color:#f0b0b0}
`

const badge = (issues: ReadonlyArray<Issue>): Node | undefined => {
  const errors = issues.filter((i) => i.severity === "error").length
  const warnings = issues.length - errors
  if (issues.length === 0) return undefined
  return h("span", { class: `badge ${errors > 0 ? "err" : "warn"}`, title: issues.map((i) => i.message).join("\n") }, errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : `${warnings} warning${warnings === 1 ? "" : "s"}`)
}

const control = (spec: FieldSpec, record: MetadataRecord, onChange: (value: unknown) => void): HTMLElement => {
  const current = (record as unknown as Record<string, unknown>)[spec.key]
  const id = `dlq-md-${spec.key}`
  switch (spec.type) {
    case "text": {
      const el = h("input", { id, type: "text", maxlength: String(spec.max), value: typeof current === "string" ? current : "" })
      el.addEventListener("change", () => onChange(el.value.trim()))
      return el
    }
    case "number": {
      const el = h("input", { id, type: "number", step: String(spec.step ?? 1), min: spec.min === undefined ? undefined : String(spec.min), value: typeof current === "number" ? String(current) : "" })
      el.addEventListener("change", () => onChange(el.value === "" ? undefined : Number(el.value)))
      return el
    }
    case "select": {
      const el = h("select", { id }, spec.optional ? h("option", { value: "" }, "(none)") : undefined,
        ...spec.options.map((o) => h("option", { value: o, selected: o === current }, o)))
      el.addEventListener("change", () => onChange(el.value === "" ? undefined : el.value))
      return el
    }
    case "bool": {
      const el = h("input", { id, type: "checkbox", checked: current === true })
      el.addEventListener("change", () => onChange(el.checked))
      return el
    }
  }
}

/**
 * Mounts the `metadata.editor` panel into `root`. All text from drafts goes in as text nodes. Returns `dispose`.
 * Drawing happens with the viewer's tools (registered by the controller); this panel lists, edits and validates.
 */
export interface EditorPanelOptions {
  /** Where "Submit now" sends the file; `false` leaves only the download and issue fallback. Default: the live worker. */
  readonly submitService?: SubmitService | false
  /** Tests inject these; defaults are `fetch` and the Cloudflare Turnstile widget. */
  readonly fetch?: typeof fetch
  readonly turnstile?: RenderTurnstile
}

export const mountEditorPanel = (root: HTMLElement, c: EditorController, opts: EditorPanelOptions = {}): { readonly dispose: () => void } => {
  const service = opts.submitService === undefined ? DEFAULT_SUBMIT_SERVICE : opts.submitService
  const style = h("style", {}, PANEL_STYLE)
  const body = h("div", { class: "dlq-md", role: "region", "aria-label": "Map metadata editor" })
  root.replaceChildren(style, body)
  let message = ""
  const remembered = (() => { try { return JSON.parse(localStorage.getItem("dlq-md-submitter") ?? "{}") as { name?: string; github?: string } } catch { return {} } })()
  const form = { name: remembered.name ?? "", github: remembered.github ?? "", note: "" }
  let outcome: ReturnType<EditorController["submit"]> | undefined
  let token: string | undefined
  let posting = false
  let posted: PostResult | undefined
  let checkFailed = false
  let widget: { readonly reset: () => void } | undefined
  // One widget element for the whole mount, re-attached on every render so the challenge is not redone.
  const checkEl = h("div", { id: "dlq-md-human-check" })
  const startCheck = () => {
    if (!service || widget || checkFailed) return
    widget = { reset: () => {} }   // placeholder while loading
    void (opts.turnstile ?? renderTurnstile)(checkEl, service.siteKey, (t) => { token = t; render(c.state()) })
      .then((w) => { widget = w }, () => { checkFailed = true; widget = undefined; render(c.state()) })
  }

  const submitSection = (s: EditorState): Node => {
    const field = (key: "name" | "github" | "note", label: string, max: number) => {
      const el = h("input", { id: `dlq-md-sub-${key}`, type: "text", maxlength: String(max), value: form[key] })
      el.addEventListener("input", () => { form[key] = el.value })
      return [h("label", { for: `dlq-md-sub-${key}` }, label), el]
    }
    const go = h("button", { type: "button", disabled: s.records.length === 0 }, "Review & submit")
    go.addEventListener("click", () => {
      try { localStorage.setItem("dlq-md-submitter", JSON.stringify({ name: form.name, github: form.github })) } catch { /* private mode */ }
      outcome = c.submit({ name: form.name, ...(form.github ? { github: form.github } : {}), ...(form.note ? { note: form.note } : {}) })
      render(c.state())
    })
    const result: Node[] = []
    if (outcome && !outcome.ok) result.push(h("ul", {}, ...outcome.report.issues.filter((i) => i.severity === "error").map((i) => h("li", { class: "problem" }, `Error: ${i.message}`))))
    if (outcome?.ok) {
      const o = outcome
      const dl = h("button", { type: "button" }, `Download ${o.fileName}`)
      dl.addEventListener("click", () => {
        const url = URL.createObjectURL(new Blob([o.text], { type: "application/json" }))
        const a = h("a", { href: url, download: o.fileName }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
      result.push(h("p", { role: "status" }, `Ready: ${s.records.length} feature${s.records.length === 1 ? "" : "s"}${o.warnings > 0 ? `, ${o.warnings} warning${o.warnings === 1 ? "" : "s"}` : ""}. Download the file, then open the issue and ${o.issueInlined ? "paste it (it is already filled in) or attach the file" : "drag the file into it"}.`),
        h("p", {}, dl, " ", h("a", { href: o.issueUrl, target: "_blank", rel: "noopener noreferrer" }, "Open GitHub issue")))
      if (service && !checkFailed && !(posted && posted.ok)) {
        startCheck()
        const send = h("button", { type: "button", disabled: !token || posting }, posting ? "Sending…" : "Submit now")
        send.addEventListener("click", async () => {
          if (!token) return
          posting = true; posted = undefined; render(c.state())
          posted = await postSubmission(o.text, { url: service.url, turnstileToken: token, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
          posting = false; token = undefined; widget?.reset()
          render(c.state())
        })
        result.push(h("p", {}, "Or send it straight to the reviewers (a quick human check first):"), checkEl, h("p", {}, send))
      } else if (service && checkFailed) result.push(h("p", { class: "empty" }, "The human check could not load, so use the download and issue steps above."))
      if (posted?.ok) result.push(h("p", { role: "status" }, "Sent. ", h("a", { href: posted.url, target: "_blank", rel: "noopener noreferrer" }, "See your pull request")))
      else if (posted) result.push(h("p", { class: "status", role: "alert" }, posted.message), ...(posted.issues ? [h("ul", {}, ...posted.issues.slice(0, 5).map((i) => h("li", { class: "problem" }, i.message)))] : []))
    }
    return h("div", {}, h("h3", {}, "Submit"),
      h("div", { class: "detail" }, ...field("name", "Your name", 80), ...field("github", "GitHub (optional)", 39), ...field("note", "Note (optional)", 1000)),
      h("p", {}, go), ...result)
  }

  const render = (s: EditorState) => {
    const active = document.activeElement
    const keep = active instanceof HTMLElement && body.contains(active) ? active.id : ""
    const kinds = h("div", { class: "kinds" }, ...KIND_IDS.map((k) => {
      const d = kindDefinition(k)
      const el = h("button", { type: "button", style: `--c:${d.style.color}`, title: d.tool.hint }, `${d.style.glyph} ${d.label}`, h("small", {}, d.tool.hint))
      el.addEventListener("click", () => { if (!c.activate(k)) { message = `Pick "${d.tool.label}" in the Tools panel.`; render(c.state()) } })
      return el
    }))
    const options = h("div", {},
      h("label", { for: "dlq-md-flag" }, "New regions are "),
      (() => { const el = h("select", { id: "dlq-md-flag" }, ...["walkable", "noGo", "interior", "water"].map((o) => h("option", { value: o, selected: o === s.options.regionFlag }, o))); el.addEventListener("change", () => c.setOptions({ regionFlag: el.value as never })); return el })(),
      " ", h("label", { for: "dlq-md-shape" }, "Custom shape "),
      (() => { const el = h("select", { id: "dlq-md-shape" }, ...["point", "polyline", "polygon"].map((o) => h("option", { value: o, selected: o === s.options.customShape }, o))); el.addEventListener("change", () => c.setOptions({ customShape: el.value as never })); return el })())

    const list = s.records.length === 0
      ? h("p", { class: "empty" }, "Nothing drawn yet. Pick a tool above, then click the map. Drafts are saved in this browser.")
      : h("ul", { role: "listbox", "aria-label": "Your drafts" }, ...s.records.map((r) => {
          const d = kindDefinition(r.kind)
          const pick = h("button", { class: "pick", id: `dlq-md-pick-${r.id}`, type: "button" }, `${d.style.glyph} ${r.name ?? d.label}`)
          pick.addEventListener("click", () => c.select(r.id))
          const del = h("button", { type: "button", "aria-label": `Delete ${r.name ?? d.label}` }, "Delete")
          del.addEventListener("click", () => c.remove(r.id))
          return h("li", { class: "draft", role: "option", "aria-selected": String(r.id === s.selectedId) }, pick, badge(s.issuesById.get(r.id) ?? []), del)
        }))

    const sel = s.records.find((r) => r.id === s.selectedId)
    const detail = sel ? (() => {
      const form = h("form", { class: "detail", "aria-label": `Edit ${sel.kind}` })
      form.addEventListener("submit", (e) => e.preventDefault())
      for (const f of fieldsFor(sel.kind)) {
        form.append(h("label", { for: `dlq-md-${f.key}` }, f.label), control(f, sel, (value) => { message = c.edit(sel.id, { [f.key]: value }) ?? "" ; if (message) render(c.state()) }))
      }
      return form
    })() : undefined

    const problems = s.report.issues.length === 0
      ? h("p", { class: "empty" }, s.records.length === 0 ? "No drafts to check." : "No problems found." + (s.report.degraded ? " Surface checks need the map's collision and are skipped for now." : ""))
      : h("ul", {}, ...s.report.issues.map((i) => {
          const b = h("button", { type: "button" }, `${i.severity === "error" ? "Error" : "Warning"}: ${i.message}`)
          b.addEventListener("click", () => c.focus(i))
          return h("li", { class: "problem" }, b)
        }))

    const clear = h("button", { type: "button", disabled: s.records.length === 0 }, "Delete all drafts")
    clear.addEventListener("click", () => { if (confirm(`Delete all ${s.records.length} drafts?`)) c.clearAll() })

    body.replaceChildren(
      h("h3", {}, "Tools"), kinds, options,
      h("h3", {}, `Your drafts (${s.records.length})`), list, ...(detail ? [detail] : []),
      h("p", { class: "status", role: "status", "aria-live": "polite" }, message || (s.skipped > 0 ? `${s.skipped} saved draft${s.skipped === 1 ? "" : "s"} could not be read and were skipped.` : "")),
      h("h3", {}, "Checks"), problems,
      h("p", {}, clear),
      submitSection(s)
    )
    if (keep) document.getElementById(keep)?.focus()
  }

  render(c.state())
  const off = c.subscribe((s) => { message = ""; outcome = undefined; posted = undefined; render(s) })
  return { dispose: () => { off(); root.replaceChildren() } }
}
