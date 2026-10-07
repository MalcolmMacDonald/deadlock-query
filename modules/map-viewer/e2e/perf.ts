/**
 * Repeatable viewer performance report on a synthetic full-triangle map (no Valve data): `bun e2e/perf.ts [--json out.json]`.
 * Env: PERF_COLORED=0 for uncoloured tiles, PERF_GRID=<n> for LOD0 grid size (default 345 ~ 238k triangles/tile, 196 cells ~ 46 M),
 * PERF_BUDGET_MB (default 512, the viewer default), PERF_WORKERS=0 for inline decode.
 * Software GL (SwiftShader) in headless Chromium: use it for RELATIVE comparisons between code changes only. Absolute
 * fps and GPU upload cost need real hardware (Malcolm's machine).
 */
import { chromium } from "playwright-core"
import { join } from "node:path"
import { Raycaster } from "@deadlock-query/spatial-core"
import { syntheticMap, DEFAULT_SYNTHETIC } from "./synthetic.ts"

const MB = 1024 * 1024
const grid = Number(process.env.PERF_GRID ?? 345)
const colored = process.env.PERF_COLORED !== "0"
const budget = Number(process.env.PERF_BUDGET_MB ?? 512) * MB
const grids = [grid, Math.round(grid / 2), Math.round(grid / 4)]
const map = syntheticMap({ grids, colored })
const triOf = (n: number) => 2 * (n - 1) * (n - 1)
const cells = DEFAULT_SYNTHETIC.cols * DEFAULT_SYNTHETIC.rows

const build = async (entry: string) => {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, entry)], target: "browser" })
  if (!r.success) throw new Error(r.logs.join("\n"))
  return r.outputs[0]!.text()
}
const [harness, worker] = await Promise.all([build("streamHarness.ts"), build("../src/tileWorker.ts")])
const js = (body: string) => new Response(body, { headers: { "content-type": "text/javascript" } })
const byFile = new Map(map.manifest.tiles.map((t) => [t.file, t.id]))
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
    const id = byFile.get(pathname.replace("/synthetic/", ""))
    if (id) return new Response(map.glb(id) as unknown as BodyInit)
    return new Response("nope", { status: 404 })
  }
})

const report: Record<string, unknown> = {}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-precise-memory-info"]
})
try {
  const tileBytes = (lod: number) => map.manifest.tiles.find((t) => t.id.endsWith(lod === 0 ? "c0_0" : `c0_0#lod${lod}`))!.bytes
  report.map = {
    cells, lods: grids.length, colored,
    trianglesLod0: cells * triOf(grids[0]!), tileFiles: map.manifest.tiles.length,
    totalMB: +(map.totalTileBytes / MB).toFixed(1), lod0TileMB: +(tileBytes(0) / MB).toFixed(2), lod1TileMB: +(tileBytes(1) / MB).toFixed(2), lod2TileMB: +(tileBytes(2) / MB).toFixed(2),
    infraBudgets: { tileMB: 20, siteMB: 900 }, budgetMB: budget / MB
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  const t0 = Date.now()
  await page.goto(`http://localhost:${server.port}/?budget=${budget}${process.env.PERF_WORKERS === "0" ? "&workers=0" : ""}`)
  const stat = (k: string) => page.evaluate((k) => Number(document.querySelector("canvas")!.dataset[`tile${k}`]), k)
  const waitFirstTile = () => page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.tileDisplayed) > 0, undefined, { timeout: 120000 })
  const settle = () => page.waitForFunction(() => {
    const c = document.querySelector("canvas")!
    return Number(c.dataset.tileLoading) === 0 && Number(c.dataset.tileMissing) === 0 && Number(c.dataset.tileDisplayed) > 0
  }, undefined, { timeout: 300000, polling: 50 })
  const sinceNav = () => page.evaluate(() => performance.now())
  await waitFirstTile(); const firstTile = await sinceNav()
  await settle(); const homeSettled = await sinceNav()
  const fetchLog = await page.evaluate(() => (globalThis as any).__fetchLog as Array<{ id: string; t: number }>)
  const home = await page.evaluate(() => (globalThis as any).__viewer.getPose?.() ?? null).catch(() => null)
  report.coldStart = {
    firstTileMs: Math.round(firstTile), homeViewSettledMs: Math.round(homeSettled), wallMs: Date.now() - t0,
    tilesFetched: fetchLog.length, homePose: home,
    residentMB: +((await stat("Bytes")) / MB).toFixed(0), displayed: await stat("Displayed")
  }

  const fly = (x: number, y: number, d: number, pitch = -1.55) => page.evaluate(([x, y, d, p]) => {
    ;(globalThis as any).__viewer.setPose({ target: [x, y, 0], yaw: Math.PI / 2, pitch: p, distance: d })
  }, [x, y, d, pitch] as const)
  const flushPlan = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

  // Streaming order: after a jump, are the first tiles fetched the ones nearest the camera?
  const half = (DEFAULT_SYNTHETIC.cols * DEFAULT_SYNTHETIC.cell) / 2
  await fly(0, 0, 18000); await flushPlan(); await settle()
  const n0 = (await page.evaluate(() => (globalThis as any).__fetchLog.length)) as number
  const tJump = await sinceNav()
  await fly(half - 2500, half - 2500, 1500, -0.9); await flushPlan()
  await settle(); const jumpSettled = (await sinceNav()) - tJump
  const jumpLog = (await page.evaluate((n) => (globalThis as any).__fetchLog.slice(n) as Array<{ id: string; t: number }>, n0))
  const cx = half - 2500, cy = half - 2500
  const dist = (id: string) => {
    const t = map.manifest.tiles.find((x) => x.id === id)!
    const mx = (t.bounds.min[0] + t.bounds.max[0]) / 2, my = (t.bounds.min[1] + t.bounds.max[1]) / 2
    return Math.hypot(mx - cx, my - cy)
  }
  const d = jumpLog.map((e) => dist(e.id))
  let inversions = 0
  for (let i = 1; i < d.length; i++) if (d[i]! + 1e-6 < d[i - 1]! - 1500) inversions++ // allow cell-size slack
  report.jump = { settledMs: Math.round(jumpSettled), tilesFetched: jumpLog.length, firstFetchedDistance: Math.round(d[0] ?? 0), orderInversions: inversions }

  // Frame cost while flying: move the camera every frame along a low path; record frame gaps and heap.
  await fly(-half + 1500, 0, 1300, -0.9); await flushPlan(); await settle()
  const flight = await page.evaluate(async ({ half }) => {
    const v = (globalThis as any).__viewer
    const c = document.querySelector("canvas")!
    const frames: Array<{ gap: number; tris: number; loaded: number }> = []
    let last = performance.now()
    const FRAMES = 90
    let heapMax = 0
    await new Promise<void>((done) => {
      const step = () => {
        const now = performance.now()
        frames.push({ gap: now - last, tris: Number(c.dataset.renderTriangles ?? 0), loaded: Number(c.dataset.tileLoaded ?? 0) })
        last = now
        const k = frames.length / FRAMES
        v.setPose({ target: [-half + 1500 + k * (2 * half - 3000), Math.sin(k * 6) * 4000, 0], yaw: Math.PI / 2 + k, pitch: -0.9, distance: 1300 })
        heapMax = Math.max(heapMax, (performance as any).memory?.usedJSHeapSize ?? 0)
        if (frames.length < FRAMES) requestAnimationFrame(step); else done()
      }
      requestAnimationFrame(step)
    })
    const body = frames.slice(1)
    const gaps = body.map((f) => f.gap).sort((a, b) => a - b)
    const q = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]!
    const tris = body.map((f) => f.tris)
    // Frames in which a tile finished loading (its geometry is uploaded to the GPU on first draw) vs the rest.
    const up = body.filter((f, i) => f.loaded > (i === 0 ? frames[0]!.loaded : body[i - 1]!.loaded)).map((f) => f.gap)
    const rest = body.filter((f, i) => !(f.loaded > (i === 0 ? frames[0]!.loaded : body[i - 1]!.loaded))).map((f) => f.gap)
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
    const meanTris = mean(tris)
    return {
      frames: body.length, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: gaps[gaps.length - 1]!,
      meanTrianglesM: meanTris / 1e6, maxTrianglesM: Math.max(...tris) / 1e6, meanMsPerMTri: meanTris ? mean(body.map((f) => f.gap)) / (meanTris / 1e6) : 0,
      uploadFrames: up.length, meanUploadFrameMs: mean(up), meanOtherFrameMs: mean(rest), heapMaxMB: heapMax / 1048576
    }
  }, { half })
  await settle()
  report.flight = {
    ...Object.fromEntries(Object.entries(flight).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(1) : v])),
    residentMB: +((await stat("Bytes")) / MB).toFixed(0), peakMB: +((await stat("Peak")) / MB).toFixed(0), evicted: await stat("Evicted")
  }
  const totalFetched = (await page.evaluate(() => (globalThis as any).__fetchLog.length)) as number
  report.totalTilesFetched = totalFetched
  if (errors.length) report.errors = errors

  // Picking from meshes (fallback when a bundle has no baked BVH): BVH build cost per million triangles.
  const picking: Record<string, number> = {}
  for (const tris of [1_000_000, 4_000_000]) {
    const g = Math.ceil(Math.sqrt(tris / 2)) + 1
    const pos = new Float32Array(g * g * 3), idx = new Uint32Array((g - 1) * (g - 1) * 6)
    for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) pos.set([i, j, Math.sin(i / 50) * 5], (j * g + i) * 3)
    let k = 0
    for (let j = 0; j + 1 < g; j++) for (let i = 0; i + 1 < g; i++) { const a = j * g + i; idx[k++] = a; idx[k++] = a + g; idx[k++] = a + 1; idx[k++] = a + 1; idx[k++] = a + g; idx[k++] = a + g + 1 }
    const t = performance.now(); const rc = Raycaster.fromGeometry(pos, idx); picking[`buildMs_${tris / 1e6}M`] = Math.round(performance.now() - t)
    const t2 = performance.now(); for (let n = 0; n < 200; n++) rc.raycastFirst([n % g, (n * 7) % g, 100], [0, 0, -1], { backfaces: true }); picking[`raycastUs_${tris / 1e6}M`] = Math.round(((performance.now() - t2) / 200) * 1000)
  }
  report.picking = picking
  console.log(JSON.stringify(report, null, 2))
  const out = process.argv.indexOf("--json")
  if (out > 0) await Bun.write(process.argv[out + 1]!, JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  server.stop()
}
