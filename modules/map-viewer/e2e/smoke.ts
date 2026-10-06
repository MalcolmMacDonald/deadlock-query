/** Playwright smoke: load fixture, pan/zoom/orbit/fly, reload restores camera. Run: `bun run test:e2e`. */
import { chromium } from "playwright-core"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const fixture = join(root, "../contracts/fixtures/mini-map")
const built = await Bun.build({ entrypoints: [join(import.meta.dir, "harness.ts")], target: "browser" })
if (!built.success) throw new Error(built.logs.join("\n"))
const js = await built.outputs[0]!.text()

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === "/") return new Response('<body style="margin:0"><div id="app" style="width:100vw;height:100vh"></div><script type="module" src="/h.js"></script>', { headers: { "content-type": "text/html" } })
    if (pathname === "/h.js") return new Response(js, { headers: { "content-type": "text/javascript" } })
    if (pathname.startsWith("/fixture/")) return new Response(Bun.file(join(fixture, pathname.slice(9))))
    return new Response("nope", { status: 404 })
  }
})

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
})
const fail = (m: string): never => { throw new Error(`smoke failed: ${m}`) }
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(String(e)))
  const url = `http://localhost:${server.port}/`
  await page.goto(url)
  const canvas = page.locator('[data-testid="viewer-canvas"]')
  await page.waitForSelector('[data-testid="viewer-canvas"][data-loaded="true"]', { timeout: 20000 })
  const hash = () => page.evaluate(() => location.hash)
  const settle = () => page.waitForTimeout(300)
  const drag = async (dx: number, dy: number, button: "left" | "right" = "left") => {
    await page.mouse.move(450, 300)
    await page.mouse.down({ button })
    await page.mouse.move(450 + dx, 300 + dy, { steps: 5 })
    await page.mouse.up({ button })
    await settle()
  }
  await settle()
  const h0 = await hash()
  if (!h0.startsWith("#cam=map:")) fail(`initial hash ${h0}`)
  await drag(120, 40)
  const h1 = await hash()
  if (h1 === h0) fail("pan did not change the camera")
  await page.mouse.move(450, 300)
  await page.mouse.wheel(0, -400)
  await settle()
  const h2 = await hash()
  if (h2 === h1) fail("zoom did not change the camera")
  await page.click('button[data-mode="orbit"]')
  await drag(80, 60)
  const h3 = await hash()
  if (!h3.startsWith("#cam=orbit:") || h3 === h2) fail(`orbit hash ${h3}`)
  await page.click('button[data-mode="fly"]')
  await canvas.focus()
  await page.keyboard.down("w")
  await page.waitForTimeout(500)
  await page.keyboard.up("w")
  await settle()
  const h4 = await hash()
  if (!h4.startsWith("#cam=fly:") || h4 === h3) fail(`fly hash ${h4}`)
  const nonBlank = await page.evaluate(() => {
    const c = document.querySelector("canvas")!
    const d = document.createElement("canvas")
    d.width = c.width; d.height = c.height
    const ctx = d.getContext("2d")!
    ctx.drawImage(c, 0, 0)
    const px = ctx.getImageData(0, 0, d.width, d.height).data
    for (let i = 0; i < px.length; i += 4) if (px[i] !== 0x14 || px[i + 1] !== 0x16 || px[i + 2] !== 0x1a) return true
    return false
  })
  if (!nonBlank) fail("canvas is blank")
  await page.goto(url + h4)
  await page.reload()
  await page.waitForSelector('[data-testid="viewer-canvas"][data-loaded="true"]')
  await settle()
  if ((await page.locator('[data-testid="viewer-canvas"]').getAttribute("data-mode")) !== "fly") fail("mode not restored")
  if ((await hash()) !== h4) fail(`camera not restored: ${await hash()} vs ${h4}`)
  if (errors.length) fail(errors.join("; "))
  console.log("map-viewer e2e smoke: ok")
} finally {
  await browser.close()
  server.stop()
}
