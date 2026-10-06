import type { QueryResult } from "@deadlock-query/contracts"
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, cellText, makeTableModel, type SortDir, type TableState } from "./tableModel.ts"

export interface ResultsTableOptions {
  readonly onRowSelect?: (rowId: string) => void | Promise<void>
  readonly selectedRows?: ReadonlySet<string>
}

export interface ResultsTable {
  readonly el: HTMLElement
  /** Marks these row ids selected (on the current page) without rebuilding the table, so focus, sort and filters stay put. */
  readonly setSelected: (ids: ReadonlySet<string>) => void
}

const FILTER_DEBOUNCE_MS = 150

const el = <K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = doc.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * The results table: sortable columns (click or Enter on a header), a filter box per column, paging,
 * and keyboard navigation (Arrow keys move between rows, Enter or Space selects, Home/End jump).
 * Built on `role="grid"` so screen readers announce rows, columns, sort order and selection.
 */
export const createResultsTable = (doc: Document, result: QueryResult, opts: ResultsTableOptions = {}): ResultsTable => {
  const model = makeTableModel(result)
  let state: TableState = { filters: {}, page: 0, pageSize: DEFAULT_PAGE_SIZE }
  let selected: ReadonlySet<string> = opts.selectedRows ?? new Set()

  const root = el(doc, "div", "results")
  const stats = el(doc, "div", "stats", `${result.stats.rowCount} rows · check ${result.stats.compileMs} ms · run ${result.stats.runMs} ms`)
  stats.dataset.testid = "stats"
  root.append(stats)
  for (const w of result.warnings) {
    const b = el(doc, "div", "warning", w)
    root.append(b)
  }

  const grid = el(doc, "table")
  grid.dataset.testid = "results-table"
  grid.setAttribute("role", "grid")
  grid.setAttribute("aria-label", "Query results")
  grid.setAttribute("aria-rowcount", String(result.rows.length + 1))
  const head = grid.createTHead()
  const titles = head.insertRow()
  const filters = head.insertRow()
  titles.setAttribute("role", "row")
  filters.setAttribute("role", "row")
  const sortButtons: HTMLButtonElement[] = []
  const numeric = result.columns.map((c) => c.type === "number")
  result.columns.forEach((c, i) => {
    const th = doc.createElement("th")
    th.setAttribute("role", "columnheader")
    th.scope = "col"
    th.setAttribute("aria-sort", "none")
    th.title = c.type
    const b = el(doc, "button", "sort", c.name)
    b.type = "button"
    b.dataset.testid = "sort"
    b.dataset.col = String(i)
    b.title = `Sort by ${c.name} (${c.type})`
    b.addEventListener("click", () => {
      // none → ascending → descending → none
      const cur = state.sort?.col === i ? state.sort.dir : undefined
      const next: SortDir | undefined = cur === undefined ? "asc" : cur === "asc" ? "desc" : undefined
      state = { ...state, ...(next ? { sort: { col: i, dir: next } } : { sort: undefined }), page: 0 } as TableState
      render()
      sortButtons[i]!.focus()
    })
    sortButtons.push(b)
    th.append(b)
    titles.append(th)
    const fh = doc.createElement("th")
    fh.setAttribute("role", "columnheader")
    const input = el(doc, "input")
    input.type = "search"
    input.placeholder = numeric[i] ? "filter, e.g. >5" : "filter"
    input.setAttribute("aria-label", `Filter ${c.name}`)
    input.dataset.testid = "filter"
    input.dataset.col = String(i)
    let timer: ReturnType<typeof setTimeout> | undefined
    input.addEventListener("input", () => {
      clearTimeout(timer)
      timer = setTimeout(() => { state = { ...state, filters: { ...state.filters, [i]: input.value }, page: 0 }; render() }, FILTER_DEBOUNCE_MS)
    })
    fh.append(input)
    filters.append(fh)
  })
  const body = grid.createTBody()

  const bar = el(doc, "div", "pager")
  bar.dataset.testid = "pager"
  const info = el(doc, "span", "page-info")
  info.dataset.testid = "page-info"
  info.setAttribute("role", "status")
  info.setAttribute("aria-live", "polite")
  const mkButton = (label: string, testid: string, go: () => void) => {
    const b = el(doc, "button", undefined, label)
    b.type = "button"
    b.dataset.testid = testid
    b.addEventListener("click", go)
    return b
  }
  const prev = mkButton("Previous", "page-prev", () => { state = { ...state, page: state.page - 1 }; render() })
  const next = mkButton("Next", "page-next", () => { state = { ...state, page: state.page + 1 }; render() })
  const sizeLabel = el(doc, "label", undefined, "Rows per page ")
  const size = el(doc, "select")
  size.dataset.testid = "page-size"
  for (const n of PAGE_SIZES) size.append(Object.assign(el(doc, "option"), { value: String(n), textContent: String(n), selected: n === DEFAULT_PAGE_SIZE }))
  size.addEventListener("change", () => { state = { ...state, pageSize: Number(size.value), page: 0 }; render() })
  sizeLabel.append(size)
  bar.append(prev, next, sizeLabel, info)

  const noRows = el(doc, "div", "empty")
  noRows.dataset.testid = "no-rows"
  root.append(bar, grid, noRows)

  const rowEls = (): HTMLTableRowElement[] => Array.from(body.rows)
  const select = (tr: HTMLTableRowElement) => { void opts.onRowSelect?.(tr.dataset.rowId!) }

  const render = () => {
    const v = model.view(state)
    state = { ...state, page: v.page }
    result.columns.forEach((_, i) => {
      const dir = state.sort?.col === i ? state.sort.dir : undefined
      const th = titles.cells[i]!
      th.setAttribute("aria-sort", dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none")
      sortButtons[i]!.textContent = `${result.columns[i]!.name}${dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : ""}`
    })
    body.replaceChildren()
    v.rows.forEach((ri, n) => {
      const row = result.rows[ri]!
      const rowId = result.rowIds[ri]!
      const tr = body.insertRow()
      tr.setAttribute("role", "row")
      tr.setAttribute("aria-rowindex", String(ri + 2))
      tr.dataset.rowId = rowId
      tr.tabIndex = n === 0 ? 0 : -1 // roving tabindex: one Tab stop for the whole table
      tr.setAttribute("aria-selected", String(selected.has(rowId)))
      if (selected.has(rowId)) tr.classList.add("selected")
      row.forEach((cell, ci) => {
        const td = tr.insertCell()
        td.setAttribute("role", "gridcell")
        const text = cellText(cell)
        td.textContent = text
        if (numeric[ci]) td.className = "num"
        if (text.length > 40) td.title = text
      })
      tr.addEventListener("click", () => select(tr))
    })
    const filtered = v.matching !== v.total
    info.textContent = v.matching === 0 ? "No rows match." : `Rows ${v.from}–${v.to} of ${v.matching}${filtered ? ` (filtered from ${v.total})` : ""}`
    prev.disabled = v.page === 0
    next.disabled = v.page >= v.pageCount - 1
    bar.hidden = v.pageCount === 1 && !filtered
    noRows.textContent = v.total === 0 ? "The query returned no rows." : v.matching === 0 ? "No rows match the filters." : ""
    noRows.hidden = noRows.textContent === ""
    grid.hidden = v.total === 0
  }

  body.addEventListener("keydown", (e) => {
    const rows = rowEls()
    const i = rows.indexOf((e.target as HTMLElement).closest("tr") as HTMLTableRowElement)
    if (i < 0) return
    const go = (n: number) => {
      const target = rows[Math.min(rows.length - 1, Math.max(0, n))]!
      for (const r of rows) r.tabIndex = -1
      target.tabIndex = 0
      target.focus()
      e.preventDefault()
    }
    if (e.key === "ArrowDown") go(i + 1)
    else if (e.key === "ArrowUp") go(i - 1)
    else if (e.key === "Home") go(0)
    else if (e.key === "End") go(rows.length - 1)
    else if (e.key === "PageDown" && !next.disabled) { e.preventDefault(); next.click(); rowEls()[0]?.focus() }
    else if (e.key === "PageUp" && !prev.disabled) { e.preventDefault(); prev.click(); rowEls()[0]?.focus() }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(rows[i]!) }
  })

  render()
  return {
    el: root,
    setSelected: (ids) => {
      selected = ids
      for (const tr of rowEls()) {
        const on = ids.has(tr.dataset.rowId!)
        tr.classList.toggle("selected", on)
        tr.setAttribute("aria-selected", String(on))
      }
    }
  }
}
