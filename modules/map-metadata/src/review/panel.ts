import { kindDefinition } from "../kinds.ts"
import { PANEL_STYLE } from "../editor/panel.ts"
import type { ReviewController, ReviewState } from "./controller.ts"

type Child = Node | string | undefined | false
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) { if (v === true) el.setAttribute(k, ""); else if (v !== undefined && v !== false) el.setAttribute(k, v) }
  for (const c of children) if (c !== undefined && c !== false) el.append(c)   // strings are text nodes: submitted text is never markup
  return el
}

/**
 * Mounts the dev-only `metadata.review` panel: queue, then one submission with per-record accept/reject, validation, bulk
 * actions, and Merge / Request changes / Reject. Submitted names and notes are shown as text only.
 */
export const mountReviewPanel = (root: HTMLElement, c: ReviewController): { readonly dispose: () => void } => {
  const body = h("div", { class: "dlq-md", role: "region", "aria-label": "Metadata review" })
  root.replaceChildren(h("style", {}, PANEL_STYLE), body)
  const remembered = (() => { try { return localStorage.getItem("dlq-md-reviewer") ?? "" } catch { return "" } })()
  const form = { reviewer: remembered, comment: "" }
  c.state()   // (state is read in render)

  const btn = (label: string, on: () => void, disabled = false) => { const b = h("button", { type: "button", disabled }, label); b.addEventListener("click", on); return b }

  const render = (s: ReviewState) => {
    const focusId = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement.id : ""
    const reviewer = h("input", { id: "dlq-rv-name", type: "text", value: form.reviewer, maxlength: "80" })
    reviewer.addEventListener("input", () => { form.reviewer = reviewer.value; try { localStorage.setItem("dlq-md-reviewer", reviewer.value) } catch { /* private mode */ } })
    const head = h("div", {}, h("label", { for: "dlq-rv-name" }, "Reviewer "), reviewer, " ", btn("Refresh", () => void c.refresh(), s.busy))
    const status = h("p", { class: "status", role: "status", "aria-live": "polite" }, s.busy ? "Working…" : s.error ?? s.notice ?? "")

    let main: Node
    if (!s.open) {
      main = s.queue.length === 0
        ? h("p", { class: "empty" }, "No open submissions. Press Refresh to check again.")
        : h("ul", { "aria-label": "Open submissions" }, ...s.queue.map((i) => {
            const b = h("button", { type: "button", class: "pick", id: `dlq-rv-open-${i.number}` }, `#${i.number} ${i.submissionId}`)
            b.addEventListener("click", () => void c.open(i))
            return h("li", { class: "draft" }, b, h("small", {}, i.author))
          }))
    } else {
      const l = s.open
      const errorsBy = new Map<string, string[]>()
      for (const i of l.report.issues) if (i.recordId) (errorsBy.get(i.recordId) ?? errorsBy.set(i.recordId, []).get(i.recordId)!).push(`${i.severity === "error" ? "Error" : "Warning"}: ${i.message}`)
      const who = l.submission.submitter
      const rows = l.submission.records.map((r) => {
        const d = s.decisions.get(r.id)
        const def = kindDefinition(r.kind)
        const pick = h("button", { type: "button", class: "pick", id: `dlq-rv-rec-${r.id}` }, `${def.style.glyph} ${r.name ?? def.label}`)
        pick.addEventListener("click", () => c.focus(r.id))
        const mk = (label: string, value: "accepted" | "rejected") => { const b = h("button", { type: "button", "aria-pressed": String(d?.decision === value), id: `dlq-rv-${value}-${r.id}` }, label); b.addEventListener("click", () => c.decide(r.id, d?.decision === value ? undefined : value)); return b }
        const problems = errorsBy.get(r.id) ?? []
        return h("li", { class: "draft", role: "group", "aria-label": r.name ?? def.label }, pick, mk("Accept", "accepted"), mk("Reject", "rejected"), problems.length ? h("span", { class: `badge ${problems.some((p) => p.startsWith("Error")) ? "err" : "warn"}`, title: problems.join("\n") }, String(problems.length)) : undefined)
      })
      const generic = l.report.issues.filter((i) => !i.recordId).map((i) => h("li", { class: "problem" }, `${i.severity === "error" ? "Error" : "Warning"}: ${i.message}`))
      const comment = h("input", { id: "dlq-rv-comment", type: "text", maxlength: "1000", value: form.comment })
      comment.addEventListener("input", () => { form.comment = comment.value })
      const decided = s.decisions.size
      main = h("div", {},
        h("h3", {}, `Submission ${l.submission.id}`),
        h("p", {}, `From ${who.name}${who.github ? ` (@${who.github}, unverified)` : ""}, ${l.submission.records.length} record${l.submission.records.length === 1 ? "" : "s"}, ${l.submission.mapName} ${l.submission.gameBuildId}.`),
        ...(l.submission.note ? [h("p", {}, `Note: ${l.submission.note}`)] : []),
        ...(generic.length ? [h("ul", {}, ...generic)] : []),
        h("p", {}, btn("Accept all valid", () => c.bulk("acceptValid")), " ", btn("Reject all", () => c.bulk("rejectAll"))),
        h("ul", { "aria-label": "Records" }, ...rows),
        h("p", {}, h("label", { for: "dlq-rv-comment" }, "Comment "), comment),
        h("p", {}, btn(`Commit decisions (${decided}/${l.submission.records.length})`, () => void c.commit(), s.busy || decided === 0), " ",
          btn("Request changes", () => void c.requestChanges(form.comment), s.busy), " ",
          btn("Reject submission", () => void c.reject(form.comment), s.busy), " ", btn("Back", () => c.close())))
    }
    body.replaceChildren(h("h3", {}, "Review"), head, status, main)
    if (focusId) document.getElementById(focusId)?.focus()
  }
  render(c.state())
  const off = c.subscribe(render)
  void c.refresh()
  return { dispose: () => { off(); root.replaceChildren() } }
}
