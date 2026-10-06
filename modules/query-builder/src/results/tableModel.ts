import type { QueryResult } from "@deadlock-query/contracts"

export type SortDir = "asc" | "desc"
export interface TableState {
  /** Column index and direction, or none (the query's own order). */
  readonly sort?: { readonly col: number; readonly dir: SortDir }
  /** Filter text by column index; blank means no filter. */
  readonly filters: Readonly<Record<number, string>>
  readonly page: number
  readonly pageSize: number
}

export interface TableView {
  /** Row indexes (into `result.rows`) on the current page, in display order. */
  readonly rows: ReadonlyArray<number>
  /** Rows that pass the filters. */
  readonly matching: number
  readonly total: number
  readonly page: number
  readonly pageCount: number
  /** 1-based first/last row shown, 0 when nothing matches. */
  readonly from: number
  readonly to: number
}

export const PAGE_SIZES = [50, 100, 200, 500] as const
export const DEFAULT_PAGE_SIZE = 100

/** How a cell reads as text: what the filter matches and what the table shows (numbers rounded to 3 places). */
export const cellText = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : typeof v === "object" ? JSON.stringify(v) : String(v)

const NUMERIC_FILTER = /^(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?)$/

/** A predicate for one filter box. On number columns `>5`, `<=3`, `=4` compare; anything else is a case-insensitive "contains". */
export const makeFilter = (text: string, numeric: boolean): ((cell: unknown, lower: string) => boolean) | undefined => {
  const t = text.trim()
  if (!t) return undefined
  const m = numeric ? NUMERIC_FILTER.exec(t) : null
  if (m) {
    const n = Number(m[2])
    const op = m[1]!
    return (cell) => typeof cell === "number" && (op === "<" ? cell < n : op === "<=" ? cell <= n : op === ">" ? cell > n : op === ">=" ? cell >= n : cell === n)
  }
  const needle = t.toLowerCase()
  return (_cell, lower) => lower.includes(needle)
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** What a cell sorts by: numbers and booleans as numbers, everything else as its text. Blank cells have no key. */
const sortKey = (v: unknown): number | string | undefined =>
  v === null || v === undefined ? undefined : typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : cellText(v)

const compareKeys = (x: number | string, y: number | string): number =>
  typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y))

/**
 * Sorting, filtering and paging over a result's rows, without copying them. Lowercased cell text is
 * computed once per column on first filter, so typing in a filter box over 100 000 rows stays cheap.
 */
export const makeTableModel = (result: QueryResult) => {
  const lowered = new Map<number, string[]>()
  const lowerCol = (col: number) => {
    let l = lowered.get(col)
    if (!l) { l = result.rows.map((r) => cellText(r[col]).toLowerCase()); lowered.set(col, l) }
    return l
  }
  const all = Array.from({ length: result.rows.length }, (_, i) => i)
  let sortedKey = ""
  let sorted = all

  const view = (state: TableState): TableView => {
    const sortId = state.sort ? `${state.sort.col}:${state.sort.dir}` : ""
    if (sortId !== sortedKey) {
      sortedKey = sortId
      if (!state.sort) sorted = all
      else {
        const { col, dir } = state.sort
        const sign = dir === "asc" ? 1 : -1
        const keys = result.rows.map((r) => sortKey(r[col]))
        // Blank cells go last in both directions; ties keep the query's order (stable sort).
        sorted = [...all].sort((a, b) => {
          const x = keys[a], y = keys[b]
          if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1
          return sign * compareKeys(x, y)
        })
      }
    }
    const checks = Object.entries(state.filters)
      .map(([c, text]) => {
        const col = Number(c)
        const f = makeFilter(text, result.columns[col]?.type === "number")
        return f ? { col, f, lower: lowerCol(col) } : undefined
      })
      .filter((x): x is NonNullable<typeof x> => x !== undefined)
    const matchingRows = checks.length === 0 ? sorted : sorted.filter((i) => checks.every((c) => c.f(result.rows[i]![c.col], c.lower[i]!)))
    const pageSize = Math.max(1, state.pageSize)
    const pageCount = Math.max(1, Math.ceil(matchingRows.length / pageSize))
    const page = Math.min(Math.max(0, state.page), pageCount - 1)
    const rows = matchingRows.slice(page * pageSize, (page + 1) * pageSize)
    return {
      rows, matching: matchingRows.length, total: result.rows.length, page, pageCount,
      from: rows.length === 0 ? 0 : page * pageSize + 1, to: page * pageSize + rows.length
    }
  }
  return { view }
}
