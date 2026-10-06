import { afterAll, expect, test } from "bun:test"
import { fetchJsonCached, fetchJsonWithProgress, resolveLoadable } from "../src/load/progress.ts"

const payload = JSON.stringify({ rows: Array.from({ length: 20_000 }, (_, i) => [i, `entity-${i}`]) })
let hits = 0
const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const p = new URL(req.url).pathname
    hits++
    if (p === "/flaky" && hits % 2 === 1) return new Response("nope", { status: 503 })
    if (p === "/chunked") {
      // No Content-Length: the total is unknown.
      const body = new ReadableStream({ start(c) { for (let i = 0; i < payload.length; i += 50_000) c.enqueue(new TextEncoder().encode(payload.slice(i, i + 50_000))); c.close() } })
      return new Response(body, { headers: { "content-type": "application/json" } })
    }
    return new Response(payload, { headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(payload).length) } })
  }
})
afterAll(() => server.stop(true))
const url = (p: string) => `http://localhost:${server.port}${p}`

test("progress is reported as bytes arrive, ending at the full size, and the JSON is parsed", async () => {
  const seen: Array<[number, number | undefined]> = []
  const data = await fetchJsonWithProgress<{ rows: unknown[] }>(url("/sized"), (l, t) => seen.push([l, t]))
  expect(data.rows).toHaveLength(20_000)
  const size = new TextEncoder().encode(payload).length
  expect(seen.at(-1)).toEqual([size, size])
  expect(seen[0]![1]).toBe(size) // total known up front from Content-Length
  expect(seen.map((s) => s[0])).toEqual([...seen.map((s) => s[0])].sort((a, b) => a - b))
})

test("without Content-Length no total is claimed until the end", async () => {
  const seen: Array<[number, number | undefined]> = []
  await fetchJsonWithProgress(url("/chunked"), (l, t) => seen.push([l, t]))
  expect(seen.length).toBeGreaterThan(2)
  expect(seen.slice(0, -1).every(([, t]) => t === undefined)).toBe(true)
})

test("an HTTP error is a readable failure", async () => {
  hits = 0
  await expect(fetchJsonWithProgress(url("/flaky"))).rejects.toThrow(/HTTP 503/)
})

test("cached downloads happen once per URL; failures are retried", async () => {
  hits = 0
  const [a, b] = await Promise.all([fetchJsonCached(url("/cached")), fetchJsonCached(url("/cached"))])
  expect(a).toBe(b)
  await fetchJsonCached(url("/cached"))
  expect(hits).toBe(1)
  hits = 0 // /flaky fails on odd hits: the first try fails and is not remembered, the retry succeeds
  await expect(fetchJsonCached(url("/flaky"))).rejects.toThrow(/503/)
  await expect(fetchJsonCached(url("/flaky"))).resolves.toMatchObject({ rows: expect.any(Array) })
})

test("a cache hit still reports completion so a progress bar can finish", async () => {
  await fetchJsonCached(url("/done"))
  const seen: Array<[number, number | undefined]> = []
  await fetchJsonCached(url("/done"), (l, t) => seen.push([l, t]))
  expect(seen).toEqual([[1, 1]])
})

test("loadables: values, promises and progress-reporting functions all resolve", async () => {
  const report = () => {}
  expect(await resolveLoadable(5, report)).toBe(5)
  expect(await resolveLoadable(Promise.resolve("p"), report)).toBe("p")
  const calls: number[] = []
  expect(await resolveLoadable(async (r) => { r(1, 2); return "f" }, (l) => calls.push(l))).toBe("f")
  expect(calls).toEqual([1])
})
