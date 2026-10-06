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

// M4: docs panel, hover links, snippets, gallery, friendly errors.
const editorValue = (page: Awaited<ReturnType<typeof open>>["page"]) => page.evaluate(() => (self as any).__qb.editor.getValue() as string)

test.skipIf(!haveBrowser)("docs panel searches the catalog and inserts at the cursor", async () => {
  const { page, errors } = await open()
  await setSource(page, "map.healingOrbs")
  await page.evaluate(() => { const e = (self as any).__qb.editor; e.setPosition(e.getModel().getFullModelRange().getEndPosition()) })
  await page.click("[data-testid=toggle-docs]")
  expect(await page.$$eval("[data-testid=doc-item]", (r) => r.length)).toBeGreaterThan(80)
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
