// M0 acceptance: drag a panel, reload, layout restored. Run: bun run e2e (needs a Chromium).
import { chromium } from "playwright-core"
import { spawn } from "node:child_process"

const port = 4173
const server = spawn("bunx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" })
try {
  const page = await browser.newPage()
  for (let i = 0; i < 50; i++) {
    try { await page.goto(`http://localhost:${port}/`); break } catch { await Bun.sleep(200) }
  }
  const tab = (name: string) => page.locator(".dv-default-tab", { hasText: name })
  const before = await tab("Query").boundingBox()
  const target = await page.locator(".dv-groupview").first().boundingBox()
  if (!before || !target) throw new Error("panels not rendered")
  await page.mouse.move(before.x + 5, before.y + 5)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 20, { steps: 10 })
  await page.mouse.up()
  const moved = await tab("Query").boundingBox()
  await page.reload()
  const after = await tab("Query").boundingBox()
  if (!moved || !after || Math.abs(moved.y - after.y) > 2 || Math.abs(moved.y - before.y) < 2)
    throw new Error(`layout not restored: before=${before.y} moved=${moved?.y} after=${after?.y}`)
  console.log("e2e ok: dragged panel position survives reload")
} finally {
  await browser.close()
  server.kill()
}
