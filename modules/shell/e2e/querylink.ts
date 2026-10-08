// Query share links (`#q=…`, made by query-builder) open in the shell's editor panel: filled in, not run.
// Needs a Chromium and the query-library build (the editor reads `library.json`). Run: bun e2e/querylink.ts
import { chromium } from "playwright-core"
import { deflateRawSync } from "node:zlib"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "../../../tools/build.ts"
import { buildApp, buildLibraryJson, serve } from "../../query-builder/src/app/build.ts"

const marker = "// shared-from-link-marker"
const link = `#q=${deflateRawSync(Buffer.from(`${marker}\nexport default async () => 42\n`)).toString("base64url")}&api=0.0.0`

const root = join(import.meta.dir, "..")
const vite = Bun.spawnSync(["bunx", "vite", "build"], { cwd: root, stdout: "ignore", stderr: "inherit" })
if (vite.exitCode !== 0) throw new Error("shell build failed")
const site = build("dev", join(mkdtempSync(join(tmpdir(), "dlq-querylink-")), "site"), join(root, "dist"), await buildApp())
writeFileSync(join(site, "library.json"), await buildLibraryJson()) // tools/build.ts writes this next to the shell
const server = serve(site)
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] })
try {
  const page = await browser.newPage()
  await page.goto(`http://localhost:${server.port}/${link}`)
  await page.locator("#run").waitFor({ timeout: 60000 })
  await page.locator(".monaco-editor .view-lines").getByText(marker).waitFor({ timeout: 30000 })
  await page.getByText("Loaded from a share link").first().waitFor({ timeout: 10000 })
  if (await page.getByTestId("results-table").count()) throw new Error("a shared query must not run on load")
  console.log("e2e ok: #q share link fills the embedded editor and is not run")
} finally {
  await browser.close()
  server.stop(true)
}
