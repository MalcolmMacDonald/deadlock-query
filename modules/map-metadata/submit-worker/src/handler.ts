import { checkDocument, MAX_BYTES, type Issue } from "../../src/index.ts"
import type { Submission } from "@deadlock-query/contracts"

/** Minimal key-value store (a Cloudflare KV namespace satisfies it). Used for rate-limit counters. */
export interface Counters {
  get: (key: string) => Promise<string | null>
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>
}

export interface Env {
  /** Token that may create branches, files and PRs in `GITHUB_REPO` (fine-grained PAT or GitHub App installation token). */
  readonly GITHUB_TOKEN: string
  /** `owner/name`. */
  readonly GITHUB_REPO: string
  /** Base branch for submission PRs; default `main`. */
  readonly BASE_BRANCH?: string
  readonly RATE: Counters
  /** Limits; defaults below. */
  readonly PER_IP_PER_HOUR?: string
  readonly GLOBAL_PER_DAY?: string
  /** Origin(s) allowed to call from a browser (CORS), comma separated; the request's own origin is echoed when listed. Unset = no CORS headers. */
  readonly ALLOWED_ORIGIN?: string
}

export interface Deps {
  readonly fetch: typeof fetch
  readonly now: () => number
}

export const DEFAULT_PER_IP_PER_HOUR = 5
export const DEFAULT_GLOBAL_PER_DAY = 200
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const json = (status: number, body: unknown, env: Env, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(env.ALLOWED_ORIGIN ? { "access-control-allow-origin": env.ALLOWED_ORIGIN, vary: "Origin" } : {}),
      ...extra
    }
  })

const fail = (status: number, code: string, message: string, env: Env, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message, ...extra } }, env, headers)

/** Counts one hit in a window; returns false when over `limit`. Not atomic (KV is eventually consistent): a soft limit. */
const hit = async (env: Env, key: string, limit: number, ttl: number): Promise<boolean> => {
  const n = Number(await env.RATE.get(key).catch(() => null) ?? 0)
  if (n >= limit) return false
  await env.RATE.put(key, String(n + 1), { expirationTtl: ttl }).catch(() => undefined)
  return true
}

/** A fence longer than any backtick run in `text`, so user text cannot close it. */
const fenced = (text: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const f = "`".repeat(Math.max(3, longest + 1))
  return `${f}text\n${text}\n${f}`
}

const prBody = (s: Submission): string => [
  `Submission \`${s.id}\` for ${s.mapName} (${s.gameBuildId}): ${s.records.length} record${s.records.length === 1 ? "" : "s"}.`,
  "",
  "Submitter (self-declared, unverified) and note, shown as plain text:",
  "",
  fenced([`name: ${s.submitter.name}`, ...(s.submitter.github ? [`github: ${s.submitter.github}`] : []), ...(s.note ? [`note: ${s.note}`] : [])].join("\n")),
  "",
  "Created by the submit worker. Review in the dev site's review panel; nothing here touches `data/metadata/`."
].join("\n")

interface GhResult { ok: boolean; status: number; body: any }

const makeGithub = (env: Env, deps: Deps) => async (method: string, path: string, body?: unknown): Promise<GhResult> => {
  const res = await deps.fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "deadlock-query-submit-worker", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }
}

const toBase64 = (text: string): string => { let s = ""; for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b); return btoa(s) }

/** Branch `metadata-submission/<id>`, file `data/submissions/<id>.json`, PR labelled `metadata-submission`. */
export const createSubmissionPr = async (s: Submission, text: string, env: Env, deps: Deps): Promise<{ readonly url: string } | { readonly error: string }> => {
  const gh = makeGithub(env, deps)
  const base = env.BASE_BRANCH ?? "main"
  const ref = await gh("GET", `/git/ref/heads/${base}`)
  if (!ref.ok) return { error: `base branch lookup failed (${ref.status})` }
  const branch = `metadata-submission/${s.id}`
  const mk = await gh("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: ref.body.object?.sha })
  if (!mk.ok) return { error: `branch creation failed (${mk.status})` }
  const put = await gh("PUT", `/contents/data/submissions/${s.id}.json`, { message: `Metadata submission ${s.id}`, content: toBase64(text), branch })
  if (!put.ok) return { error: `file upload failed (${put.status})` }
  const pr = await gh("POST", "/pulls", { title: `Metadata submission ${s.id} (${s.records.length} records)`, head: branch, base, body: prBody(s) })
  if (!pr.ok) return { error: `pull request creation failed (${pr.status})` }
  // The label is best effort: a missing label must not lose the submission.
  await gh("POST", `/issues/${pr.body.number}/labels`, { labels: ["metadata-submission"] }).catch(() => undefined)
  return { url: String(pr.body.html_url) }
}

/**
 * `POST /submit` with a `Submission` JSON body. No user interaction is needed (no human check). Checks, in order: method,
 * size, per-IP and global rate limits, JSON + schema + validators (degraded mode: no collision on the server), id safety. Then it
 * opens a PR. Errors never echo submitted text beyond validator messages.
 */
/** The request's `Origin` if the comma-separated allow list has it, else `undefined`. */
export const matchOrigin = (req: Request, list: string | undefined): string | undefined => {
  const origin = req.headers.get("origin")
  return origin && list ? list.split(",").map((x) => x.trim()).filter(Boolean).find((x) => x === origin) : undefined
}

export const handleRequest = async (req: Request, envIn: Env, deps: Deps = { fetch, now: Date.now }): Promise<Response> => {
  // From here `env.ALLOWED_ORIGIN` is the single matched origin (or none), which is what the response helpers echo.
  const matched = matchOrigin(req, envIn.ALLOWED_ORIGIN)
  const { ALLOWED_ORIGIN: _list, ...rest } = envIn
  const env: Env = matched ? { ...rest, ALLOWED_ORIGIN: matched } : rest
  const url = new URL(req.url)
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: env.ALLOWED_ORIGIN ? { "access-control-allow-origin": env.ALLOWED_ORIGIN, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } : {} })
  if (url.pathname !== "/submit") return fail(404, "not-found", "Not found", env)
  if (req.method !== "POST") return fail(405, "method", "Use POST", env, {}, { allow: "POST" })

  const declared = Number(req.headers.get("content-length") ?? 0)
  if (declared > MAX_BYTES.submission) return fail(413, "too-large", `Submissions are limited to ${MAX_BYTES.submission} bytes`, env)

  const ip = req.headers.get("cf-connecting-ip") ?? undefined
  const hourly = Number(env.PER_IP_PER_HOUR ?? DEFAULT_PER_IP_PER_HOUR)
  const daily = Number(env.GLOBAL_PER_DAY ?? DEFAULT_GLOBAL_PER_DAY)
  if (!(await hit(env, `ip:${ip ?? "unknown"}`, hourly, 3600)) || !(await hit(env, "global", daily, 86400)))
    return fail(429, "rate-limited", "Too many submissions, try again later", env, {}, { "retry-after": "3600" })

  const text = await req.text()
  if (new TextEncoder().encode(text).length > MAX_BYTES.submission) return fail(413, "too-large", `Submissions are limited to ${MAX_BYTES.submission} bytes`, env)
  const report = checkDocument(text, {}, { as: "submission" })
  if (!report.ok) {
    const issues = report.issues.filter((i: Issue) => i.severity === "error").slice(0, 20).map((i) => ({ code: i.code, message: i.message, ...(i.recordId ? { recordId: i.recordId } : {}) }))
    return fail(issues.some((i) => i.code === "json") ? 400 : 422, "invalid", "The submission did not pass validation", env, { issues })
  }
  const submission = JSON.parse(text) as Submission
  if (!SAFE_ID.test(submission.id)) return fail(422, "invalid", "The submission id may only contain letters, digits, dot, dash and underscore", env, { issues: [{ code: "id", message: "unsafe submission id" }] })
  if (submission.records.some((r) => r.status !== "proposed")) return fail(422, "invalid", "Only proposed records may be submitted", env)

  const pr = await createSubmissionPr(submission, text, env, deps)
  if ("error" in pr) return fail(502, "github", "The submission could not be saved, try the download fallback", env, { detail: pr.error })
  return json(201, { id: submission.id, url: pr.url }, env)
}
