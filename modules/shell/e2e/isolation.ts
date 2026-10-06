// M1 acceptance: a failing module shows an error panel while others stay live. Run: bun run e2e
import { chromium } from "playwright-core"
import { spawn } from "node:child_process"

const port = 4174
const server = spawn("bunx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" })
try {
  const page = await browser.newPage()
  for (let i = 0; i < 50; i++) {
    try { await page.goto(`http://localhost:${port}/?demoFailure`); break } catch { await Bun.sleep(200) }
  }
  await page.getByTestId("error-panel-dummy-broken").waitFor({ timeout: 10000 })
  await page.locator("canvas").first().waitFor({ timeout: 20000 }) // the map panel stays live
  if (!(await page.getByText("dummy-broken failed to start").count())) throw new Error("error message missing")
  console.log("e2e ok: failing module isolated, others live")
} finally {
  await browser.close()
  server.kill()
}
