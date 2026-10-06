import { expect, test } from "bun:test"
import { workerSource } from "../src/sandbox/worker-source.ts"
import { sandboxCsp } from "../src/sandbox/frame.ts"

const spawn = (prelude = "") => {
  const url = URL.createObjectURL(new Blob([workerSource(prelude)], { type: "text/javascript" }))
  const w = new Worker(url)
  const next = () => new Promise<any>((res) => { w.onmessage = (e) => res(e.data) })
  return { w, next }
}

test("trailing expression is the result (eval completion value)", async () => {
  const { w, next } = spawn()
  w.postMessage({ type: "run", runId: 1, js: "const a = [1, 2, 3];\na.map((x) => x * 2);" })
  expect(await next()).toMatchObject({ type: "result", runId: 1, value: [2, 4, 6] })
  w.terminate()
})

test("thenables are awaited; errors are reported", async () => {
  const { w, next } = spawn()
  w.postMessage({ type: "run", runId: 1, js: "Promise.resolve(7)" })
  expect(await next()).toMatchObject({ type: "result", value: 7 })
  w.postMessage({ type: "run", runId: 2, js: "throw new Error('boom')" })
  expect(await next()).toMatchObject({ type: "error", runId: 2, message: "boom" })
  w.terminate()
})

test("network globals are scrubbed and cannot be restored", async () => {
  const { w, next } = spawn()
  w.postMessage({ type: "run", runId: 1, js: "[typeof fetch, typeof XMLHttpRequest, typeof WebSocket]" })
  expect((await next()).value).toEqual(["undefined", "undefined", "undefined"])
  w.postMessage({ type: "run", runId: 2, js: "globalThis.fetch = () => 1; typeof fetch" })
  expect((await next()).value).toBe("undefined")
  w.terminate()
})

test("terminate stops an infinite loop and a fresh worker answers quickly", async () => {
  const a = spawn()
  a.w.postMessage({ type: "run", runId: 1, js: "while (true) {}" })
  await Bun.sleep(50)
  const t0 = performance.now()
  a.w.terminate()
  const b = spawn()
  b.w.postMessage({ type: "ping", id: 1 })
  expect(await b.next()).toEqual({ type: "pong", id: 1 })
  expect(performance.now() - t0).toBeLessThan(500)
  b.w.terminate()
})

test("CSP forbids network and unnonced scripts", () => {
  const csp = sandboxCsp("abc")
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("connect-src 'none'")
  expect(csp).toContain("'nonce-abc'")
  expect(csp).not.toContain("'unsafe-inline'")
  expect(csp).toContain("script-src 'nonce-abc' 'unsafe-eval'; worker-src blob:") // blob: only for creating the worker
  expect(csp).toContain("base-uri 'none'")
})
