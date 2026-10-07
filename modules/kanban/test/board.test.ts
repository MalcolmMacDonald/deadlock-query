import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { BoardView, columnOf, fixtureIssues, groupByColumn, moduleOf } from "../src/index.ts"

describe("board", () => {
  test("columns", () => {
    expect(fixtureIssues.map(columnOf)).toEqual(["Backlog", "In Progress", "Review", "Review", "Done", "Reverted"])
  })
  test("module label must be unique", () => {
    expect(moduleOf({ number: 1, title: "x", labels: ["module:a", "module:b"], state: "open" })).toBeUndefined()
    expect(moduleOf(fixtureIssues[0]!)).toBe("map-viewer")
  })
  test("single lane filters by module", () => {
    const g = groupByColumn(fixtureIssues, "map-viewer")
    expect(g.Backlog.length).toBe(1)
    expect(g.Reverted.length).toBe(1)
    expect(g.Review.length).toBe(0)
  })
  test("renders fixture issues", () => {
    const html = renderToStaticMarkup(createElement(BoardView, { issues: fixtureIssues, module: "map-metadata" }))
    expect(html).toContain("Editor panel")
    expect(html).toContain("CI pending")
  })
})
