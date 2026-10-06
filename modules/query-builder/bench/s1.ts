// S1 spike bench: bun bench/s1.ts   (needs Chromium; uses PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers)
import { chromium } from "playwright-core"
import { join } from "node:path"
import { existsSync, readdirSync } from "node:fs"

const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../spike/build.ts")])
if (proc.exitCode !== 0) { console.error(proc.stderr.toString()); process.exit(1) }
const dist = join(import.meta.dir, "../.spike-dist")
const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const p = new URL(req.url).pathname
    const f = Bun.file(join(dist, p === "/" ? "index.html" : p))
    return f.size ? new Response(f) : new Response("nf", { status: 404 })
  },
})

const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers"
const dir = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().at(-1) : undefined
const executablePath = process.env.CHROMIUM_PATH ?? (dir ? join(root, dir, "chrome-linux/chrome") : undefined)
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage()
page.on("pageerror", (e) => console.error("pageerror", e.message))
const t0 = Date.now()
await page.goto(`http://localhost:${server.port}/`)
await page.waitForFunction(() => (self as any).__spike)

const spike = (fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (self as any).__spike[f as string](...(args as unknown[])), [fn, a] as const)
const widget = ".suggest-widget.visible .monaco-list-row"
const results: Record<string, unknown> = {}

// 1. first suggestion after panel open
await page.click(".monaco-editor")
await page.keyboard.type("map.")
const tFirst = Date.now()
await page.waitForSelector(widget, { timeout: 20000 })
const openToFirst = await page.evaluate(() => performance.now() - (self as any).__spike.openedAt)
results.firstSuggestionMsAfterOpen = Math.round(openToFirst)
const labels = await page.$$eval(widget, (rows) => rows.map((r) => r.textContent ?? ""))
results.firstSuggestionLabels = labels.slice(0, 6)
void tFirst

// 2. warm completion latency (member of library class), several trials
const warm: number[] = []
for (let i = 0; i < 5; i++) {
  await page.keyboard.press("Escape")
  await page.evaluate(() => (self as any).__spike.editor.setValue("map.spawns()[0].position"))
  await page.evaluate(() => (self as any).__spike.editor.setPosition({ lineNumber: 1, column: 100 }))
  await page.keyboard.type(".")
  const t = Date.now()
  await page.waitForFunction((sel) => Array.from(document.querySelectorAll(sel)).some((r) => /distanceTo/.test(r.textContent ?? "")), widget, { polling: 5, timeout: 5000 })
  warm.push(Date.now() - t)
}
results.warmCompletionMs = warm
await page.keyboard.press("Escape")
// string-literal completion
await page.evaluate(() => (self as any).__spike.editor.setValue("map.spawnsOf("))
await page.evaluate(() => (self as any).__spike.editor.setPosition({ lineNumber: 1, column: 100 }))
await page.keyboard.type('"')
await page.keyboard.press("Control+Space")
await page.waitForFunction((sel) => Array.from(document.querySelectorAll(sel)).some((r) => /yellow/.test(r.textContent ?? "")), widget, { timeout: 5000 })
results.stringLiteralCompletion = "ok (yellow offered)"
await page.keyboard.press("Escape")

// 3. run in sandbox
await spike("ready")
const q1 = (await spike("run", 'map.spawnsOf("yellow").map(s => s.id)')) as any
results.runTrailingExpression = { value: q1.outcome.value, typeErrors: q1.errors, totalMs: Math.round(q1.totalMs) }
const q2 = (await spike("run", 'const a = map.spawns()[0].position; const b = map.spawns()[3].position; map.travelTime(a, b)')) as any
results.runStatements = { value: q2.outcome.value, typeErrors: q2.errors }
const bad = (await spike("run", 'map.nope()')) as any
results.typeErrorReported = bad.errors > 0
const net = (await spike("run", 'typeof fetch + "," + typeof XMLHttpRequest + "," + typeof WebSocket + "," + typeof indexedDB')) as any
results.scrubbedGlobals = net.outcome.value

// 4. cancel an infinite loop
const cancelMs: number[] = []
for (let i = 0; i < 5; i++) {
  await spike("startRun", "while (true) {}")
  await new Promise((r) => setTimeout(r, 300))
  cancelMs.push(Math.round((await spike("cancel")) as number))
}
results.cancelToReplacementReadyMs = cancelMs
const after = (await spike("run", "1 + 1")) as any
results.runAfterCancel = after.outcome.value
const to = (await spike("run", "while (true) {}", 500)) as any
results.timeoutOutcome = to.outcome.reason

// 5. sandbox properties
results.sandboxOrigin = await page.evaluate(() => {
  const f = document.querySelector("iframe")!
  return { sandbox: f.getAttribute("sandbox"), crossOrigin: (() => { try { void f.contentWindow!.document; return false } catch { return true } })() }
})
results.totalWallMs = Date.now() - t0
console.log(JSON.stringify(results, null, 2))

const gates = {
  firstSuggestion: openToFirst <= 2000,
  warmCompletion: Math.max(...warm) <= 200,
  cancel: Math.max(...cancelMs) <= 100,
}
console.log("gates", gates)
await browser.close(); server.stop()
process.exit(Object.values(gates).every(Boolean) ? 0 : 1)
