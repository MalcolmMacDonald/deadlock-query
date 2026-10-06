import { Effect } from "effect"
import { SelectionBus, type QueryResult } from "@deadlock-query/contracts"

const fmt = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : typeof v === "object" ? JSON.stringify(v) : String(v)

interface ResultsTableOptions {
  readonly onRowSelect?: (rowId: string) => void | Promise<void>
  readonly selectedRows?: ReadonlySet<string>
}

/** Renders a result as a plain table (M0; virtualisation/sort/filter land later). Returns the root element. */
export const renderResults = (doc: Document, result: QueryResult, opts?: ResultsTableOptions): HTMLElement => {
  const root = doc.createElement("div")
  root.className = "results"
  const stats = doc.createElement("div")
  stats.className = "stats"
  stats.dataset.testid = "stats"
  stats.textContent = `${result.stats.rowCount} rows · check ${result.stats.compileMs} ms · run ${result.stats.runMs} ms`
  root.append(stats)
  for (const w of result.warnings) {
    const b = doc.createElement("div")
    b.className = "warning"
    b.textContent = w
    root.append(b)
  }
  const table = doc.createElement("table")
  table.dataset.testid = "results-table"
  const head = table.createTHead().insertRow()
  for (const c of result.columns) {
    const th = doc.createElement("th")
    th.textContent = c.name
    th.title = c.type
    head.append(th)
  }
  const body = table.createTBody()
  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows[i]!
    const rowId = result.rowIds[i]!
    const tr = body.insertRow()
    tr.dataset.rowId = rowId
    tr.style.cursor = "pointer"

    // Add selected state styling
    if (opts?.selectedRows?.has(rowId)) {
      tr.classList.add("selected")
    }

    for (const cell of row) {
      tr.insertCell().textContent = fmt(cell)
    }

    // Add click handler for row selection
    if (opts?.onRowSelect) {
      tr.addEventListener("click", () => void opts.onRowSelect?.(rowId))
    }
  }
  root.append(table)
  return root
}
