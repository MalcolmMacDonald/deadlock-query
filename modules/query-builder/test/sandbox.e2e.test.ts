import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildApp, serve } from "../src/app/build.ts"
import { LIMITS } from "../src/sandbox/limits.ts"

/**
 * Adversarial corpus, real layer: queries run through the real `SandboxRunner` (sandboxed iframe + CSP + Worker)
 * in Chromium. Self-skips when no Chromium is found (same as `app.e2e.test.ts`).
 */
const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers"
const dir = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().at(-1) : undefined
const executablePath = process.env.CHROMIUM_PATH ?? (dir ? join(root, dir, "chrome-linux/chrome") : undefined)
const haveBrowser = executablePath !== undefined && existsSync(executablePath)

let browser: Browser
let server: ReturnType<typeof serve>
let page: Page
const pageErrors: string[] = []
beforeAll(async () => {
  if (!haveBrowser) return
  server = serve(await buildApp())
  browser = await chromium.launch({ executablePath: executablePath! })
  page = await browser.newPage()
  page.on("pageerror", (e) => pageErrors.push(e.message))
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForFunction(() => (self as any).__qb, undefined, { timeout: 30_000 })
}, 120_000)
afterAll(async () => { await browser?.close(); server?.stop(true) })

type Outcome = { ok: true; value: any; ms?: number; totalRows?: number } | { ok: false; reason: string; message: string }
/** Runs raw JS in the sandbox (skips the type-checker so hostile code reaches the runtime). */
const sandbox = (js: string, timeoutMs = 10_000): Promise<Outcome> =>
  page.evaluate(([code, t]) => (self as any).__qb.runner.run(code, { timeoutMs: t }), [js, timeoutMs] as const)

test.skipIf(!haveBrowser)("the frame is an opaque-origin sandbox the page cannot reach into", async () => {
  const r = await page.evaluate(() => {
    const f = document.querySelector("iframe")!
    let reach = "blocked"
    try { reach = String(f.contentDocument !== null || f.contentWindow!.document !== null) } catch { reach = "blocked" }
    return { sandbox: f.getAttribute("sandbox"), allow: f.getAttribute("allow"), csp: f.srcdoc.match(/Content-Security-Policy" content="([^"]+)"/)?.[1], reach }
  })
  expect(r.sandbox).toBe("allow-scripts")
  expect(r.allow).toBe("")
  expect(r.reach).toBe("blocked")
  expect(r.csp).toContain("connect-src 'none'")
  expect(r.csp).not.toContain("blob:; worker-src") // blob: is for worker-src only
}, 30_000)

test.skipIf(!haveBrowser)("the worker has no window, DOM, storage, network or nested-worker access", async () => {
  const out = await sandbox(`[typeof window, typeof document, typeof parent, typeof top, typeof localStorage, typeof indexedDB, typeof caches,
    typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof EventSource, typeof importScripts, typeof Worker, typeof SharedWorker,
    typeof BroadcastChannel, typeof postMessage, typeof navigator.sendBeacon, typeof navigator.storage, typeof navigator.serviceWorker, location.origin]`)
  expect(out).toMatchObject({ ok: true })
  const v = (out as any).value as string[]
  expect(v.slice(0, -1).every((t) => t === "undefined")).toBe(true)
  expect(v.at(-1)).toBe("null") // opaque origin
}, 30_000)

test.skipIf(!haveBrowser)("dynamic import of data:, blob: and https: URLs is blocked by the CSP", async () => {
  const out = await sandbox(`(async () => {
    const attempt = async (u) => { try { await import(u); return "loaded" } catch { return "blocked" } }
    const blob = URL.createObjectURL(new Blob(["export default 1"], { type: "text/javascript" }))
    return [await attempt("data:text/javascript,export default 1"), await attempt(blob), await attempt("https://example.com/x.js")]
  })()`)
  expect(out).toEqual({ ok: true, value: ["blocked", "blocked", "blocked"], ms: expect.any(Number) })
}, 30_000)

test.skipIf(!haveBrowser)("eval / Function / constructor chains stay inside the scrubbed realm", async () => {
  const out = await sandbox(`[
    typeof (0, eval)("fetch"),
    new Function("return typeof fetch")(),
    (() => {}).constructor("return typeof self.fetch")(),
    (async () => {}).constructor("return typeof fetch")() instanceof Promise ? "async-ctor" : "?",
    (function () { return typeof this.fetch }).call(globalThis)
  ]`)
  expect((out as any).value).toEqual(["undefined", "undefined", "undefined", "async-ctor", "undefined"])
}, 30_000)

test.skipIf(!haveBrowser)("a worker created from inside the query cannot be spawned (and so cannot escape the scrub)", async () => {
  const out = await sandbox(`(() => { try { new Worker("data:text/javascript,1"); return "spawned" } catch { return "blocked" } })()`)
  expect(out).toMatchObject({ ok: true, value: "blocked" })
}, 30_000)

test.skipIf(!haveBrowser)("an infinite loop is stopped by the timeout and the next query runs", async () => {
  const t0 = Date.now()
  expect(await sandbox("while (true) {}", 500)).toMatchObject({ ok: false, reason: "timeout" })
  expect(Date.now() - t0).toBeLessThan(5_000)
  expect(await sandbox("Math.max(4, 1)")).toMatchObject({ ok: true, value: 4 })
}, 30_000)

test.skipIf(!haveBrowser)("huge allocations are refused and the sandbox stays usable", async () => {
  for (const js of [`new ArrayBuffer(2 ** 33)`, `new Float64Array(2 ** 30)`, `"x".repeat(2 ** 29)`]) {
    expect(await sandbox(js)).toMatchObject({ ok: false, reason: "error", message: expect.stringMatching(/sandbox limit/) })
  }
  expect(await sandbox("new Float32Array(1000).length")).toMatchObject({ ok: true, value: 1000 })
}, 60_000)

test.skipIf(!haveBrowser)("an oversize result is cut to the row cap with the real total reported", async () => {
  const total = LIMITS.maxRows + 1234
  const out = await sandbox(`Array.from({ length: ${total} }, (_, i) => i)`, 30_000)
  expect(out).toMatchObject({ ok: true, totalRows: total })
  expect((out as any).value.length).toBe(LIMITS.maxRows)
}, 60_000)

test.skipIf(!haveBrowser)("the results table only renders the first rows of a large result", async () => {
  await page.evaluate(() => (self as any).__qb.editor.setValue("Array.from({ length: 5000 }, (_, i) => i)"))
  await page.click("#run")
  await page.waitForSelector("[data-testid=results-table] tbody tr", { timeout: 30_000 })
  expect(await page.$$eval("[data-testid=results-table] tbody tr", (r) => r.length)).toBe(LIMITS.maxRenderedRows)
  expect(await page.textContent("[data-testid=render-cap]")).toContain(`first ${LIMITS.maxRenderedRows} of 5000`)
  expect(await page.textContent("[data-testid=stats]")).toMatch(/5000 rows/)
}, 60_000)

test.skipIf(!haveBrowser)("no page errors were raised by any of the above", () => {
  expect(pageErrors).toEqual([])
})
