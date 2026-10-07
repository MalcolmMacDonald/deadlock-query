import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { FeatureFormView, GitHubApi, MockGitHubApi, buildFeatureIssue, columnOf } from "../src/index.ts"

const mods = ["shell", "map-viewer"]
const ok = { module: "shell", title: " Add thing ", description: "d", acceptance: "a" }

describe("feature creation", () => {
  test("requires module and title", () => {
    expect(buildFeatureIssue({ ...ok, module: "" }, mods)).toEqual({ ok: false, errors: ["Choose a module"] })
    expect(buildFeatureIssue({ ...ok, module: "nope", title: "" }, mods)).toEqual({ ok: false, errors: ["Choose a module", "Title is required"] })
  })
  test("created issue has exactly one module label", () => {
    const r = buildFeatureIssue(ok, mods)
    expect(r.ok && r.draft.labels).toEqual(["module:shell"])
    expect(r.ok && r.draft.title).toBe("Add thing")
    expect(r.ok && r.draft.body).toContain("## Acceptance criteria\na")
  })
  test("mock API creates a backlog issue", async () => {
    const r = buildFeatureIssue(ok, mods)
    if (!r.ok) throw new Error("invalid")
    const issue = await Effect.runPromise(Effect.gen(function* () {
      const api = yield* GitHubApi
      yield* api.createIssue(r.draft)
      return (yield* api.listIssues).at(-1)!
    }).pipe(Effect.provide(MockGitHubApi())))
    expect(issue.number).toBe(7)
    expect(columnOf(issue)).toBe("Backlog")
  })
  test("form renders module dropdown", () => {
    const html = renderToStaticMarkup(createElement(FeatureFormView, { modules: mods, onCreate: () => {} }))
    expect(html).toContain("<option>map-viewer</option>")
  })
})
