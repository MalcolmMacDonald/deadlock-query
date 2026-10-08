import { Effect, Layer } from "effect"
import { GitHubApi, type CiState, type Comment, type Issue } from "./github.ts"

const CSRF = { "x-dlq-csrf": "1" }

export class ProxyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const ci = (run: { status?: string; conclusion?: string | null } | undefined): CiState =>
  !run || run.status !== "completed" ? "pending" : run.conclusion === "success" ? "success" : "failure"

/** Branches `claude/<module>/<issue>-<slug>` link a PR to its issue (the convention `claude.yml` uses). */
const issueOfBranch = (branch: string): number | undefined => /^claude\/[^/]+\/(\d+)-/.exec(branch)?.[1] === undefined ? undefined : Number(/^claude\/[^/]+\/(\d+)-/.exec(branch)![1])

/** `GitHubApi` over the dev site's `/api/github/*` proxy: no token in the browser, CSRF header on every request. */
export const ProxyGitHubApi = (fetchFn: typeof fetch = fetch, base = "/api/github") => {
  const call = (method: string, path: string, body?: unknown): Effect.Effect<any, Error> =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetchFn(`${base}${path}`, {
          method,
          headers: { ...CSRF, ...(body ? { "content-type": "application/json" } : {}) },
          credentials: "same-origin",
          ...(body ? { body: JSON.stringify(body) } : {})
        })
        const json = await res.json().catch(() => ({}))
        if (res.status >= 300) throw new ProxyError(res.status, `${method} ${path} answered ${res.status}`)
        return json
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e)))
    })

  const toIssue = (raw: any, pr?: Issue["pr"]): Issue => ({
    number: raw.number,
    title: String(raw.title),
    labels: (raw.labels ?? []).map((l: any) => (typeof l === "string" ? l : String(l.name))),
    state: raw.state === "closed" ? "closed" : "open",
    ...(pr ? { pr } : {})
  })
  const toComment = (raw: any): Comment => ({ id: raw.id, author: String(raw.user?.login ?? ""), body: String(raw.body ?? "") })

  return Layer.succeed(GitHubApi)({
    listIssues: Effect.gen(function* () {
      const [issues, pulls, runs]: [any[], any[], any] = yield* Effect.all([
        call("GET", "/issues?state=all&per_page=100"),
        call("GET", "/pulls?state=all&per_page=100"),
        call("GET", "/actions/runs?event=pull_request&per_page=100")
      ])
      const runByBranch = new Map<string, any>()
      for (const r of runs.workflow_runs ?? []) if (!runByBranch.has(r.head_branch)) runByBranch.set(r.head_branch, r)
      const prByIssue = new Map<number, NonNullable<Issue["pr"]>>()
      for (const p of pulls) {
        const n = issueOfBranch(String(p.head?.ref ?? ""))
        if (n !== undefined && !prByIssue.has(n)) prByIssue.set(n, { number: p.number, ci: ci(runByBranch.get(p.head.ref)), merged: Boolean(p.merged_at) })
      }
      // The issues endpoint also lists pull requests; the board shows issues only.
      return issues.filter((i) => !i.pull_request).map((i) => toIssue(i, prByIssue.get(i.number)))
    }),
    createIssue: (draft) => call("POST", "/issues", { title: draft.title, body: draft.body, labels: draft.labels }).pipe(Effect.map((r) => toIssue(r))),
    comments: (n) => call("GET", `/issues/${n}/comments?per_page=100`).pipe(Effect.map((r: any[]) => r.map(toComment))),
    addComment: (n, body) => call("POST", `/issues/${n}/comments`, { body }).pipe(Effect.map(toComment)),
    mainCi: call("GET", "/actions/runs?branch=main&per_page=1").pipe(Effect.map((r) => ci(r.workflow_runs?.[0]))),
    promote: call("POST", "/actions/workflows/deploy.yml/dispatches", { ref: "main", inputs: { promote: "true" } }).pipe(Effect.asVoid)
  })
}
