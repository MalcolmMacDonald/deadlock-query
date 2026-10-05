/** GitHub proxy logic for the dev site: allowlist, CSRF check, upstream request building. Pure, so it runs in Workers and Bun. */

export const REPO = "MalcolmMacDonald/deadlock-query"
export const CSRF_HEADER = "x-dlq-csrf"
export const CSRF_VALUE = "1"

const N = "\\d+"
/** Allowed `METHOD path` pairs, relative to `/repos/${REPO}`. */
const ALLOW: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/issues$/],
  ["POST", /^\/issues$/],
  ["GET", new RegExp(`^/issues/${N}$`)],
  ["PATCH", new RegExp(`^/issues/${N}$`)],
  ["GET", new RegExp(`^/issues/${N}/comments$`)],
  ["POST", new RegExp(`^/issues/${N}/comments$`)],
  ["POST", new RegExp(`^/issues/${N}/labels$`)],
  ["GET", /^\/labels$/],
  ["GET", /^\/pulls$/],
  ["GET", new RegExp(`^/pulls/${N}$`)],
  ["GET", new RegExp(`^/pulls/${N}/comments$`)],
  ["GET", /^\/actions\/runs$/],
  ["POST", /^\/actions\/workflows\/[\w.-]+\/dispatches$/],
  ["GET", /^\/contents\/[\w./-]*$/],
]

export type ProxyDecision =
  | { readonly ok: true; readonly upstream: string }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 405; readonly reason: string }

/**
 * Decide whether a request to `/api/github/<rest>` may be forwarded. `rest` is relative to the repo.
 * Every request (not only writes) must carry the CSRF header, and a browser-sent Origin must match the site.
 */
export const decide = (method: string, url: URL, headers: Headers): ProxyDecision => {
  if (headers.get(CSRF_HEADER) !== CSRF_VALUE) return { ok: false, status: 403, reason: "missing CSRF header" }
  const origin = headers.get("origin")
  if (origin && origin !== url.origin) return { ok: false, status: 403, reason: "cross-origin request" }
  const prefix = "/api/github"
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ""
  if (rest.split("/").some((s) => s === ".." || s === ".")) return { ok: false, status: 400, reason: "bad path" }
  const matches = ALLOW.filter(([, re]) => re.test(rest))
  if (matches.length === 0) return { ok: false, status: 404, reason: "endpoint not allowed" }
  if (!matches.some(([m]) => m === method)) return { ok: false, status: 405, reason: "method not allowed" }
  return { ok: true, upstream: `https://api.github.com/repos/${REPO}${rest}${url.search}` }
}

/** Headers sent upstream: only the token, JSON accept, and a user agent. Cookies and the CSRF header are dropped. */
export const upstreamHeaders = (token: string, hasBody: boolean): Headers => {
  const h = new Headers({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "deadlock-query-dev-proxy",
  })
  if (hasBody) h.set("content-type", "application/json")
  return h
}

/** Response headers passed back to the browser (never anything that could carry credentials). */
export const sanitizeResponse = (res: Response): Response =>
  new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      ...(res.headers.has("x-ratelimit-remaining") ? { "x-ratelimit-remaining": res.headers.get("x-ratelimit-remaining")! } : {}),
    },
  })
