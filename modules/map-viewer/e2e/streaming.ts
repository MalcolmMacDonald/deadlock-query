/** Playwright: stream a synthetic >500 MB map (real heightfield GLBs, 3 LODs) and check the memory budget. Run: `bun e2e/streaming.ts`. */
import { chromium } from "playwright-core"
import { join } from "node:path"
import { syntheticMap, DEFAULT_SYNTHETIC } from "./synthetic.ts"

const map = syntheticMap()
const MB = 1024 * 1024
const BUDGET = 100 * MB
const build = async (entry: string) => {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, entry)], target: "browser" })
  if (!r.success) throw new Error(r.logs.join("\n"))
  return r.outputs[0]!.text()
}
const [harness, worker] = await Promise.all([build("streamHarness.ts"), build("../src/tileWorker.ts")])
const js = (body: string) => new Response(body, { headers: { "content-type": "text/javascript" } })
const byFile = new Map(map.manifest.tiles.map((t) => [t.file, t.id]))
let served = 0

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === "/") return new Response('<body style="margin:0"><div id="app" style="width:100vw;height:100vh"></div><script type="module" src="/h.js"></script>', { headers: { "content-type": "text/html" } })
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 })
    if (pathname === "/h.js") return js(harness)
    if (pathname === "/tileWorker.js") return js(worker)
    if (pathname === "/synthetic/manifest.json") return Response.json(map.manifest)
    if (pathname === "/synthetic/entities.json") return Response.json({ schemaVersion: "1.0.0", entities: [] })
    if (pathname.startsWith("/synthetic/")) {
      const id = byFile.get(pathname.slice("/synthetic/".length))
      if (id) { served++; return new Response(map.glb(id) as unknown as BodyInit) }
    }
    return new Response("nope", { status: 404 })
  }
})

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
})
const fail = (m: string): never => { throw new Error(`streaming e2e failed: ${m}`) }
try {
  if (map.totalTileBytes < 500 * MB) fail(`synthetic map is only ${(map.totalTileBytes / MB).toFixed(0)} MB`)
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://localhost:${server.port}/?budget=${BUDGET}`)
  await page.waitForSelector('[data-testid="viewer-canvas"][data-loaded="true"]', { timeout: 30000 })
  const canvas = page.locator('[data-testid="viewer-canvas"]')
  const stat = async (k: string) => Number(await canvas.getAttribute(`data-tile-${k}`))
  // The plan is recomputed on the next animation frame after the camera moves, so let that happen before asking.
  const settleTiles = async () => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await settleTilesNow()
  }
  const settleTilesNow = () => page.waitForFunction(() => {
    const c = document.querySelector("canvas")!
    return Number(c.dataset.tileLoading) === 0 && Number(c.dataset.tileMissing) === 0 && Number(c.dataset.tileDisplayed) > 0
  }, undefined, { timeout: 60000 })
  const lit = () => page.evaluate(() => {
    const c = document.querySelector("canvas")!
    const d = document.createElement("canvas"); d.width = c.width; d.height = c.height
    const ctx = d.getContext("2d")!; ctx.drawImage(c, 0, 0)
    const px = ctx.getImageData(0, 0, d.width, d.height).data
    let n = 0
    for (let i = 0; i < px.length; i += 4) if (px[i]! > 50 && Math.abs(px[i]! - px[i + 2]!) < 40) n++
    return n
  })
  const flyTo = (x: number, y: number, distance: number) => page.evaluate(([x, y, d]) => {
    const v = (globalThis as any).__viewer
    v.setPose({ target: [x, y, 0], yaw: Math.PI / 2, pitch: -1.55, distance: d })
  }, [x, y, distance] as const)

  const half = (DEFAULT_SYNTHETIC.cols * DEFAULT_SYNTHETIC.cell) / 2
  // 1. Overview of the whole map: coarse tiles everywhere, within the budget.
  await flyTo(0, 0, 18000)
  await settleTiles()
  const overview = { bytes: await stat("bytes"), displayed: await stat("displayed") }
  if (overview.displayed < 30) fail(`overview shows only ${overview.displayed} tiles`)
  if (overview.bytes > BUDGET) fail(`overview resident ${overview.bytes} > budget`)
  if ((await lit()) < 5000) fail("overview terrain not drawn")
  // 2. Fly low across the map: tiles stream in and out; memory never passes the budget.
  const samples: number[] = []
  for (let row = 0; row < 5; row++) {
    const y = -half + 1500 + row * 2800
    for (let k = 0; k <= 8; k++) {
      const x = -half + 1000 + (row % 2 ? 8 - k : k) * 1500
      await flyTo(x, y, 1300)
      await settleTiles()
      samples.push(await stat("bytes"))
      if (samples[samples.length - 1]! > BUDGET) fail(`resident ${samples[samples.length - 1]} exceeds the budget ${BUDGET}`)
    }
  }
  if ((await lit()) < 5000) fail("low flight terrain not drawn")
  const peak = await stat("peak"), evicted = await stat("evicted")
  if (peak > BUDGET) fail(`peak ${peak} exceeds the budget ${BUDGET}`)
  if (evicted === 0) fail("nothing was evicted although far more than the budget was streamed")
  const fetched = (await page.evaluate(() => (globalThis as any).__fetched as string[]))
  const fetchedTiles = new Set(fetched).size
  const streamedBytes = [...new Set(fetched)].reduce((n, id) => n + map.manifest.tiles.find((t) => t.id === id)!.bytes, 0)
  if (streamedBytes < 2 * BUDGET) fail(`only ${streamedBytes} bytes of tiles were streamed`)
  // 3. The tile files really came from workers' decode path and the progress stream reported.
  const progress = (await page.evaluate(() => (globalThis as any).__progress as Array<{ residentBytes: number; budgetBytes: number }>))
  if (progress.length < 10) fail(`progress stream reported ${progress.length} updates`)
  if (progress.some((p) => p.residentBytes > p.budgetBytes)) fail("progress stream reported more resident bytes than the budget")
  // loadBundle(url) streams too: nothing but the manifest, entities and collision is fetched up front.
  const before = served
  await page.evaluate(() => (globalThis as any).__viewer.loadBundle("/synthetic/manifest.json"))
  if (served - before > 5) fail(`loadBundle fetched ${served - before} tiles up front`)
  await settleTiles()
  if ((await stat("displayed")) < 1 || (await stat("bytes")) > BUDGET) fail("loadBundle did not stream tiles within the budget")
  if ((await lit()) < 5000) fail("terrain not drawn after loadBundle")
  if (errors.length) fail(errors.join("; "))
  console.log(
    `streaming e2e ok: map ${(map.totalTileBytes / MB).toFixed(0)} MB, budget ${BUDGET / MB} MB, peak resident ${(peak / MB).toFixed(0)} MB, ` +
    `${fetchedTiles} tiles (${(streamedBytes / MB).toFixed(0)} MB) fetched, ${evicted} evicted, ${served} served`
  )
} finally {
  await browser.close()
  server.stop()
}
