// M2 acceptance: load the built site, run a query in the embedded editor; its rows overlay and highlight on the real map.
// Needs a Chromium, the query-library build, and no network. Run: bun e2e/slice.ts
import { chromium } from "playwright-core"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "../../../tools/build.ts"
import { buildApp, serve } from "../../query-builder/src/app/build.ts"

const root = join(import.meta.dir, "..")
const vite = Bun.spawnSync(["bunx", "vite", "build"], { cwd: root, stdout: "ignore", stderr: "inherit" })
if (vite.exitCode !== 0) throw new Error("shell build failed")
const site = build("dev", join(mkdtempSync(join(tmpdir(), "dlq-slice-")), "site"), join(root, "dist"), await buildApp())
const server = serve(site)
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] })
try {
  const page = await browser.newPage()
  await page.goto(`http://localhost:${server.port}/`)
  await page.locator("canvas").first().waitFor({ timeout: 20000 })
  // The query editor is mounted in the page (no iframe) and shares the shell's viewer.
  const run = page.locator("#run")
  await run.waitFor({ timeout: 60000 })
  await run.click()
  const table = page.getByTestId("results-table")
  await table.waitFor({ timeout: 30000 })
  const rows = await table.locator("tbody tr").count()
  if (rows < 1) throw new Error("no result rows")
  // The result overlay lands on the real map: the viewer's Layers panel lists it.
  await page.locator('[data-testid="viewer-layers"] [data-layer="query-result"]').waitFor({ timeout: 10000 })
  // Clicking a row highlights its features on the map.
  await table.locator("tbody tr").first().click()
  await page.waitForFunction(() => (globalThis as any).__viewerController?.highlighted?.length > 0, null, { timeout: 10000 })
  const highlighted = await page.evaluate(() => (globalThis as any).__viewerController.highlighted as string[])
  if (!highlighted.every((id) => id.includes(":"))) throw new Error(`unexpected highlight ids: ${highlighted}`)
  console.log(`e2e ok: map rendered, query ran in the embedded editor, ${rows} rows, overlay on the map, row click highlighted ${highlighted.join(",")}`)
} finally {
  await browser.close()
  server.stop(true)
}
