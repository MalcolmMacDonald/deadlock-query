import { checkApiVersion } from "../share/shareLink.ts"
import { dlqFilename, exportDlq, parseDlq } from "../store/dlqFile.ts"
import type { QueryStore } from "../store/queryStore.ts"

export interface SavedPanesOptions {
  readonly store: QueryStore
  /** Library `apiVersion` now loaded, to flag queries written for another one. */
  readonly apiVersion: string
  readonly getSource: () => string
  /** Put a query into the editor (never runs it). */
  readonly loadSource: (source: string, apiVersion?: string) => void
  readonly download: (filename: string, mime: string, text: string) => void
}

export interface SavedPanes {
  readonly saved: HTMLElement
  readonly history: HTMLElement
  readonly refresh: () => void
}

const el = <K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = doc.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
const button = (doc: Document, label: string, testid: string, onClick: () => void) => {
  const b = el(doc, "button", undefined, label)
  b.type = "button"
  b.dataset.testid = testid
  b.addEventListener("click", onClick)
  return b
}
const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 80)
const when = (t: number) => new Date(t).toLocaleString()

export const renderSavedPanes = (doc: Document, opts: SavedPanesOptions): SavedPanes => {
  const saved = el(doc, "div", "pane saved")
  saved.dataset.testid = "saved-pane"
  const history = el(doc, "div", "pane history")
  history.dataset.testid = "history-pane"

  // --- Saved ---
  const name = el(doc, "input")
  name.placeholder = "Name for the current query"
  name.dataset.testid = "saved-name"
  const status = el(doc, "div", "empty")
  status.dataset.testid = "saved-status"
  const say = (text: string) => { status.textContent = text }
  const fileInput = el(doc, "input")
  fileInput.type = "file"
  fileInput.accept = ".json,application/json"
  fileInput.hidden = true
  fileInput.dataset.testid = "saved-import-file"
  const guard = (f: () => void) => { try { f() } catch (e) { say(e instanceof Error ? e.message : String(e)) } }
  const form = el(doc, "div", "actions")
  form.append(
    name,
    button(doc, "Save", "saved-save", () => guard(() => {
      opts.store.save(name.value, opts.getSource(), opts.apiVersion)
      say(`Saved "${name.value.trim()}".`)
      name.value = ""
      refresh()
    })),
    button(doc, "Import…", "saved-import", () => fileInput.click()),
    button(doc, "Export all", "saved-export-all", () => guard(() => {
      const all = opts.store.saved()
      if (all.length === 0) return say("Nothing saved yet.")
      opts.download("deadlock-queries.dlq.json", "application/json", exportDlq(all.map((s) => ({ name: s.name, source: s.source, ...(s.apiVersion ? { apiVersion: s.apiVersion } : {}) }))))
    }))
  )
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0]
    fileInput.value = ""
    if (!file) return
    void file.text().then((text) => guard(() => {
      const parsed = parseDlq(text)
      for (const q of parsed.queries) opts.store.save(q.name, q.source, q.apiVersion)
      say(`Imported ${parsed.queries.length} ${parsed.queries.length === 1 ? "query" : "queries"}. Imported queries are not run.`)
      refresh()
    }))
  })
  const savedList = el(doc, "div", "saved-list")
  saved.append(form, fileInput, status, savedList)

  // --- History ---
  const historyList = el(doc, "div", "history-list")
  history.append(button(doc, "Clear history", "history-clear", () => { opts.store.clearHistory(); refresh() }), historyList)

  const refresh = () => {
    savedList.replaceChildren()
    const items = opts.store.saved()
    if (items.length === 0) savedList.append(el(doc, "div", "empty", "No saved queries yet. Name the current query and press Save."))
    for (const s of items) {
      const card = el(doc, "div", "card")
      card.dataset.testid = "saved-item"
      card.dataset.name = s.name
      card.append(el(doc, "strong", undefined, s.name), el(doc, "div", "needs", `${firstLine(s.source)} · ${when(s.savedAt)}`))
      const check = checkApiVersion(s.apiVersion, opts.apiVersion)
      if (check.kind !== "same") {
        const w = el(doc, "div", "warning", check.message)
        w.dataset.testid = "saved-version-warning"
        card.append(w)
      }
      const actions = el(doc, "div", "actions")
      actions.append(
        button(doc, "Load", "saved-load", () => opts.loadSource(s.source, s.apiVersion)),
        button(doc, "Export", "saved-export", () => opts.download(dlqFilename(s.name), "application/json", exportDlq([{ name: s.name, source: s.source, ...(s.apiVersion ? { apiVersion: s.apiVersion } : {}) }]))),
        button(doc, "Delete", "saved-delete", () => { opts.store.remove(s.id); refresh() })
      )
      card.append(actions)
      savedList.append(card)
    }
    historyList.replaceChildren()
    const runs = opts.store.history()
    if (runs.length === 0) historyList.append(el(doc, "div", "empty", "Runs appear here, newest first."))
    for (const h of runs) {
      const card = el(doc, "div", "card")
      card.dataset.testid = "history-item"
      card.append(
        el(doc, "strong", undefined, h.status === "ok" ? `${h.rows ?? 0} rows` : "Error"),
        el(doc, "div", "needs", when(h.at)),
        el(doc, "pre", undefined, firstLine(h.source))
      )
      if (h.error) card.append(el(doc, "div", "warning", h.error.slice(0, 200)))
      card.append(button(doc, "Load", "history-load", () => opts.loadSource(h.source)))
      historyList.append(card)
    }
  }
  refresh()
  return { saved, history, refresh }
}
