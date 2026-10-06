import { expect, test } from "bun:test"
import { makeResult } from "@deadlock-query/contracts"
import { DEFAULT_PAGE_SIZE, cellText, makeFilter, makeTableModel, type TableState } from "../src/results/tableModel.ts"

const result = makeResult(
  [{ name: "id", type: "string" }, { name: "n", type: "number" }, { name: "p", type: "point" }],
  [["b10", 5, [0, 0, 0]], ["a2", 20, [1, 1, 1]], ["a10", null, [2, 2, 2]], ["B1", 7.12345, [3, 3, 3]], ["c", 5, [4, 4, 4]]]
)
const base: TableState = { filters: {}, page: 0, pageSize: DEFAULT_PAGE_SIZE }
const ids = (rows: ReadonlyArray<number>) => rows.map((i) => result.rows[i]![0])

test("no sort, filter or paging shows the query's own order", () => {
  const v = makeTableModel(result).view(base)
  expect(ids(v.rows)).toEqual(["b10", "a2", "a10", "B1", "c"])
  expect(v).toMatchObject({ matching: 5, total: 5, page: 0, pageCount: 1, from: 1, to: 5 })
})

test("sorting is natural for text, numeric for numbers, stable, and puts blanks last both ways", () => {
  const m = makeTableModel(result)
  expect(ids(m.view({ ...base, sort: { col: 0, dir: "asc" } }).rows)).toEqual(["a2", "a10", "B1", "b10", "c"])
  expect(ids(m.view({ ...base, sort: { col: 0, dir: "desc" } }).rows)).toEqual(["c", "b10", "B1", "a10", "a2"])
  expect(ids(m.view({ ...base, sort: { col: 1, dir: "asc" } }).rows)).toEqual(["b10", "c", "B1", "a2", "a10"]) // 5, 5 keep query order; blank last
  expect(ids(m.view({ ...base, sort: { col: 1, dir: "desc" } }).rows)).toEqual(["a2", "B1", "b10", "c", "a10"])
  expect(ids(m.view(base).rows)).toEqual(["b10", "a2", "a10", "B1", "c"]) // sort can be cleared
})

test("text filters match anywhere, ignoring case, and combine across columns", () => {
  const m = makeTableModel(result)
  expect(ids(m.view({ ...base, filters: { 0: "A" } }).rows)).toEqual(["a2", "a10"])
  expect(ids(m.view({ ...base, filters: { 0: "a", 1: "2" } }).rows)).toEqual(["a2"])
  expect(ids(m.view({ ...base, filters: { 2: "[3," } }).rows)).toEqual(["B1"]) // geometry cells match on their JSON
  expect(m.view({ ...base, filters: { 0: "zzz" } })).toMatchObject({ matching: 0, from: 0, to: 0, rows: [] })
  expect(ids(m.view({ ...base, filters: { 0: "   " } }).rows)).toHaveLength(5)
})

test("number columns accept comparisons; other columns treat them as text", () => {
  const m = makeTableModel(result)
  expect(ids(m.view({ ...base, filters: { 1: ">5" } }).rows)).toEqual(["a2", "B1"])
  expect(ids(m.view({ ...base, filters: { 1: "<=5" } }).rows)).toEqual(["b10", "c"])
  expect(ids(m.view({ ...base, filters: { 1: "= 20" } }).rows)).toEqual(["a2"])
  expect(ids(m.view({ ...base, filters: { 1: ">=7.12345" } }).rows)).toEqual(["a2", "B1"])
  expect(makeFilter(">5", false)!(7, "7")).toBe(false) // text match, not a comparison
  expect(makeFilter(">5", false)!("x", "a >5 b")).toBe(true)
  expect(makeFilter("", true)).toBeUndefined()
})

test("paging clamps to the last page and reports the visible range", () => {
  const rows = Array.from({ length: 250 }, (_, i) => [`r${i}`, i])
  const big = makeResult([{ name: "id", type: "string" }, { name: "n", type: "number" }], rows)
  const m = makeTableModel(big)
  const first = m.view({ filters: {}, page: 0, pageSize: 100 })
  expect(first).toMatchObject({ pageCount: 3, from: 1, to: 100, matching: 250 })
  expect(m.view({ filters: {}, page: 2, pageSize: 100 })).toMatchObject({ from: 201, to: 250 })
  expect(m.view({ filters: {}, page: 99, pageSize: 100 }).page).toBe(2)
  expect(m.view({ filters: {}, page: -4, pageSize: 100 }).page).toBe(0)
  // A filter that leaves fewer rows pulls the page back into range.
  expect(m.view({ filters: { 1: "<10" }, page: 2, pageSize: 100 })).toMatchObject({ page: 0, matching: 10, pageCount: 1 })
})

test("sorting and filtering 100 000 rows is fast enough to do per keystroke", () => {
  const rows = Array.from({ length: 100_000 }, (_, i) => [`entity-${(i * 7919) % 100_000}`, i % 977])
  const m = makeTableModel(makeResult([{ name: "id", type: "string" }, { name: "n", type: "number" }], rows))
  const t0 = performance.now()
  m.view({ filters: {}, page: 0, pageSize: 100, sort: { col: 0, dir: "asc" } })
  const sortMs = performance.now() - t0
  m.view({ filters: { 0: "entity-1" }, page: 0, pageSize: 100 }) // builds the lowercase cache
  const t1 = performance.now()
  const v = m.view({ filters: { 0: "entity-12" }, page: 0, pageSize: 100 })
  const filterMs = performance.now() - t1
  expect(v.matching).toBeGreaterThan(100)
  expect(sortMs).toBeLessThan(3_000)
  expect(filterMs).toBeLessThan(500)
})

test("cell text rounds numbers and serialises objects", () => {
  expect(cellText(7.12345)).toBe("7.123")
  expect(cellText([1, 2, 3])).toBe("[1,2,3]")
  expect(cellText(null)).toBe("")
  expect(cellText(true)).toBe("true")
})
