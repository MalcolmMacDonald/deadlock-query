import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildMiniMap } from "@deadlock-query/contracts"
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

const open = async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForFunction(() => (self as any).__qb, undefined, { timeout: 30_000 })
  return { page, errors }
}
const setSource = async (page: Awaited<ReturnType<typeof open>>["page"], src: string) =>
  page.evaluate((v) => (self as any).__qb.editor.setValue(v), src)

// M0 acceptance, now against the real library `.d.ts`: type, see suggestions.
test.skipIf(!haveBrowser)("editor suggests real library members", async () => {
  const { page, errors } = await open()
  await setSource(page, "")
  await page.click(".monaco-editor")
  await page.keyboard.type("map.")
  const widget = ".suggest-widget.visible .monaco-list-row"
  await page.waitForSelector(widget, { timeout: 20_000 })
  const labels = await page.$$eval(widget, (rows) => rows.map((r) => r.textContent ?? ""))
  expect(labels.some((l) => l.includes("guardians"))).toBe(true)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

// M1 acceptance: slice-1 query returns the expected rows through the real runner.
test.skipIf(!haveBrowser)("slice-1 query runs against the mini-map and renders the expected rows", async () => {
  const { page, errors } = await open()
  const mini = buildMiniMap()
  await setSource(page, `map.guardians.select((g) => {
  const orb = map.healingOrbs.closest(g)!
  return [g.id, g.position, orb.id, Math.round(g.distanceTo(orb) * 1000) / 1000]
}).toArray()`)
  await page.click("#run")
  await page.waitForSelector("[data-testid=results-table] tbody tr", { timeout: 20_000 })
  const rows = await page.$$eval("[data-testid=results-table] tbody tr", (trs) => trs.map((tr) => Array.from((tr as HTMLTableRowElement).cells).map((c) => c.textContent ?? "")))
  expect(rows.map((r) => [r[0], r[2], r[3]])).toEqual(mini.expectedGuardianOrbDistance.rows.map((r) => [String(r[0]), String(r[2]), String(r[3])]))
  expect(await page.textContent("[data-testid=stats]")).toMatch(new RegExp(`${mini.expectedGuardianOrbDistance.rows.length} rows`))
  expect(errors).toEqual([])
  await page.close()
}, 90_000)

test.skipIf(!haveBrowser)("type errors are reported with line:column and block the run", async () => {
  const { page } = await open()
  await setSource(page, "map.guardians.nope()")
  await page.click("#run")
  await page.waitForSelector("[data-testid=error]", { timeout: 20_000 })
  expect(await page.textContent("[data-testid=error]")).toMatch(/1:\d+ .*nope/)
  await page.close()
}, 60_000)

test.skipIf(!haveBrowser)("an infinite loop can be cancelled and the editor stays usable", async () => {
  const { page } = await open()
  await setSource(page, "while (true) {}")
  await page.click("#run")
  await page.waitForFunction(() => (document.getElementById("status") as HTMLElement).textContent === "running…")
  await page.click("#cancel")
  await page.waitForSelector("[data-testid=error]", { timeout: 30_000 })
  expect(await page.textContent("[data-testid=error]")).toMatch(/cancelled/i)
  await setSource(page, "map.guardians.count()")
  await page.click("#run")
  await page.waitForSelector("[data-testid=results-table] tbody tr", { timeout: 20_000 })
  expect(await page.textContent("[data-testid=results-table] tbody tr")).toBe("6")
  await page.close()
}, 90_000)

// Viewer/selection wiring through the panel's injected services (recording viewer + in-memory bus).
test.skipIf(!haveBrowser)("results drive the viewer overlay, and row ↔ pick ↔ shared selection stay in sync", async () => {
  const { page, errors } = await open()
  const mini = buildMiniMap()
  await setSource(page, `map.guardians.select((g) => [g.id, g.position]).toArray()`)
  await page.click("#run")
  await page.waitForSelector("[data-testid=results-table] tbody tr", { timeout: 20_000 })
  // The query returns plain rows (not entities), so row ids are row indexes.
  const ids = mini.expectedGuardianOrbDistance.rows.map((_, i) => String(i))
  const overlay = await page.evaluate(() => (self as any).__qb.host.log.overlays.get("query-result")?.map((f: any) => f.label))
  expect(overlay).toEqual(ids.map((id) => `${id}:c2`))

  // Row click → shared selection + viewer highlight + selected row.
  await page.click(`tr[data-row-id="${ids[1]}"]`)
  const sel1 = await page.evaluate(() => ({ highlight: (self as any).__qb.host.log.highlights.at(-1) }))
  expect(sel1.highlight).toEqual([`${ids[1]}:c2`])
  expect(await page.$$eval("tr.selected", (r) => r.map((x) => (x as HTMLElement).dataset.rowId))).toEqual([ids[1]])

  // Viewer pick → row selected.
  await page.evaluate((id) => (self as any).__qb.host.emitPick(id), `${ids[2]}:c2`)
  await page.waitForFunction((id) => document.querySelector("tr.selected")?.getAttribute("data-row-id") === id, ids[2])

  // External selection change (polled) → row selected.
  await page.evaluate((id) => (self as any).__qb.host.setSelected([id]), ids[0])
  await page.waitForFunction((id) => document.querySelector("tr.selected")?.getAttribute("data-row-id") === id, ids[0], { timeout: 5_000 })

  // A result without geometry clears the overlay.
  await setSource(page, "map.guardians.count()")
  await page.click("#run")
  await page.waitForFunction(() => !(self as any).__qb.host.log.overlays.has("query-result"))
  expect(errors).toEqual([])
  await page.close()
}, 90_000)
