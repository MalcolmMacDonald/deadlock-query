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

  await page.getByText("Your drafts (2)").waitFor()
  await page.evaluate(() => (self as any).__md.drafts.flush())

  await page.reload()
  await page.getByText("Your drafts (2)").waitFor()
  const kinds = await page.evaluate(() => (self as any).__md.drafts.list().map((r: any) => r.kind))
  expect(kinds).toEqual(["creepCamp", "walkableRegion"])

  // Selecting a draft opens its form; editing the tier is saved.
  await page.locator("li.draft .pick").first().click()
  await page.getByLabel("Tier").selectOption("strong")
  await page.evaluate(() => (self as any).__md.drafts.flush())
  expect(await page.evaluate(() => (self as any).__md.drafts.list()[0].tier)).toBe("strong")
  // Submit: a name is required, then a download and a prefilled issue link appear.
  await page.getByRole("button", { name: "Review & submit" }).click()
  await page.getByText("Enter a display name").waitFor()
  await page.getByLabel("Your name").fill("Ada")
  await page.getByRole("button", { name: "Review & submit" }).click()
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

// Submit now: with the human check and network faked, the file is posted and the PR link appears.
test.skipIf(!haveBrowser)("submit now posts the submission and shows the pull request link", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/?mocksubmit`)
  await page.waitForFunction(() => (self as any).__md)
  await page.evaluate(() => (self as any).__md.drafts.clear())
  await page.locator("#toolbar").getByRole("button", { name: "Creep camp" }).click()
  await page.locator("#map").click({ position: { x: 300, y: 300 } })
  await page.getByLabel("Your name").fill("Ada")
  await page.getByRole("button", { name: "Review & submit" }).click()
  await page.getByRole("button", { name: "Submit now" }).click()
  const link = page.getByRole("link", { name: "See your pull request" })
  await link.waitFor()
  expect(await link.getAttribute("href")).toBe("https://github.com/o/r/pull/42")
  const sent: string[] = await page.evaluate(() => (self as any).__md.sent)
  expect(sent).toHaveLength(1)
  expect(JSON.parse(sent[0]!).submitter.name).toBe("Ada")
  expect(errors).toEqual([])
  await page.close()
}, 60_000)
