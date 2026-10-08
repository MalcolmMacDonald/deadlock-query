import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { DrawerView, GitHubApi, HeaderView, MockGitHubApi, feedbackBody, fixtureIssues, titleBadge, tokenTotal } from "../src/index.ts"

describe("feedback", () => {
  test("prefixes @claude once and ignores blanks", () => {
    expect(feedbackBody("  fix the lane  ")).toBe("@claude fix the lane")
    expect(feedbackBody("@claude please redo")).toBe("@claude please redo")
    expect(feedbackBody("   ")).toBeUndefined()
  })
  test("sums token mentions", () => {
    const c = (id: number, body: string) => ({ id, author: "claude", body })
    expect(tokenTotal([c(1, "Used 1,200 tokens"), c(2, "and 12k tokens more"), c(3, "no usage")])).toBe(13200)
  })
  test("title badge", () => {
    expect(titleBadge("Kanban", 2)).toBe("(2) Kanban")
    expect(titleBadge("Kanban", 0)).toBe("Kanban")
  })
  test("mock round trip: feedback comment is stored under the issue", async () => {
    const out = await Effect.runPromise(Effect.gen(function* () {
      const api = yield* GitHubApi
      yield* api.addComment(3, feedbackBody("tighten it")!)
      return yield* api.comments(3)
    }).pipe(Effect.provide(MockGitHubApi())))
    expect(out.map((c) => c.body)).toEqual(["@claude tighten it"])
  })
  test("drawer shows the PR, comments and a disabled send until text is typed", () => {
    const html = renderToStaticMarkup(createElement(DrawerView, { issue: fixtureIssues[2]!, comments: [{ id: 1, author: "claude", body: "done, 5k tokens" }], onSend: () => {} }))
    expect(html).toContain("PR #10")
    expect(html).toContain("Tokens used: 5,000")
    expect(html).toContain("disabled")
  })
  test("promote is only enabled when main CI is green", () => {
    const h = (ci: "success" | "failure" | undefined, promoted = false) => renderToStaticMarkup(createElement(HeaderView, { ci, promoted, onPromote: () => {} }))
    expect(h("success")).not.toContain("disabled")
    expect(h("failure")).toContain("disabled")
    expect(h("success", true)).toContain("Promote requested")
  })
})
