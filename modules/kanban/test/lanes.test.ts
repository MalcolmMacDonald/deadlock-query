import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { BoardView, fixtureIssues, loadPrefs, moveLane, orderLanes, savePrefs, toggleCollapsed, type PrefsStore } from "../src/index.ts"

const memory = (): PrefsStore & { m: Map<string, string> } => {
  const m = new Map<string, string>()
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}
const mods = ["a", "b", "c"]
const empty = { order: [], collapsed: [] }

describe("lanes", () => {
  test("default order is manifest order; new modules append", () => {
    expect(orderLanes(mods, empty)).toEqual(mods)
    expect(orderLanes(["a", "b", "c", "d"], { order: ["c", "a", "gone"], collapsed: [] })).toEqual(["c", "a", "b", "d"])
  })
  test("move and toggle", () => {
    expect(moveLane(mods, empty, "c", -1).order).toEqual(["a", "c", "b"])
    expect(moveLane(mods, empty, "a", -1).order).toEqual(mods)
    const t = toggleCollapsed(empty, "b")
    expect(t.collapsed).toEqual(["b"])
    expect(toggleCollapsed(t, "b").collapsed).toEqual([])
  })
  test("persists and survives corrupt storage", () => {
    const s = memory()
    savePrefs(s, { order: ["b"], collapsed: ["a"] })
    expect(loadPrefs(s)).toEqual({ order: ["b"], collapsed: ["a"] })
    s.m.set("kanban.lanes", "{nope")
    expect(loadPrefs(s)).toEqual(empty)
  })
  test("collapsed lane hides columns", () => {
    const open = renderToStaticMarkup(createElement(BoardView, { issues: fixtureIssues, module: "shell" }))
    const shut = renderToStaticMarkup(createElement(BoardView, { issues: fixtureIssues, module: "shell", collapsed: true }))
    expect(open).toContain("Backlog")
    expect(shut).not.toContain("Backlog")
  })
})
