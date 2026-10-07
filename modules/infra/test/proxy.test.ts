import { expect, test } from "bun:test"
import { Effect } from "effect"
import { DevAuth } from "@deadlock-query/contracts"
import { DevAuthLive } from "../src/devAuth.ts"
import { CSRF_HEADER, REPO, checkBody, decide, sanitizeResponse, upstreamHeaders } from "../src/proxy.ts"

const keys = (h: Headers): string[] => {
  const k: string[] = []
  h.forEach((_, name) => k.push(name))
  return k.sort()
}
const ORIGIN = "https://dev.pages.dev"
const call = (method: string, path: string, headers: Record<string, string> = { [CSRF_HEADER]: "1" }) =>
  decide(method, new URL(`${ORIGIN}${path}`), new Headers(headers))

test("allows allowlisted endpoints and builds the upstream URL for the one repo", () => {
  const r = call("GET", "/api/github/issues?state=open&per_page=50")
  expect(r).toEqual({ ok: true, upstream: `https://api.github.com/repos/${REPO}/issues?state=open&per_page=50` })
  expect(call("POST", "/api/github/issues/12/comments").ok).toBe(true)
  expect(call("POST", "/api/github/actions/workflows/deploy.yml/dispatches").ok).toBe(true)
  expect(call("GET", "/api/github/contents/modules/infra/STATE.md").ok).toBe(true)
})

test("rejects missing CSRF header and cross-origin requests", () => {
  expect(call("GET", "/api/github/issues", {})).toMatchObject({ ok: false, status: 403 })
  expect(call("GET", "/api/github/issues", { [CSRF_HEADER]: "0" })).toMatchObject({ ok: false, status: 403 })
  expect(call("POST", "/api/github/issues", { [CSRF_HEADER]: "1", origin: "https://evil.example" })).toMatchObject({ ok: false, status: 403 })
  expect(call("POST", "/api/github/issues", { [CSRF_HEADER]: "1", origin: ORIGIN }).ok).toBe(true)
})

test("rejects endpoints and methods outside the allowlist", () => {
  expect(call("DELETE", "/api/github/issues/1")).toMatchObject({ ok: false, status: 405 })
  expect(call("PUT", "/api/github/contents/x.md")).toMatchObject({ ok: false, status: 405 })
  expect(call("GET", "/api/github/pulls/3/merge")).toMatchObject({ ok: false, status: 405 })
  expect(call("POST", "/api/github/pulls/3/merge")).toMatchObject({ ok: false, status: 405 })
  expect(call("PUT", "/api/github/contents/data/current-build.json")).toMatchObject({ ok: false, status: 405 })
  expect(call("DELETE", "/api/github/contents/data/metadata/a.json")).toMatchObject({ ok: false, status: 405 })
  expect(call("DELETE", "/api/github/pulls/3")).toMatchObject({ ok: false, status: 405 })
  expect(call("GET", "/api/github/collaborators")).toMatchObject({ ok: false, status: 404 })
  expect(call("GET", "/api/github/issues/abc")).toMatchObject({ ok: false, status: 404 })
})

test("allows PR-branch commits, merge and close on exact routes", () => {
  expect(call("PUT", "/api/github/contents/data/metadata/123/lanes.json").ok).toBe(true)
  expect(call("PUT", "/api/github/contents/data/submissions/a-b.json").ok).toBe(true)
  expect(call("PUT", "/api/github/pulls/7/merge").ok).toBe(true)
  expect(call("PATCH", "/api/github/pulls/7").ok).toBe(true)
})

test("checkBody confines the write routes", () => {
  const w = "/contents/data/metadata/1/a.json"
  expect(checkBody("PUT", w, '{"message":"m","content":"x","branch":"claude/meta-1"}')).toBeNull()
  expect(checkBody("PUT", w, '{"message":"m","content":"x"}')).not.toBeNull()
  expect(checkBody("PUT", w, '{"branch":"main"}')).not.toBeNull()
  expect(checkBody("PUT", w, "nope")).not.toBeNull()
  expect(checkBody("PUT", "/pulls/3/merge", '{"merge_method":"squash"}')).toBeNull()
  expect(checkBody("PUT", "/pulls/3/merge", '{"sha":"x"}')).not.toBeNull()
  expect(checkBody("PUT", "/pulls/3/merge", '{"merge_method":"bad"}')).not.toBeNull()
  expect(checkBody("PATCH", "/pulls/3", '{"state":"closed"}')).toBeNull()
  expect(checkBody("PATCH", "/pulls/3", '{"state":"open"}')).not.toBeNull()
  expect(checkBody("PATCH", "/pulls/3", '{"state":"closed","base":"x"}')).not.toBeNull()
  expect(checkBody("PATCH", "/issues/3", '{"anything":1}')).toBeNull()
})

test("rejects path traversal out of the repo", () => {
  expect(call("GET", "/api/github/contents/../../../orgs/x")).toMatchObject({ ok: false }) // URL parsing resolves ".." out of /api/github
  expect(call("GET", "/api/github/contents/%2e%2e/x").ok).toBe(false)
  expect(call("GET", "/api/github/contents/a%2fb").ok).toBe(false)
})

test("upstream headers carry only the token; response never echoes credentials", async () => {
  const h = upstreamHeaders("ghp_secret", true)
  expect(keys(h)).toEqual(["accept", "authorization", "content-type", "user-agent", "x-github-api-version"])
  const res = sanitizeResponse(new Response('{"ok":1}', { headers: { "set-cookie": "a=b", authorization: "x", "www-authenticate": "y", "x-ratelimit-remaining": "42" } }))
  expect(keys(res.headers)).toEqual(["cache-control", "content-type", "x-ratelimit-remaining"])
  expect(await res.text()).not.toContain("ghp_secret")
})

test("DevAuthLive maps /auth/session and /auth/login", async () => {
  const fake = (async (url: string, init?: RequestInit) =>
    url.endsWith("/auth/session") ? new Response("{}", { status: 401 })
    : new Response(null, { status: new URLSearchParams(init?.body as URLSearchParams).get("password") === "ok" ? 303 : 401 })) as unknown as typeof fetch
  const run = <A>(e: Effect.Effect<A, never, DevAuth>) => Effect.runPromise(e.pipe(Effect.provide(DevAuthLive(fake))))
  expect(await run(Effect.gen(function* () { return yield* (yield* DevAuth).status }))).toBe("anonymous")
  expect(await run(Effect.gen(function* () { return yield* (yield* DevAuth).login("ok") }))).toBe(true)
  expect(await run(Effect.gen(function* () { return yield* (yield* DevAuth).login("no") }))).toBe(false)
})
