import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildHarness, serve } from "../harness/build.ts"

const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers"
const dir = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().at(-1) : undefined
const executablePath = process.env.CHROMIUM_PATH ?? (dir ? join(root, dir, "chrome-linux/chrome") : undefined)
const haveBrowser = executablePath !== undefined && existsSync(executablePath)

let browser: Browser
let server: ReturnType<typeof serve>
beforeAll(async () => {
  if (!haveBrowser) return
  server = serve(await buildHarness())
  browser = await chromium.launch({ executablePath: executablePath! })
}, 120_000)
afterAll(async () => { await browser?.close(); server?.stop(true) })

// M1 acceptance: draw a camp point and a walkable polygon in the standalone harness, reload, the drafts are still there.
test.skipIf(!haveBrowser)("drafts drawn in the harness persist across a reload", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForFunction(() => (self as any).__md)
  await page.evaluate(() => (self as any).__md.drafts.clear())

  const canvas = page.locator("#map")
  await page.locator("#toolbar").getByRole("button", { name: "Creep camp" }).click()
  await canvas.click({ position: { x: 300, y: 300 } })
  await page.locator("#toolbar").getByRole("button", { name: "Walkable region" }).click()
  for (const [x, y] of [[100, 100], [250, 100], [250, 200]] as const) await canvas.click({ position: { x, y } })
  await page.keyboard.press("Enter")

  await page.getByText("Draw shapes (2)").waitFor()
  await page.evaluate(() => (self as any).__md.drafts.flush())

  await page.reload()
  await page.getByText("Draw shapes (2)").waitFor()
  const kinds = await page.evaluate(() => (self as any).__md.drafts.list().map((r: any) => r.kind))
  expect(kinds).toEqual(["creepCamp", "walkableRegion"])

  // Submit: a name is required, then a download and a prefilled issue link appear.
  await page.getByRole("button", { name: "Send for review" }).click()
  await page.getByText("Enter a display name").waitFor()
  await page.getByLabel("Your name").fill("Ada")
  await page.getByRole("button", { name: "Send for review" }).click()
  const link = page.getByRole("link", { name: "Open GitHub issue" })
  await link.waitFor()
  expect(await link.getAttribute("href")).toContain("labels=metadata-submission")
  await page.getByRole("button", { name: /^Download metadata-submission-/ }).waitFor()
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

// M5: the review panel lists the queued submission, bulk-accepts the valid records and merges.
test.skipIf(!haveBrowser)("review panel: open a submission, accept valid records, commit and merge", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/?review`)
  await page.waitForFunction(() => (self as any).__md?.review)
  await page.getByRole("button", { name: /^#1 / }).click()
  await page.getByRole("button", { name: "Accept all valid" }).click()
  await page.getByLabel("Reviewer").fill("Malcolm")
  await page.getByRole("button", { name: /^Commit decisions/ }).click()
  await page.getByText(/^Merged:/).waitFor()
  const calls: string[] = await page.evaluate(() => (self as any).__md.calls)
  expect(calls.some((c) => c.startsWith("commit data/metadata/"))).toBe(true)
  expect(calls.at(-1)).toBe("merge")
  await page.getByText("No open submissions").waitFor()
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

// Send for review: with the network faked and no human check, the file is posted and the PR link appears.
test.skipIf(!haveBrowser)("send for review posts the submission and shows the pull request link", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/?mocksubmit`)
  await page.waitForFunction(() => (self as any).__md)
  await page.evaluate(() => (self as any).__md.drafts.clear())
  await page.locator("#toolbar").getByRole("button", { name: "Creep camp" }).click()
  await page.locator("#map").click({ position: { x: 300, y: 300 } })
  await page.getByLabel("Your name").fill("Ada")
  await page.getByRole("button", { name: "Send for review" }).click()
  const link = page.getByRole("link", { name: "See your pull request" })
  await link.waitFor()
  expect(await link.getAttribute("href")).toBe("https://github.com/o/r/pull/42")
  const sent: string[] = await page.evaluate(() => (self as any).__md.sent)
  expect(sent).toHaveLength(1)
  expect(JSON.parse(sent[0]!).submitter.name).toBe("Ada")
  expect(errors).toEqual([])
  await page.close()
}, 60_000)

// Tagging: select entities on the map, press a tag once for all of them, see the tagged state, press again to remove.
test.skipIf(!haveBrowser)("tag several selected entities at once, then untag them", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/?tags&mocksubmit`)
  await page.waitForFunction(() => (self as any).__md?.tags)
  await page.evaluate(() => (self as any).__md.drafts.clear())
  const canvas = page.locator("#map")
  const at = async (i: number) => page.evaluate((i) => { const m = (self as any).__md; const [x, y] = m.toScreen([(i % 4) * 400 - 600, Math.floor(i / 4) * 400 - 400, 0]); return { x, y } }, i)
  const tag = page.getByRole("button", { name: /^Heavy box/ })
  expect(await tag.isDisabled()).toBe(true)
  await canvas.click({ position: await at(0) })
  await canvas.click({ position: await at(1), modifiers: ["Shift"] })
  await canvas.click({ position: await at(5), modifiers: ["Shift"] })
  await page.getByText("3 selected").waitFor()
  await tag.click()
  expect(await tag.getAttribute("aria-pressed")).toBe("true")
  expect(await page.evaluate(() => (self as any).__md.drafts.list().map((r: any) => `${r.label}:${r.properties.entityId}`))).toEqual(["heavy-box:ent-0", "heavy-box:ent-1", "heavy-box:ent-5"])
  await tag.getByText("3 tagged").waitFor()
  // A different selection keeps the earlier tags; one entity can carry two tags.
  await canvas.click({ position: await at(0) })
  await page.getByRole("button", { name: /^Labelling box/ }).click()
  expect(await page.evaluate(() => (self as any).__md.drafts.list().length)).toBe(4)
  await page.getByRole("button", { name: /^Heavy box/ }).click()   // all selected carry it, so this removes it
  expect(await page.evaluate(() => (self as any).__md.drafts.list().map((r: any) => `${r.label}:${r.properties.entityId}`))).toEqual(["heavy-box:ent-1", "heavy-box:ent-5", "labelling-box:ent-0"])
  // Tags go out in a submission like any draft.
  await page.getByLabel("Your name").fill("Ada")
  await page.getByRole("button", { name: "Send for review" }).click()
  await page.getByRole("link", { name: "See your pull request" }).waitFor()
  expect(JSON.parse((await page.evaluate(() => (self as any).__md.sent))[0]).records).toHaveLength(3)
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
