import { Context, Effect, Layer } from "effect"

export interface Issue {
  readonly number: number
  readonly title: string
  readonly labels: ReadonlyArray<string>
  readonly state: "open" | "closed"
  /** Linked pull request, when one exists. */
  readonly pr?: { readonly number: number; readonly ci: "pending" | "success" | "failure"; readonly merged: boolean }
}

export interface IssueDraft {
  readonly title: string
  readonly body: string
  readonly labels: ReadonlyArray<string>
}

/** All GitHub access goes through this service; the live implementation is the dev-site proxy (infra M5). */
export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    readonly listIssues: Effect.Effect<ReadonlyArray<Issue>, Error>
    readonly createIssue: (draft: IssueDraft) => Effect.Effect<Issue, Error>
  }
>()("@deadlock-query/kanban/GitHubApi") {}

export const fixtureIssues: ReadonlyArray<Issue> = [
  { number: 1, title: "Add lane toggle", labels: ["module:map-viewer"], state: "open" },
  { number: 2, title: "Faster nav query", labels: ["module:spatial-core", "claude"], state: "open" },
  { number: 3, title: "Editor panel", labels: ["module:map-metadata", "claude"], state: "open", pr: { number: 10, ci: "pending", merged: false } },
  { number: 4, title: "Library defaults", labels: ["module:query-library"], state: "open", pr: { number: 11, ci: "success", merged: false } },
  { number: 5, title: "Shell layout", labels: ["module:shell"], state: "closed", pr: { number: 12, ci: "success", merged: true } },
  { number: 6, title: "Bad tiling", labels: ["module:map-viewer", "reverted"], state: "closed" }
]

export const MockGitHubApi = (initial: ReadonlyArray<Issue> = fixtureIssues) =>
  Layer.sync(GitHubApi)(() => {
    const issues = [...initial]
    return {
      listIssues: Effect.sync(() => [...issues]),
      createIssue: (draft) =>
        Effect.sync(() => {
          const issue: Issue = { number: Math.max(0, ...issues.map((i) => i.number)) + 1, title: draft.title, labels: draft.labels, state: "open" }
          issues.push(issue)
          return issue
        })
    }
  })
