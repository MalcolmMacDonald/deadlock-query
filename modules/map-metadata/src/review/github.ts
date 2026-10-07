import { Effect, Schema } from "effect"
import { Submission, type MetadataFile, type MetadataKind } from "@deadlock-query/contracts"
import { dataPath } from "./decide.ts"

/** One open submission PR. */
export interface QueueItem { readonly number: number; readonly title: string; readonly branch: string; readonly submissionId: string; readonly url: string; readonly author: string; readonly updatedAt: string }

/** The GitHub operations review needs. The dev site's proxy implements them (`proxyApi`); tests use a fake. */
export interface ReviewApi {
  readonly queue: () => Promise<ReadonlyArray<QueueItem>>
  readonly submission: (item: QueueItem) => Promise<Submission>
  /** Current per-kind data file on the PR branch; `undefined` when it does not exist yet. */
  readonly dataFile: (item: QueueItem, gameBuildId: string, kind: MetadataKind) => Promise<{ readonly file: MetadataFile; readonly sha: string } | undefined>
  readonly commitFile: (item: QueueItem, path: string, text: string, message: string, sha: string | undefined) => Promise<void>
  readonly merge: (item: QueueItem) => Promise<void>
  readonly close: (item: QueueItem, comment: string) => Promise<void>
  readonly comment: (item: QueueItem, text: string) => Promise<void>
}

export const BRANCH_PREFIX = "metadata-submission/"

const CSRF = { "x-dlq-csrf": "1" }
const b64 = (s: string) => { let t = ""; for (const b of new TextEncoder().encode(s)) t += String.fromCharCode(b); return btoa(t) }
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)))

export class ReviewApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }

/** `ReviewApi` over the dev site's `/api/github/*` proxy (no token in the browser). */
export const proxyApi = (fetchFn: typeof fetch = fetch, base = "/api/github"): ReviewApi => {
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetchFn(`${base}${path}`, { method, headers: { ...CSRF, ...(body ? { "content-type": "application/json" } : {}) }, credentials: "same-origin", ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body)
    if (r.status >= 300) throw new ReviewApiError(r.status, `${method} ${path} answered ${r.status}${r.body?.error ? `: ${typeof r.body.error === "string" ? r.body.error : r.body.error.message ?? ""}` : ""}`)
    return r.body
  }
  const decode = (text: string): Submission => {
    const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(Submission)(JSON.parse(text))))
    if (r._tag === "Failure") throw new ReviewApiError(422, "the submission file in the PR is not valid")
    return r.success
  }
  return {
    queue: async () => {
      const prs: any[] = await ok("GET", "/pulls?state=open&per_page=100")
      return prs.filter((p) => String(p.head?.ref ?? "").startsWith(BRANCH_PREFIX) && p.head?.repo?.full_name === p.base?.repo?.full_name)
        .map((p) => ({ number: p.number, title: String(p.title), branch: p.head.ref as string, submissionId: (p.head.ref as string).slice(BRANCH_PREFIX.length), url: String(p.html_url), author: String(p.user?.login ?? ""), updatedAt: String(p.updated_at ?? "") }))
    },
    submission: async (item) => {
      const f = await ok("GET", `/contents/data/submissions/${item.submissionId}.json?ref=${encodeURIComponent(item.branch)}`)
      return decode(unb64(String(f.content)))
    },
    dataFile: async (item, build, kind) => {
      const r = await call("GET", `/contents/${dataPath(build, kind)}?ref=${encodeURIComponent(item.branch)}`)
      if (r.status === 404) return undefined
      if (r.status >= 300) throw new ReviewApiError(r.status, `reading ${dataPath(build, kind)} answered ${r.status}`)
      return { file: JSON.parse(unb64(String(r.body.content))) as MetadataFile, sha: String(r.body.sha) }
    },
    commitFile: async (item, path, text, message, sha) => { await ok("PUT", `/contents/${path}`, { message, content: b64(text), branch: item.branch, ...(sha ? { sha } : {}) }) },
    merge: async (item) => { await ok("PUT", `/pulls/${item.number}/merge`, { merge_method: "merge" }) },
    close: async (item, comment) => { await ok("POST", `/issues/${item.number}/comments`, { body: comment }); await ok("PATCH", `/pulls/${item.number}`, { state: "closed" }) },
    comment: async (item, text) => { await ok("POST", `/issues/${item.number}/comments`, { body: text }) }
  }
}
