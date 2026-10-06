import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildApp, serve } from "../src/app/build.ts"

const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers"
const dir = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().at(-1) : undefined
const executablePath = process.env.CHROMIUM_PATH ?? (dir ? join(root, dir, "chrome-linux/chrome") : undefined)
const haveBrowser = executablePath !== undefined && existsSync(executablePath)

let browser: Browser
let server: ReturnType<typeof serve>
beforeAll(async () => {
  if (!haveBrowser) return
  server = serve(await buildApp())
  browser = await chromium.launch({ executablePath: executablePath! })
}, 120_000)
afterAll(async () => { await browser?.close(); server?.stop(true) })

// M0 acceptance: type, see suggestions, run mock, see rows.
test.skipIf(!haveBrowser)("editor suggests library members and runs the mock engine into a table", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForFunction(() => (self as any).__qb)
  await page.evaluate(() => (self as any).__qb.editor.setValue(""))
  await page.click(".monaco-editor")
  await page.keyboard.type("map.")
  const widget = ".suggest-widget.visible .monaco-list-row"
  await page.waitForSelector(widget, { timeout: 20_000 })
  const labels = await page.$$eval(widget, (rows) => rows.map((r) => r.textContent ?? ""))
  expect(labels.some((l) => l.includes("spawnsOf"))).toBe(true)
  await page.keyboard.press("Escape")

  await page.click("#run")
  await page.waitForSelector("[data-testid=results-table] tbody tr", { timeout: 10_000 })
  const headers = await page.$$eval("[data-testid=results-table] th", (h) => h.map((x) => x.textContent))
  expect(headers.length).toBeGreaterThan(0)
  expect(await page.$$eval("[data-testid=results-table] tbody tr", (r) => r.length)).toBeGreaterThan(0)
  expect(await page.textContent("[data-testid=stats]")).toMatch(/\d+ rows/)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
