import { makeResult, type ColumnType, type QueryResult } from "@deadlock-query/contracts"
import { LIMITS } from "../sandbox/limits.ts"

/** Hard cap so a runaway query cannot flood the table. The worker already cuts to this; this is the backstop. */
export const MAX_ROWS = LIMITS.maxRows

const isNum3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number")
const isEntity = (v: unknown): v is { id: string } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { id?: unknown }).id === "string" && "position" in v

const typeOf = (v: unknown): ColumnType | undefined => {
  if (v === null || v === undefined) return undefined
  if (typeof v === "number") return "number"
  if (typeof v === "boolean") return "bool"
  if (typeof v === "string") return "string"
  if (isEntity(v)) return "entityRef"
  if (isNum3(v)) return "point"
  if (Array.isArray(v) && v.length >= 2 && v.every(isNum3)) return v.length === 2 ? "segment" : "polyline"
  return "string"
}

const cell = (v: unknown): unknown => (isEntity(v) ? v.id : v === undefined ? null : v)

const columnType = (values: ReadonlyArray<unknown>): ColumnType => {
  const types = new Set(values.map(typeOf).filter((t): t is ColumnType => t !== undefined))
  if (types.size === 1) return [...types][0]!
  // A segment column may contain polylines of other lengths; any geometry mix degrades to polyline.
  if ([...types].every((t) => t === "segment" || t === "polyline")) return "polyline"
  return "string"
}

/**
 * Projects the JSON-like value a query returned into a `QueryResult` table.
 * Arrays of arrays → positional columns `c1…`; arrays of objects → one column per key
 * (first-seen order); arrays of scalars and single values → a `value` column.
 * Row IDs are derived from entityRef cells when present, otherwise from row index.
 */
export const projectResult = (
  value: unknown,
  stats: { compileMs: number; runMs: number },
  warnings: ReadonlyArray<string> = []
): QueryResult => {
  const items: unknown[] = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  const warns = [...warnings]
  let list = items
  if (list.length > MAX_ROWS) {
    warns.push(`Result truncated to ${MAX_ROWS} of ${items.length} rows.`)
    list = list.slice(0, MAX_ROWS)
  }

  let names: string[]
  let rows: unknown[][]
  let rawItems: unknown[] = list // Keep the original items to extract IDs
  const plainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) && !isEntity(v)
  const isTuple = (v: unknown): v is unknown[] => Array.isArray(v) && !isNum3(v) && !(v.length >= 2 && v.every(isNum3))

  if (list.length > 0 && list.every(isTuple)) {
    const width = Math.max(...(list as unknown[][]).map((r) => r.length))
    names = Array.from({ length: width }, (_, i) => `c${i + 1}`)
    rows = (list as unknown[][]).map((r) => names.map((_, i) => r[i]))
  } else if (list.length > 0 && list.every(plainObject)) {
    const keys = new Set<string>()
    for (const o of list as Record<string, unknown>[]) for (const k of Object.keys(o)) keys.add(k)
    names = [...keys]
    rows = (list as Record<string, unknown>[]).map((o) => names.map((k) => o[k]))
  } else {
    names = ["value"]
    rows = list.map((v) => [v])
  }

  const columns = names.map((name, i) => ({ name, type: columnType(rows.map((r) => r[i])) }))
  const cells = rows.map((r) => r.map((v, i) => (columns[i]!.type === "string" && typeof v === "object" && v !== null && !isEntity(v) ? JSON.stringify(v) : cell(v))))

  // Generate row IDs: use entity ID if the item is an entity, otherwise use row index
  const rowIds = rawItems.map((item, idx) => isEntity(item) ? item.id : String(idx))

  return makeResult(columns, cells, rowIds, { warnings: warns, stats: { rowCount: cells.length, ...stats } })
}
