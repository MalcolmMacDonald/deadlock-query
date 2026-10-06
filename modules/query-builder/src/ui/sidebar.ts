import { searchDocs, type DocIndex, type DocItem } from "../docs/catalog.ts"
import { GALLERY, type GalleryQuery } from "../gallery/queries.ts"

export type SidebarTab = "docs" | "gallery" | "saved" | "history"

export interface SidebarOptions {
  /** The API catalog; without it (artifacts built before M4) there is no Docs tab. */
  readonly index?: DocIndex
  /** Saved-queries and history panes (see `renderSavedPanes`). */
  readonly saved: HTMLElement
  readonly history: HTMLElement
  /** Insert `text` at the editor cursor and put the cursor `cursorBack` characters before its end. */
  readonly onInsert: (item: DocItem) => void
  readonly onInsertExample: (source: string) => void
  /** Put a gallery query into the editor; `run` also runs it. */
  readonly onLoadQuery: (query: GalleryQuery, run: boolean) => void
  /** Escape inside the sidebar: the panel closes it and puts focus back on its toggle. */
  readonly onClose?: () => void
}

export interface Sidebar {
  readonly el: HTMLElement
  readonly show: (tab: SidebarTab) => void
  /** Opens the docs tab on one entry (what hover links to). */
  readonly showDoc: (id: string) => void
}

const el = <K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = doc.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const button = (doc: Document, label: string, testid: string, onClick: () => void): HTMLButtonElement => {
  const b = el(doc, "button", undefined, label)
  b.type = "button"
  b.dataset.testid = testid
  b.addEventListener("click", onClick)
  return b
}

export const renderSidebar = (doc: Document, opts: SidebarOptions): Sidebar => {
  const root = el(doc, "aside", "qb-side")
  root.dataset.testid = "sidebar"
  root.setAttribute("aria-label", "Docs, gallery, saved queries and history")
  root.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); opts.onClose?.() } })
  const tabs = el(doc, "div", "tabs")
  tabs.setAttribute("role", "tablist")
  tabs.setAttribute("aria-label", "Sidebar sections")
  const tabButtons = new Map<SidebarTab, HTMLButtonElement>()
  const panes = new Map<SidebarTab, HTMLElement>()
  const addTab = (tab: SidebarTab, label: string, pane: HTMLElement) => {
    const b = button(doc, label, `tab-${tab}`, () => show(tab))
    b.setAttribute("role", "tab")
    b.id = `qb-tab-${tab}`
    b.setAttribute("aria-controls", `qb-pane-${tab}`)
    pane.id = `qb-pane-${tab}`
    pane.setAttribute("role", "tabpanel")
    pane.setAttribute("aria-labelledby", b.id)
    tabButtons.set(tab, b)
    panes.set(tab, pane)
    tabs.append(b)
  }

  // --- Docs ---------------------------------------------------------------
  const docsPane = el(doc, "div", "pane docs")
  docsPane.dataset.testid = "docs-pane"
  const index = opts.index
  const search = el(doc, "input")
  search.type = "search"
  search.placeholder = `Search ${index?.items.length ?? 0} entries (name, category, text)`
  search.dataset.testid = "docs-search"
  search.setAttribute("aria-label", "Search the API docs")
  const list = el(doc, "div", "doc-list")
  list.dataset.testid = "docs-list"
  const detail = el(doc, "div", "doc-detail")
  detail.dataset.testid = "docs-detail"
  detail.textContent = "Select an entry to see its signature, notes and examples."
  docsPane.append(search, list, detail)

  let selectedId: string | undefined
  const renderList = () => {
    list.replaceChildren()
    const items = index ? searchDocs(index, search.value) : []
    if (items.length === 0) list.append(el(doc, "div", "empty", "No entries match."))
    let category: string | undefined
    for (const i of items) {
      // Grouped by category only while browsing; search results are ranked, so they stay flat.
      if (!search.value.trim() && i.category !== category) {
        category = i.category
        list.append(el(doc, "div", "cat", category))
      }
      const row = button(doc, i.id, "doc-item", () => select(i.id))
      row.className = `doc-item${i.id === selectedId ? " selected" : ""}`
      row.dataset.docId = i.id
      row.title = i.summary
      list.append(row)
    }
  }
  const select = (id: string) => {
    const item = index?.byId.get(id)
    if (!item) return
    selectedId = id
    for (const r of Array.from(list.querySelectorAll<HTMLElement>(".doc-item"))) {
      r.classList.toggle("selected", r.dataset.docId === id)
      if (r.dataset.docId === id) r.setAttribute("aria-current", "true"); else r.removeAttribute("aria-current")
    }
    detail.replaceChildren()
    const title = el(doc, "div", "title")
    title.append(el(doc, "strong", undefined, item.id), el(doc, "span", "kind", ` ${item.kind} · ${item.category}`))
    const sig = el(doc, "pre", "sig", item.signature)
    const summary = el(doc, "p", undefined, item.summary || "(no description)")
    detail.append(title, sig, summary, button(doc, "Insert", "doc-insert", () => opts.onInsert(item)))
    for (const ex of item.examples) {
      const box = el(doc, "div", "example")
      box.append(el(doc, "pre", undefined, ex), button(doc, "Insert example", "doc-insert-example", () => opts.onInsertExample(ex)))
      detail.append(box)
    }
  }
  search.addEventListener("input", renderList)
  renderList()

  // --- Gallery ------------------------------------------------------------
  const galleryPane = el(doc, "div", "pane gallery")
  galleryPane.dataset.testid = "gallery-pane"
  for (const q of GALLERY) {
    const card = el(doc, "div", "card")
    card.dataset.queryId = q.id
    card.setAttribute("role", "group")
    card.setAttribute("aria-label", q.title)
    card.dataset.testid = "gallery-card"
    card.append(el(doc, "strong", undefined, q.title), el(doc, "p", undefined, q.description))
    if (q.requires.length > 0) card.append(el(doc, "div", "needs", `Needs: ${q.requires.join(", ")}`))
    if (q.note) {
      const note = el(doc, "div", "warning", q.note)
      note.dataset.testid = "gallery-note"
      card.append(note)
    }
    card.append(el(doc, "pre", undefined, q.source))
    const actions = el(doc, "div", "actions")
    actions.append(button(doc, "Load", "gallery-load", () => opts.onLoadQuery(q, false)), button(doc, "Load & run", "gallery-run", () => opts.onLoadQuery(q, true)))
    card.append(actions)
    galleryPane.append(card)
  }

  if (index) addTab("docs", "Docs", docsPane)
  addTab("gallery", "Gallery", galleryPane)
  addTab("saved", "Saved", opts.saved)
  addTab("history", "History", opts.history)
  root.append(tabs, ...panes.values())

  const show = (tab: SidebarTab) => {
    if (!panes.has(tab)) tab = "gallery"
    for (const [t, pane] of panes) pane.hidden = t !== tab
    for (const [t, b] of tabButtons) {
      b.classList.toggle("active", t === tab)
      b.setAttribute("aria-selected", String(t === tab))
      b.tabIndex = t === tab ? 0 : -1 // roving tabindex: arrow keys move between tabs
    }
    root.dataset.tab = tab
  }
  tabs.addEventListener("keydown", (e) => {
    const order = [...tabButtons.keys()]
    const at = order.indexOf(root.dataset.tab as SidebarTab)
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : undefined
    if (to === undefined) return
    e.preventDefault()
    const tab = order[(to + order.length) % order.length]!
    show(tab)
    tabButtons.get(tab)!.focus()
  })
  show(index ? "docs" : "gallery")
  return {
    el: root,
    show,
    showDoc: (id) => {
      show("docs")
      search.value = ""
      renderList()
      select(id)
      list.querySelector(`[data-doc-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" })
    },
  }
}
