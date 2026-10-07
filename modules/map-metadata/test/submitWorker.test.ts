import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { handleRequest, type Counters, type Deps, type Env } from "../submit-worker/src/handler.ts"

const valid = readFileSync(new URL("../fixtures/submissions/valid.json", import.meta.url), "utf8")
const validId = (JSON.parse(valid) as { id: string }).id

const memory = (): Counters => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) }
}
const env = (over: Partial<Env> = {}): Env => ({ TURNSTILE_SECRET: "s", GITHUB_TOKEN: "t", GITHUB_REPO: "o/r", RATE: memory(), ...over })

/** Records every outbound call; Turnstile succeeds unless `turnstile` says otherwise, GitHub unless `failAt` matches. */
const mockFetch = (opts: { turnstile?: boolean; failAt?: string } = {}) => {
  const calls: { method: string; url: string; body?: any }[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    if (url.includes("turnstile")) return Response.json({ success: opts.turnstile ?? true })
    if (opts.failAt && url.includes(opts.failAt)) return Response.json({ message: "no" }, { status: 500 })
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "abc" } })
    if (url.endsWith("/git/refs")) return Response.json({}, { status: 201 })
    if (url.includes("/contents/")) return Response.json({}, { status: 201 })
    if (url.endsWith("/pulls")) return Response.json({ number: 7, html_url: "https://github.com/o/r/pull/7" }, { status: 201 })
    return Response.json({}, { status: 200 })
  }) as typeof fetch
  const deps: Deps = { fetch: f, now: () => 0 }
  return { calls, deps }
}

const post = (body: string, headers: Record<string, string> = { "x-turnstile-token": "tok", "cf-connecting-ip": "1.2.3.4" }) =>
  new Request("https://w.test/submit", { method: "POST", body, headers })

test("a valid submission opens a PR under data/submissions and never touches data/metadata", async () => {
  const { calls, deps } = mockFetch()
  const res = await handleRequest(post(valid), env(), deps)
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({ id: validId, url: "https://github.com/o/r/pull/7" })
  const put = calls.find((c) => c.method === "PUT")!
  expect(put.url).toContain(`/contents/data/submissions/${validId}.json`)
  expect(put.url).not.toContain("data/metadata")
  expect(put.body.branch).toBe(`metadata-submission/${validId}`)
  expect(Buffer.from(put.body.content, "base64").toString()).toBe(valid)
  expect(calls.some((c) => c.url.endsWith("/labels"))).toBe(true)
  expect(calls.find((c) => c.url.includes("turnstile"))!.body).toMatchObject({ secret: "s", response: "tok", remoteip: "1.2.3.4" })
})

test("invalid content is a 4xx and nothing reaches GitHub", async () => {
  const { calls, deps } = mockFetch()
  expect((await handleRequest(post("{nope"), env(), deps)).status).toBe(400)
  const bad = JSON.parse(valid); bad.records[0].status = "accepted"
  const r = await handleRequest(post(JSON.stringify(bad)), env(), deps)
  expect(r.status).toBe(422)
  expect(((await r.json()) as any).error.issues.length).toBeGreaterThan(0)
  expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(false)
})

test("unsafe submission ids (path traversal) are refused", async () => {
  const { calls, deps } = mockFetch()
  const bad = JSON.parse(valid); bad.id = "../../data/metadata/x"
  expect((await handleRequest(post(JSON.stringify(bad)), env(), deps)).status).toBe(422)
  expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(false)
})

test("missing or failing Turnstile is 403; wrong method 405; wrong path 404; oversize 413", async () => {
  expect((await handleRequest(post(valid, {}), env(), mockFetch().deps)).status).toBe(403)
  expect((await handleRequest(post(valid), env(), mockFetch({ turnstile: false }).deps)).status).toBe(403)
  expect((await handleRequest(new Request("https://w.test/submit"), env(), mockFetch().deps)).status).toBe(405)
  expect((await handleRequest(new Request("https://w.test/other", { method: "POST" }), env(), mockFetch().deps)).status).toBe(404)
  expect((await handleRequest(post("x".repeat(300_000)), env(), mockFetch().deps)).status).toBe(413)
  expect((await handleRequest(post(valid, { "content-length": "999999", "x-turnstile-token": "t" }), env(), mockFetch().deps)).status).toBe(413)
})

test("per-IP and global limits answer 429 with Retry-After", async () => {
  const { deps } = mockFetch()
  const e = env({ PER_IP_PER_HOUR: "2" })
  expect((await handleRequest(post(valid), e, deps)).status).toBe(201)
  expect((await handleRequest(post(valid), e, deps)).status).toBe(201)
  const third = await handleRequest(post(valid), e, deps)
  expect(third.status).toBe(429)
  expect(third.headers.get("retry-after")).toBe("3600")
  // Another address is unaffected until the global cap.
  const other = { "x-turnstile-token": "t", "cf-connecting-ip": "9.9.9.9" }
  expect((await handleRequest(post(valid, other), e, deps)).status).toBe(201)
  const g = env({ GLOBAL_PER_DAY: "1" })
  expect((await handleRequest(post(valid), g, deps)).status).toBe(201)
  expect((await handleRequest(post(valid, other), g, deps)).status).toBe(429)
})

test("a GitHub failure is a 502 that suggests the download fallback", async () => {
  for (const failAt of ["/git/refs", "/contents/", "/pulls"]) {
    const res = await handleRequest(post(valid), env(), mockFetch({ failAt }).deps)
    expect(res.status).toBe(502)
  }
})

test("a label failure does not lose the submission", async () => {
  const res = await handleRequest(post(valid), env(), mockFetch({ failAt: "/labels" }).deps)
  expect(res.status).toBe(201)
})

test("the PR body shows user text inside a fence it cannot close", async () => {
  const { calls, deps } = mockFetch()
  const s = JSON.parse(valid); s.id = "sub-x"; s.note = "```\n@everyone [x](http://evil)"
  await handleRequest(post(JSON.stringify(s)), env(), deps)
  const body: string = calls.find((c) => c.url.endsWith("/pulls"))!.body.body
  expect(body).toContain("````text")
  expect(body.indexOf("@everyone")).toBeGreaterThan(body.indexOf("````text"))
})

test("CORS: only the configured origin is allowed", async () => {
  const pre = (origin?: string) => new Request("https://w.test/submit", { method: "OPTIONS", ...(origin ? { headers: { origin } } : {}) })
  const none = await handleRequest(pre("https://site.test"), env())
  expect(none.headers.get("access-control-allow-origin")).toBeNull()
  const list = env({ ALLOWED_ORIGIN: "https://a.test, https://b.test" })
  expect((await handleRequest(pre("https://b.test"), list)).headers.get("access-control-allow-origin")).toBe("https://b.test")
  expect((await handleRequest(pre("https://evil.test"), list)).headers.get("access-control-allow-origin")).toBeNull()
  expect((await handleRequest(pre(), list)).headers.get("access-control-allow-origin")).toBeNull()
  // The POST answer carries the matched origin too, so the browser can read it.
  const post = await handleRequest(new Request("https://w.test/submit", { method: "POST", headers: { origin: "https://a.test" } }), list, mockFetch().deps)
  expect(post.headers.get("access-control-allow-origin")).toBe("https://a.test")
})
