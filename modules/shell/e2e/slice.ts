// M2 acceptance (editor half): load the built site, map renders, run a query in the editor, rows appear.
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
  const frame = page.frameLocator('iframe[title="Query editor"]')
  await frame.locator("#run").waitFor({ timeout: 30000 })
  await frame.locator("#run").click()
  await frame.getByTestId("results-table").waitFor({ timeout: 30000 })
  const rows = await frame.locator('[data-testid="results-table"] tbody tr').count()
  if (rows < 1) throw new Error("no result rows")
  console.log(`e2e ok: map canvas rendered, query ran in the editor panel, ${rows} rows`)
} finally {
  await browser.close()
  server.stop(true)
}
