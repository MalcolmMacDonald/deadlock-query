import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GitHubApi, ProxyGitHubApi } from "../src/index.ts"

/** Endpoints the dev proxy allows for kanban (mirrors infra's allowlist; infra's own tests pin the other side). */
const ALLOWED = [
  ["GET", /^\/issues$/], ["POST", /^\/issues$/], ["GET", /^\/issues\/\d+\/comments$/], ["POST", /^\/issues\/\d+\/comments$/],
  ["GET", /^\/pulls$/], ["GET", /^\/actions\/runs$/], ["POST", /^\/actions\/workflows\/[\w.-]+\/dispatches$/]
] as const
const decide = (method: string, url: URL, headers: Headers): { ok: true } | { ok: false; status: number } => {
  if (headers.get("x-dlq-csrf") !== "1") return { ok: false, status: 403 }
  const rest = url.pathname.replace("/api/github", "")
  return ALLOWED.some(([m, re]) => m === method && re.test(rest)) ? { ok: true } : { ok: false, status: 404 }
}

/** A fake `fetch` that records calls, answers from canned bodies, and rejects anything the proxy would not forward. */
const fake = (answers: Record<string, unknown>) => {
  const calls: { method: string; path: string; body?: unknown; headers: Headers }[] = []
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const headers = new Headers(init.headers)
    const url = new URL(input, "https://dev.example")
    const d = decide(method, url, headers)
    if (!d.ok) return new Response("{}", { status: d.status })
    calls.push({ method, path: url.pathname.replace("/api/github", "") + url.search, headers, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const key = `${method} ${url.pathname.replace("/api/github", "")}`
    return new Response(JSON.stringify(answers[key] ?? {}), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}
const run = <A>(f: Fake, eff: (api: GitHubApi["Service"]) => Effect.Effect<A, Error>) =>
  Effect.runPromise(Effect.gen(function* () { return yield* eff(yield* GitHubApi) }).pipe(Effect.provide(ProxyGitHubApi(f.fetchFn, "/api/github"))))
type Fake = ReturnType<typeof fake>

describe("ProxyGitHubApi", () => {
  test("lists issues, drops pull requests, links PRs by branch and maps CI", async () => {
    const f = fake({
      "GET /issues": [
        { number: 1, title: "A", state: "open", labels: [{ name: "module:shell" }, { name: "claude" }] },
        { number: 5, title: "a PR", state: "open", labels: [], pull_request: {} }
      ],
      "GET /pulls": [{ number: 9, head: { ref: "claude/shell/1-thing" }, merged_at: null }],
      "GET /actions/runs": { workflow_runs: [{ head_branch: "claude/shell/1-thing", status: "completed", conclusion: "failure" }] }
    })
    const issues = await run(f, (api) => api.listIssues)
    expect(issues).toEqual([{ number: 1, title: "A", labels: ["module:shell", "claude"], state: "open", pr: { number: 9, ci: "failure", merged: false } }])
    expect(f.calls.every((c) => c.headers.get("x-dlq-csrf") === "1")).toBe(true)
  })
  test("creates issues, comments and promotes through allowed endpoints", async () => {
    const f = fake({
      "POST /issues": { number: 7, title: "T", state: "open", labels: [{ name: "module:shell" }] },
      "POST /issues/7/comments": { id: 3, user: { login: "m" }, body: "@claude hi" },
      "GET /actions/runs": { workflow_runs: [{ status: "in_progress" }] }
    })
    const issue = await run(f, (api) => api.createIssue({ title: "T", body: "b", labels: ["module:shell"] }))
    expect(issue.number).toBe(7)
    expect(await run(f, (api) => api.addComment(7, "@claude hi"))).toEqual({ id: 3, author: "m", body: "@claude hi" })
    expect(await run(f, (api) => api.mainCi)).toBe("pending")
    await run(f, (api) => api.promote)
    const dispatch = f.calls.at(-1)!
    expect(dispatch.path).toBe("/actions/workflows/deploy.yml/dispatches")
    expect(dispatch.body).toEqual({ ref: "main", inputs: { promote: "true" } })
  })
  test("surfaces proxy refusals as errors", async () => {
    const bad: typeof fetch = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch
    const eff = Effect.gen(function* () { return yield* (yield* GitHubApi).mainCi }).pipe(Effect.provide(ProxyGitHubApi(bad)))
    await expect(Effect.runPromise(eff)).rejects.toThrow("403")
  })
})
