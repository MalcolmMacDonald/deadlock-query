// Viewer side panels: the default layout mounts viewer.tools and viewer.layers beside the map and they drive the shared controller.
// Run: bun e2e/panels.ts (needs a Chromium and a prior `vite build`).
import { chromium } from "playwright-core"
import { spawn } from "node:child_process"

const port = 4174
const server = spawn("bunx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] })
try {
  const page = await browser.newPage()
  for (let i = 0; i < 50; i++) {
    try { await page.goto(`http://localhost:${port}/`); break } catch { await Bun.sleep(200) }
  }
  const canvas = page.locator('[data-testid="viewer-canvas"]')
  await page.waitForSelector('[data-testid="viewer-canvas"][data-loaded="true"]', { timeout: 20000 })
  const tools = page.locator('[data-testid="viewer-tools"]')
  const layers = page.locator('[data-testid="viewer-layers"]')
  await tools.waitFor({ timeout: 10000 })
  await layers.waitFor({ timeout: 10000 })
  const [c, t, l] = await Promise.all([canvas.boundingBox(), tools.boundingBox(), layers.boundingBox()])
  if (!c || !t || !l) throw new Error("panels not rendered")
  if (t.x + t.width > c.x + 2 || l.x + l.width > c.x + 2) throw new Error("tools/layers are not docked left of the map")
  if (l.y < t.y) throw new Error("layers should sit below tools")
  await page.click('[data-testid="viewer-tools"] button[data-tool="point"]')
  await canvas.click({ position: { x: c.width / 2, y: c.height / 2 } })
  await page.locator('[data-testid="viewer-layers"] [data-layer="ann.points"]').waitFor({ timeout: 10000 })
  console.log("e2e ok: tools and layers panels mounted left of the map and share its controller")
} finally {
  await browser.close()
  server.kill()
}
