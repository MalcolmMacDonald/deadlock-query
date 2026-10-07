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

const open = async (hash = "") => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/${hash}`)
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
  const rows = await page.$$eval("[data-testid=results-table] tbody tr", (trs) => trs.map((tr) => Array.from((tr as HTMLTableRowElement).cells).map((c) => (c as HTMLElement).dataset.entityId ?? c.textContent ?? "")))
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
  // Labels name the thing (the guardian id in column c1), not the row/column plumbing.
  const names = await page.$$eval("[data-testid=results-table] tbody tr", (rs) => rs.map((r) => (r.querySelector("td") as HTMLElement | null)?.dataset.entityId ?? r.querySelector("td")?.textContent))
  // Entity ids read as "<kind> #<id suffix>" in the table, with the full id as the tooltip.
  expect(await page.$eval("[data-testid=results-table] tbody tr td", (td) => [td.textContent, td.getAttribute("title")])).toEqual(["guardian #guardian-1-2 · yellow", "guardian-1-2"])
  expect(overlay).toEqual(names)
  // Feature ids are the viewer's own `<layer>:<index>`.
  const featureId = (i: number) => `query-result:${i}`

  // Row click → shared selection + viewer highlight + selected row.
  await page.click(`tr[data-row-id="${ids[1]}"]`)
  const sel1 = await page.evaluate(() => ({ highlight: (self as any).__qb.host.log.highlights.at(-1) }))
  expect(sel1.highlight).toEqual([featureId(1)])
  // …and the camera flies to the row's point.
  expect(await page.evaluate(() => (self as any).__qb.host.log.flights.length)).toBe(1)
  expect(await page.$$eval("tr.selected", (r) => r.map((x) => (x as HTMLElement).dataset.rowId))).toEqual([ids[1]])

  // Viewer pick → row selected.
  await page.evaluate((id) => (self as any).__qb.host.emitPick(id), featureId(2))
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

// M4: docs panel, hover links, snippets, gallery, friendly errors.
const editorValue = (page: Awaited<ReturnType<typeof open>>["page"]) => page.evaluate(() => (self as any).__qb.editor.getValue() as string)

test.skipIf(!haveBrowser)("docs panel searches the catalog and inserts at the cursor", async () => {
  const { page, errors } = await open()
  await setSource(page, "map.healingOrbs")
  await page.evaluate(() => { const e = (self as any).__qb.editor; e.setPosition(e.getModel().getFullModelRange().getEndPosition()) })
  await page.click("[data-testid=toggle-docs]")
  expect(await page.$$eval("[data-testid=doc-item]", (r) => r.length)).toBeGreaterThan(40)
  await page.fill("[data-testid=docs-search]", "withinTravel")
  await page.waitForFunction(() => document.querySelector("[data-testid=doc-item]")?.textContent === "EntityList.withinTravelTime")
  await page.click("[data-testid=doc-item]")
  expect(await page.textContent("[data-testid=docs-detail]")).toContain("withinTravelTime(time: number")
  await page.click("[data-testid=doc-insert]")
  expect(await editorValue(page)).toBe("map.healingOrbs.withinTravelTime()")
  // Cursor lands inside the parentheses.
  expect(await page.evaluate(() => { const e = (self as any).__qb.editor; return e.getModel().getOffsetAt(e.getPosition()) })).toBe("map.healingOrbs.withinTravelTime(".length)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

// M4 acceptance: a catalog entry is reachable from the editor hover.
test.skipIf(!haveBrowser)("hover over a library member links into the docs panel", async () => {
  const { page, errors } = await open()
  await setSource(page, "map.healingOrbs.closest(map.guardians.first()!)")
  await page.evaluate(() => { const e = (self as any).__qb.editor; e.focus(); e.setPosition({ lineNumber: 1, column: 20 }); e.trigger("test", "editor.action.showHover", {}) })
  const link = page.locator(".monaco-hover a", { hasText: "EntityList.closest" })
  await link.waitFor({ timeout: 20_000 })
  await link.click()
  await page.waitForFunction(() => document.querySelector("[data-testid=docs-detail] .title strong")?.textContent === "EntityList.closest", undefined, { timeout: 10_000 })
  expect(await page.isVisible("[data-testid=sidebar]")).toBe(true)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test.skipIf(!haveBrowser)("snippet completion offers the PLAN.md query shapes", async () => {
  const { page, errors } = await open()
  await setSource(page, "")
  await page.click(".monaco-editor")
  await page.keyboard.type("withinTrav")
  const widget = ".suggest-widget.visible .monaco-list-row"
  await page.waitForSelector(widget, { timeout: 20_000 })
  expect(await page.$$eval(widget, (rows) => rows.map((r) => r.textContent ?? "").some((t) => t.includes("withinTravelTime") && t.includes("Entities within N seconds")))).toBe(true)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test.skipIf(!haveBrowser)("gallery loads queries; the starter runs and the navmesh ones explain what is missing", async () => {
  const { page, errors } = await open()
  const mini = buildMiniMap()
  await page.click("[data-testid=toggle-gallery]")
  expect(await page.$$eval("[data-testid=gallery-card]", (c) => c.length)).toBe(4)
  expect(await page.$$eval("[data-testid=gallery-note]", (c) => c.length)).toBe(3)

  await page.click("[data-query-id=guardian-nearest-orb] [data-testid=gallery-run]")
  await page.waitForSelector("[data-testid=results-table] tbody tr", { timeout: 20_000 })
  expect(await page.$$eval("[data-testid=results-table] tbody tr", (r) => r.length)).toBe(mini.expectedGuardianOrbDistance.rows.length)

  await page.click("[data-query-id=orbs-within-10s] [data-testid=gallery-run]")
  await page.waitForSelector("[data-testid=error]", { timeout: 20_000 })
  expect(await page.textContent("[data-testid=error]")).toMatch(/withinTravelTime\(\) needs map data this bundle does not have yet/)
  expect(await editorValue(page)).toContain("withinTravelTime(seconds(10)")

  // Loading is an editor edit, so undo brings the previous query back.
  await page.evaluate(() => (self as any).__qb.editor.trigger("test", "undo", {}))
  expect(await editorValue(page)).toContain("closest(g)")
  expect(errors).toEqual([])
  await page.close()
}, 90_000)

test.skipIf(!haveBrowser)("type errors come with plain-language advice", async () => {
  const { page } = await open()
  await setSource(page, "map.healingOrbs.closet(map.guardians.first()!)")
  await page.click("#run")
  await page.waitForSelector("[data-testid=error]", { timeout: 20_000 })
  expect(await page.textContent("[data-testid=error]")).toMatch(/1:\d+ .*Did you mean `closest`\?.*\(Property 'closet' does not exist/s)
  await page.close()
}, 60_000)

// M5: exports, share links, saved queries and history.
const STARTER = "[data-query-id=guardian-nearest-orb] [data-testid=gallery-run]"
const runStarter = async (page: Awaited<ReturnType<typeof open>>["page"]) => {
  await page.click("[data-testid=toggle-gallery]")
  await page.click(STARTER)
  await page.waitForSelector("[data-testid=results-table] tbody tr", { timeout: 20_000 })
}
const download = async (page: Awaited<ReturnType<typeof open>>["page"], testid: string) => {
  const [d] = await Promise.all([page.waitForEvent("download"), page.click(`[data-testid=${testid}]`)])
  const stream = await d.createReadStream()
  let text = ""
  for await (const chunk of stream) text += chunk
  return { name: d.suggestedFilename(), text }
}

test.skipIf(!haveBrowser)("results export as CSV, JSON, GeoJSON and annotations; PNG explains a missing image", async () => {
  const { page, errors } = await open()
  const mini = buildMiniMap()
  await runStarter(page)
  const n = mini.expectedGuardianOrbDistance.rows.length

  const csv = await download(page, "export-csv")
  expect(csv.name).toBe("query-result.csv")
  expect(csv.text.trim().split("\n")).toHaveLength(n + 1)

  const json = await download(page, "export-json")
  const parsed = JSON.parse(json.text)
  expect(parsed.rows).toHaveLength(n)
  expect(parsed.metadata).toMatchObject({ provisional: false, mapName: mini.manifest.mapName, apiVersion: expect.any(String) })
  expect(parsed.metadata.source).toContain("healingOrbs.closest(g)")

  const geo = JSON.parse((await download(page, "export-geojson")).text)
  expect(geo.features).toHaveLength(n)

  const ann = JSON.parse((await download(page, "export-annotations")).text)
  expect(ann.annotations).toHaveLength(n)
  expect(ann.layers[0].id).toBe("query-result")

  // The standalone viewer has no screen: the button says so instead of saving an empty file.
  await page.click("[data-testid=export-png]")
  await page.waitForSelector("[data-testid=notice].error")
  expect(await page.textContent("[data-testid=notice]")).toMatch(/returned no image/)
  expect(errors).toEqual([])
  await page.close()
}, 90_000)

test.skipIf(!haveBrowser)("a share link fills the editor, never runs it, and warns about a stale apiVersion", async () => {
  const first = await open()
  await setSource(first.page, "map.guardians.count()")
  const url = await first.page.evaluate(() => (self as any).__qb.shareUrl() as Promise<string>)
  await first.page.click("[data-testid=share]")
  await first.page.waitForSelector("[data-testid=share-url]")
  expect(await first.page.inputValue("[data-testid=share-url]")).toBe(url)
  await first.page.close()

  const hash = url.slice(url.indexOf("#"))
  const same = await open(hash)
  expect(await editorValue(same.page)).toBe("map.guardians.count()")
  expect(await same.page.textContent("[data-testid=notice]")).toMatch(/has not been run/)
  expect(await same.page.textContent("[data-testid=notice]")).not.toMatch(/library/)
  expect(await same.page.$("[data-testid=results-table]")).toBeNull()
  expect(await same.page.textContent("#status")).toBe("idle")
  await same.page.close()

  const stale = await open(hash.replace(/api=[^&]+/, "api=9.9.9"))
  expect(await stale.page.textContent("[data-testid=notice]")).toMatch(/different major version/)
  await stale.page.close()

  const broken = await open("#q=AAAA")
  expect(await broken.page.textContent("[data-testid=notice]")).toMatch(/damaged/)
  await broken.page.close()
}, 90_000)

test.skipIf(!haveBrowser)("saved queries and history persist across reloads; .dlq.json round-trips; stale versions warn", async () => {
  const { page, errors } = await open()
  await runStarter(page)
  // History records the run.
  await page.click("[data-testid=toggle-history]")
  expect(await page.$$eval("[data-testid=history-item]", (r) => r.length)).toBe(1)
  expect(await page.textContent("[data-testid=history-item]")).toMatch(/\d+ rows/)

  // Save, reload (same origin storage), see it again.
  await setSource(page, "map.healingOrbs.count()")
  await page.click("[data-testid=toggle-saved]")
  await page.fill("[data-testid=saved-name]", "Orb count")
  await page.click("[data-testid=saved-save]")
  await page.waitForSelector("[data-testid=saved-item]")
  const file = await download(page, "saved-export")
  expect(file.name).toBe("orb-count.dlq.json")
  expect(JSON.parse(file.text)).toMatchObject({ kind: "deadlock-query", version: 1, queries: [{ name: "Orb count", source: "map.healingOrbs.count()" }] })

  await page.reload()
  await page.waitForFunction(() => (self as any).__qb)
  await page.click("[data-testid=toggle-saved]")
  expect(await page.$$eval("[data-testid=saved-item]", (r) => r.map((x) => (x as HTMLElement).dataset.name))).toEqual(["Orb count"])
  await page.click("[data-testid=saved-load]")
  expect(await editorValue(page)).toBe("map.healingOrbs.count()")
  expect(await page.$("[data-testid=results-table]")).toBeNull() // loading never runs

  // Import a file written for an older library: it is saved and flagged.
  await page.setInputFiles("[data-testid=saved-import-file]", {
    name: "x.dlq.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ kind: "deadlock-query", version: 1, queries: [{ name: "Old", source: "map.guardians.count()", apiVersion: "0.0.1" }] }))
  })
  await page.waitForSelector("[data-testid=saved-version-warning]")
  expect(await page.textContent("[data-testid=saved-version-warning]")).toMatch(/0\.0\.1/)
  await page.setInputFiles("[data-testid=saved-import-file]", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{}") })
  await page.waitForFunction(() => /not a Deadlock Query file/.test(document.querySelector("[data-testid=saved-status]")?.textContent ?? ""))

  await page.click("[data-testid=saved-item][data-name=Old] [data-testid=saved-delete]")
  expect(await page.$$eval("[data-testid=saved-item]", (r) => r.length)).toBe(1)
  expect(errors).toEqual([])
  await page.close()
}, 90_000)

// M6: loading UX and timings.
test.skipIf(!haveBrowser)("a loading view with per-step progress shows until the editor is ready", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.route("**/bundle.json", async (route) => {
    const res = await route.fetch()
    await new Promise((r) => setTimeout(r, 1500))
    await route.fulfill({ response: res })
  })
  await page.goto(`http://localhost:${server.port}/`, { waitUntil: "commit" })
  await page.waitForSelector("[data-testid=loading]")
  expect(await page.textContent("[data-testid=loading]")).toMatch(/Loading the query editor/)
  expect(await page.$$eval("[data-testid=loading] [data-step]", (s) => s.map((x) => (x as HTMLElement).dataset.step))).toEqual(["editor", "library", "map"])
  // Library and editor code arrive while the (delayed) map data is still loading.
  await page.waitForSelector("[data-step=library][data-done=true]", { timeout: 20_000 })
  expect(await page.getAttribute("[data-step=map]", "data-done")).toBeNull()
  await page.waitForFunction(() => (self as any).__qb, undefined, { timeout: 30_000 })
  expect(await page.$("[data-testid=loading]")).toBeNull()
  expect(await page.isVisible(".monaco-editor")).toBe(true)
  expect(errors).toEqual([])
  await page.close()
}, 90_000)

test.skipIf(!haveBrowser)("a failed download shows the error and Retry recovers", async () => {
  const page = await browser.newPage()
  let failing = true
  await page.route("**/library.json", (route) => (failing ? route.abort() : route.continue()))
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForSelector("[data-testid=loading-error]", { timeout: 20_000 })
  expect(await page.textContent("[data-testid=loading]")).toMatch(/failed to load/)
  failing = false
  await page.click("[data-testid=loading-retry]")
  await page.waitForFunction(() => (self as any).__qb, undefined, { timeout: 30_000 })
  expect(await page.$("[data-testid=loading]")).toBeNull()
  await page.close()
}, 90_000)

// PLAN.md S1 gates, re-measured on the real app (local server, headless Chromium): first suggestion ≤ 2 s after the
// editor is up. The asserts leave slack for busy machines; the numbers are logged and recorded in STATE.md.
test.skipIf(!haveBrowser)("timings: editor ready and first suggestion", async () => {
  const page = await browser.newPage()
  const t0 = performance.now()
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForFunction(() => (self as any).__qb, undefined, { timeout: 30_000 })
  const ready = performance.now() - t0
  await setSource(page, "")
  await page.click(".monaco-editor")
  const t1 = performance.now()
  await page.keyboard.type("map.")
  await page.waitForSelector(".suggest-widget.visible .monaco-list-row", { timeout: 20_000 })
  const firstSuggestion = performance.now() - t1
  console.log(`timings: editor ready ${Math.round(ready)} ms, first suggestion ${Math.round(firstSuggestion)} ms`)
  expect(ready).toBeLessThan(10_000)
  expect(firstSuggestion).toBeLessThan(4_000)
  await page.close()
}, 60_000)

// M7: accessibility and polish.
const rowsText = (page: Awaited<ReturnType<typeof open>>["page"]) => page.$$eval("[data-testid=results-table] tbody tr", (trs) => trs.map((tr) => (tr as HTMLTableRowElement).cells[0]!.textContent ?? ""))
const runSource = async (page: Awaited<ReturnType<typeof open>>["page"], src: string) => {
  await setSource(page, src)
  await page.click("#run")
  await page.waitForSelector("[data-testid=results-table] tbody tr", { timeout: 20_000 })
}

test.skipIf(!haveBrowser)("results table sorts, filters and pages without losing its place", async () => {
  const { page, errors } = await open()
  await runSource(page, "Array.from({ length: 250 }, (_, i) => [`r${(i * 37) % 250}`, i])")
  expect(await rowsText(page)).toHaveLength(100)
  expect(await page.textContent("[data-testid=page-info]")).toBe("Rows 1–100 of 250")
  await page.click("[data-testid=page-next]")
  expect(await page.textContent("[data-testid=page-info]")).toBe("Rows 101–200 of 250")
  await page.selectOption("[data-testid=page-size]", "500")
  expect(await rowsText(page)).toHaveLength(250)

  // Sort: natural order on text, with aria-sort on the header; a second click reverses, a third clears.
  await page.click("[data-testid=sort][data-col='0']")
  expect(await page.getAttribute("th[aria-sort=ascending]", "aria-sort")).toBe("ascending")
  expect((await rowsText(page)).slice(0, 3)).toEqual(["r0", "r1", "r2"])
  await page.click("[data-testid=sort][data-col='0']")
  expect((await rowsText(page))[0]).toBe("r249")
  await page.click("[data-testid=sort][data-col='0']")
  expect(await page.$("th[aria-sort=ascending], th[aria-sort=descending]")).toBeNull()
  expect((await rowsText(page))[0]).toBe("r0") // query order: i = 0 → r0
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-col"))).toBe("0") // focus stayed on the header

  // Filter on the number column with a comparison, then on text.
  await page.fill("[data-testid=filter][data-col='1']", ">=240")
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=results-table] tbody tr").length === 10)
  expect(await page.textContent("[data-testid=page-info]")).toBe("Rows 1–10 of 10 (filtered from 250)")
  await page.fill("[data-testid=filter][data-col='1']", "")
  await page.fill("[data-testid=filter][data-col='0']", "r24")
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=results-table] tbody tr").length === 11)
  await page.fill("[data-testid=filter][data-col='0']", "nothing matches this")
  await page.waitForSelector("[data-testid=no-rows]:not([hidden])")
  expect(await page.textContent("[data-testid=no-rows]")).toBe("No rows match the filters.")
  expect(errors).toEqual([])
  await page.close()
}, 90_000)

test.skipIf(!haveBrowser)("an empty result says so", async () => {
  const { page } = await open()
  await setSource(page, "[]")
  await page.click("#run")
  await page.waitForSelector("[data-testid=no-rows]:not([hidden])")
  expect(await page.textContent("[data-testid=no-rows]")).toBe("The query returned no rows.")
  await page.close()
}, 60_000)

test.skipIf(!haveBrowser)("the results table works from the keyboard and keeps selection across sorting", async () => {
  const { page, errors } = await open()
  await runSource(page, "map.guardians.select((g) => [g.id, g.position]).toArray()")
  const first = await page.$eval("tbody tr", (tr) => (tr as HTMLElement).dataset.rowId)
  // One Tab stop for the whole table: the first row is tabbable, the others are reachable with arrows.
  expect(await page.$$eval("tbody tr[tabindex='0']", (r) => r.length)).toBe(1)
  await page.focus("tbody tr[tabindex='0']")
  await page.keyboard.press("ArrowDown")
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.rowId)).not.toBe(first)
  await page.keyboard.press("Enter")
  const selected = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.rowId)
  expect(await page.$$eval("tr.selected", (r) => r.map((x) => (x as HTMLElement).dataset.rowId))).toEqual([selected])
  expect(await page.getAttribute("tr.selected", "aria-selected")).toBe("true")
  // Selection reaches the shared bus like a click does.
  expect(await page.evaluate(() => (self as any).__qb.host.log.highlights.at(-1)?.length)).toBeGreaterThan(0)
  await page.keyboard.press("End")
  await page.keyboard.press("Home")
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.rowId)).toBe(first)
  // Sorting rebuilds the rows; the selected one stays marked.
  await page.click("[data-testid=sort][data-col='0']")
  expect(await page.$$eval("tr.selected", (r) => r.map((x) => (x as HTMLElement).dataset.rowId))).toEqual([selected])
  expect(errors).toEqual([])
  await page.close()
}, 90_000)

test.skipIf(!haveBrowser)("problems list summarises diagnostics and jumps to them", async () => {
  const { page, errors } = await open()
  expect(await page.textContent("[data-testid=problems-toggle]")).toBe("No problems")
  await setSource(page, "map.guardians\n  .nope()\n  .toArray()")
  await page.waitForFunction(() => /Problems: 1 error/.test(document.querySelector("[data-testid=problems-toggle]")?.textContent ?? ""), undefined, { timeout: 20_000 })
  expect(await page.getAttribute("[data-testid=problems-toggle]", "aria-expanded")).toBe("false")
  await page.click("[data-testid=problems-toggle]")
  expect(await page.getAttribute("[data-testid=problems-toggle]", "aria-expanded")).toBe("true")
  const text = await page.textContent("[data-testid=problem]")
  expect(text).toMatch(/^Error at line 2, column \d+: .*nope/)
  await page.click("[data-testid=problem]")
  expect(await page.evaluate(() => (self as any).__qb.editor.getPosition().lineNumber)).toBe(2)
  await setSource(page, "map.guardians.count()")
  await page.waitForFunction(() => document.querySelector("[data-testid=problems-toggle]")?.textContent === "No problems", undefined, { timeout: 20_000 })
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test.skipIf(!haveBrowser)("Ctrl+M lets Tab leave the editor, and the sidebar is a keyboard-operable tab list", async () => {
  const { page, errors } = await open()
  // Without Ctrl+M, Tab stays in the editor (it indents).
  await page.click(".monaco-editor")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => !!document.activeElement?.closest(".monaco-editor"))).toBe(true)
  await page.keyboard.press("Control+m")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => !!document.activeElement?.closest(".monaco-editor"))).toBe(false)

  await page.click("[data-testid=toggle-gallery]")
  expect(await page.getAttribute("[data-testid=toggle-gallery]", "aria-expanded")).toBe("true")
  expect(await page.getAttribute("[role=tablist]", "aria-label")).toBe("Sidebar sections")
  expect(await page.$$eval("[role=tab]", (t) => t.map((x) => [x.textContent, x.getAttribute("aria-selected"), (x as HTMLElement).tabIndex]))).toEqual([
    ["Docs", "false", -1], ["Gallery", "true", 0], ["Saved", "false", -1], ["History", "false", -1]
  ])
  await page.focus("[data-testid=tab-gallery]")
  await page.keyboard.press("ArrowRight")
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("qb-tab-saved")
  expect(await page.isVisible("[data-testid=saved-pane]")).toBe(true)
  await page.keyboard.press("End")
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("qb-tab-history")
  await page.keyboard.press("ArrowRight") // wraps around
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("qb-tab-docs")
  expect(await page.getAttribute("[data-testid=docs-pane]", "role")).toBe("tabpanel")
  expect(await page.getAttribute("[data-testid=docs-pane]", "aria-labelledby")).toBe("qb-tab-docs")

  // Escape closes the sidebar and returns focus to the toggle that opened it.
  await page.keyboard.press("Escape")
  expect(await page.isVisible("[data-testid=sidebar]")).toBe(false)
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe("toggle-docs")
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

// A scripted audit of the rules that matter most for screen readers; it runs over every part of the panel that can be open.
test.skipIf(!haveBrowser)("every control has an accessible name, ids are unique, and ARIA references resolve", async () => {
  const { page, errors } = await open()
  await runSource(page, "map.guardians.select((g) => [g.id, g.position]).toArray()")
  await page.click("[data-testid=problems-toggle]")
  const audit = () => page.evaluate(() => {
    const root = document.querySelector(".dlq-qb")!
    const name = (e: Element): string => {
      const labelledby = e.getAttribute("aria-labelledby")
      if (labelledby) return labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim()
      return (e.getAttribute("aria-label") ?? "").trim() || ((e as HTMLElement).innerText ?? e.textContent ?? "").trim() || (e.getAttribute("title") ?? "").trim() ||
        ((e as HTMLInputElement).labels ? Array.from((e as HTMLInputElement).labels!).map((l) => l.textContent ?? "").join(" ").trim() : "")
    }
    const problems: string[] = []
    const visible = (e: Element) => !!(e as HTMLElement).offsetParent || getComputedStyle(e).position === "fixed"
    for (const e of Array.from(root.querySelectorAll("button, input, select, textarea, [role=button], [role=tab], [role=grid], [role=region]"))) {
      if (!visible(e) || e.closest(".monaco-editor")) continue
      if (!name(e)) problems.push(`no accessible name: <${e.tagName.toLowerCase()} ${e.getAttribute("data-testid") ?? e.className}>`)
    }
    const ids = Array.from(root.querySelectorAll("[id]")).map((e) => e.id)
    for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`duplicate id ${id}`)
    for (const e of Array.from(root.querySelectorAll("[aria-controls], [aria-labelledby]"))) {
      for (const id of `${e.getAttribute("aria-controls") ?? ""} ${e.getAttribute("aria-labelledby") ?? ""}`.split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) problems.push(`dangling reference ${id}`)
    }
    for (const t of Array.from(root.querySelectorAll("th")).filter((x) => x.getAttribute("role") === "columnheader" && x.scope === "col")) {
      if (!t.hasAttribute("aria-sort")) problems.push("sortable header without aria-sort")
    }
    if (!root.querySelector("[role=status]")) problems.push("no live status region")
    return problems
  })
  expect(await audit()).toEqual([])
  for (const tab of ["docs", "gallery", "saved", "history"]) {
    await page.click(`[data-testid=toggle-${tab}]`).catch(() => {})
    if (!(await page.isVisible("[data-testid=sidebar]"))) await page.click(`[data-testid=toggle-${tab}]`)
    expect({ tab, problems: await audit() }).toEqual({ tab, problems: [] })
  }
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test.skipIf(!haveBrowser)("parameter-name inlay hints appear next to literal arguments", async () => {
  const { page, errors } = await open()
  await setSource(page, 'map.guardians.inLane("yellow").toArray()')
  // Monaco renders a hint as an inline decoration whose text is the parameter name; its position is the editor model's.
  await page.waitForFunction(() => /lane\s*:/.test(document.querySelector(".monaco-editor .view-lines")?.textContent ?? "") || document.querySelector(".monaco-editor [class*='inlayHint'], .monaco-editor .dyn-rule") !== null, undefined, { timeout: 30_000 })
  const text = await page.$eval(".monaco-editor .view-lines", (el) => el.textContent ?? "")
  expect(text.replace(/ /g, " ")).toMatch(/lane:\s*"yellow"/)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

test.skipIf(!haveBrowser)("progress() shows in the status while a query runs, and a query's own time budget stops it cleanly", async () => {
  const { page, errors } = await open()
  await page.evaluate(() => {
    const seen: string[] = []
    ;(self as any).__statusSeen = seen
    new MutationObserver(() => seen.push(document.querySelector("#status")?.textContent ?? "")).observe(document.querySelector("#status")!, { childList: true, characterData: true, subtree: true })
  })
  await setSource(page, 'for (let i = 0; i < 5; i++) { progress((i + 1) / 5, "step " + (i + 1)); const t = Date.now(); while (Date.now() - t < 120) {} }\n5')
  await page.click("#run")
  await page.waitForSelector("[data-testid=results-table] tbody tr, [data-testid=error]", { timeout: 20_000 })
  expect(await page.$("[data-testid=error]") ? await page.textContent("[data-testid=error]") : "").toBe("")
  const seen: string[] = await page.evaluate(() => (self as any).__statusSeen)
  expect(seen.some((s) => /running… \d+% step \d/.test(s))).toBe(true)
  expect(await page.textContent("#status")).toBe("done")

  await setSource(page, "withRun({ maxMillis: 60 }, () => { for (;;) progress(0) })")
  await page.click("#run")
  await page.waitForSelector("[data-testid=error]", { timeout: 20_000 })
  expect(await page.textContent("[data-testid=error]")).toContain("time budget")
  expect(errors).toEqual([])
  await page.close()
}, 90_000)
