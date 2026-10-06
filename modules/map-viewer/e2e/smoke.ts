/** Playwright smoke: load fixture, pan/zoom/orbit/fly, reload restores camera, overlays, annotation tools + layers panel. Run: `bun run test:e2e`. */
import { chromium } from "playwright-core"
import { join } from "node:path"
import { Schema } from "effect"
import { AnnotationDocument, validateAnnotationDocument } from "@deadlock-query/contracts"

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
  // Regression: extracted GLBs have no normals; terrain must be lit (not black). Clear colour is 0x14161a and entity dots are saturated.
  const lit = await page.evaluate(() => {
    const c = document.querySelector("canvas")!
    const d = document.createElement("canvas"); d.width = c.width; d.height = c.height
    const ctx = d.getContext("2d")!; ctx.drawImage(c, 0, 0)
    const px = ctx.getImageData(0, 0, d.width, d.height).data
    let n = 0
    for (let i = 0; i < px.length; i += 4) if (px[i]! > 50 && Math.abs(px[i]! - px[i + 2]!) < 40) n++
    return n
  })
  if (lit < 1000) fail(`terrain renders black (${lit} lit px)`)
  await page.goto(url + h4)
  await page.reload()
  await page.waitForSelector('[data-testid="viewer-canvas"][data-loaded="true"]')
  await settle()
  if ((await page.locator('[data-testid="viewer-canvas"]').getAttribute("data-mode")) !== "fly") fail("mode not restored")
  if ((await hash()) !== h4) fail(`camera not restored: ${await hash()} vs ${h4}`)
  // M2 overlays: 10k points render, hover/pick events fire, capture returns a PNG, frame rate holds.
  await page.evaluate(() => {
    const v = (globalThis as any).__viewer
    const pts = Array.from({ length: 10_000 }, (_, i) => [(i % 100) * 20 - 1000, Math.floor(i / 100) * 20 - 1000, 0])
    v.setOverlay("perf", pts, { color: "#ff0000", size: 3 })
    v.setOverlay("marker", [{ type: "point", at: [0, 0, 0] }], { color: "#00ff00", size: 20 })
    v.setPose({ target: [0, 0, 0], yaw: Math.PI / 2, pitch: -1.55, distance: 1500 })
  })
  await settle()
  const red = await page.evaluate(() => {
    const c = document.querySelector("canvas")!
    const d = document.createElement("canvas"); d.width = c.width; d.height = c.height
    const ctx = d.getContext("2d")!; ctx.drawImage(c, 0, 0)
    const px = ctx.getImageData(0, 0, d.width, d.height).data
    let n = 0
    for (let i = 0; i < px.length; i += 4) if (px[i]! > 200 && px[i + 1]! < 60 && px[i + 2]! < 60) n++
    return n
  })
  if (red < 500) fail(`10k point overlay not visible (${red} red px)`)
  const fps = await page.evaluate(async () => {
    const v = (globalThis as any).__viewer
    const t0 = performance.now(); let n = 0
    const pose = v.getPose()
    for (let i = 0; i < 30; i++) { v.setPose({ ...pose, yaw: pose.yaw + i * 0.01 }); await new Promise((r) => requestAnimationFrame(r)); n++ }
    return (n / (performance.now() - t0)) * 1000
  })
  console.log(`overlay fps (software GL, informational): ${fps.toFixed(1)}`)
  await page.mouse.move(450, 300)
  await page.mouse.move(451, 300)
  await page.mouse.click(450, 300)
  await settle()
  const events = (await page.evaluate(() => (globalThis as any).__events)) as Array<{ _tag: string; id?: string }>
  if (!events.some((e) => e._tag === "camera")) fail("no camera event")
  if (!events.some((e) => e._tag === "pick" && e.id === "marker:0")) fail(`no pick of marker: ${JSON.stringify(events.filter((e) => e._tag !== "camera"))}`)
  const pngOk = await page.evaluate(async () => {
    const bytes: Uint8Array = await (globalThis as any).__viewer.capture()
    return bytes[0] === 0x89 && bytes[1] === 0x50
  })
  if (!pngOk) fail("capture is not a PNG")
  // M3: draw with the line tool, undo/redo, layers panel visibility, measure.
  await page.evaluate(() => { const v = (globalThis as any).__viewer; v.removeOverlay("perf"); v.removeOverlay("marker"); v.highlight([]) })
  const annotationCount = () => page.evaluate(() => (globalThis as any).__viewer.annotations.annotations.length as number)
  const orange = () => page.evaluate(() => {
    const c = document.querySelector("canvas")!
    const d = document.createElement("canvas"); d.width = c.width; d.height = c.height
    const ctx = d.getContext("2d")!; ctx.drawImage(c, 0, 0)
    const px = ctx.getImageData(0, 0, d.width, d.height).data
    let n = 0
    for (let i = 0; i < px.length; i += 4) if (px[i]! - px[i + 2]! > 35 && px[i]! > px[i + 1]!) n++
    return n
  })
  await settle()
  const base = await orange() // warm-coloured entity markers are always in the frame
  await page.click('[data-testid="viewer-tools"] button[data-tool="polyline"]')
  await page.mouse.click(350, 250)
  await page.mouse.click(550, 250)
  await page.mouse.click(550, 400)
  await page.keyboard.press("Enter")
  await settle()
  if ((await annotationCount()) !== 1) fail(`polyline not committed (${await annotationCount()})`)
  const lineRow = page.locator('[data-testid="viewer-layers"] [data-layer="ann.lines"]')
  if ((await lineRow.count()) !== 1) fail("annotation layer missing from layers panel")
  if ((await orange()) - base < 100) fail(`drawn polyline not visible (${(await orange()) - base} px)`)
  await lineRow.locator('input[data-role="visible"]').uncheck()
  await settle()
  if ((await orange()) - base > 20) fail("hiding the layer did not hide the polyline")
  await lineRow.locator('input[data-role="visible"]').check()
  await settle()
  if ((await orange()) - base < 100) fail("showing the layer did not restore the polyline")
  await canvas.focus()
  await page.keyboard.press("Control+z")
  await settle()
  if ((await annotationCount()) !== 0) fail("undo did not remove the polyline")
  if ((await orange()) - base > 20) fail("undo left the polyline drawn")
  await page.click('[data-testid="viewer-tools"] button[data-action="redo"]')
  await settle()
  if ((await annotationCount()) !== 1 || (await orange()) - base < 100) fail("redo did not restore the polyline")
  await page.click('[data-testid="viewer-tools"] button[data-tool="measure"]')
  await page.mouse.click(300, 450)
  await page.mouse.click(500, 450)
  await settle()
  const annotations = (await page.evaluate(() => (globalThis as any).__viewer.annotations.annotations)) as Array<{ kind: string }>
  if (annotations.map((a) => a.kind).join() !== "polyline,measure") fail(`unexpected annotations ${JSON.stringify(annotations.map((a) => a.kind))}`)
  await page.click('[data-testid="viewer-tools"] button[data-tool="select"]')
  await page.click('[data-testid="viewer-tools"] button[data-annotation]:has-text("polyline")')
  await page.click('[data-testid="viewer-tools"] button[data-action="delete"]')
  await settle()
  if ((await annotationCount()) !== 1) fail("delete did not remove the selected polyline")
  // M3: autosave survives a reload, export is a schema-valid document, import replaces the annotations.
  await page.evaluate(() => (globalThis as any).__viewer.flushAutosave())
  await page.reload()
  await page.waitForSelector('[data-testid="viewer-canvas"][data-loaded="true"]', { timeout: 20000 })
  await page.waitForFunction(() => (globalThis as any).__viewer.annotations.annotations.length === 1, undefined, { timeout: 5000 })
    .catch(() => fail("autosaved annotation was not restored after reload"))
  const restored = (await page.evaluate(() => (globalThis as any).__viewer.annotations.annotations)) as Array<{ kind: string }>
  if (restored[0]?.kind !== "measure") fail(`restored ${JSON.stringify(restored)}`)
  const exported = await page.evaluate(() => (globalThis as any).__viewer.exportJson() as string)
  const doc = Schema.decodeUnknownSync(AnnotationDocument)(JSON.parse(exported))
  if (validateAnnotationDocument(doc).length || doc.annotations.length !== 1 || doc.mapName === undefined) fail(`bad export ${exported}`)
  const imported = JSON.stringify({
    schemaVersion: "1.0.0",
    annotations: [
      { id: "i1", kind: "point", points: [[0, 0, 0]] },
      { id: "i2", kind: "label", points: [[10, 10, 0]], text: "imported" }
    ]
  })
  await page.setInputFiles('[data-testid="viewer-tools"] input[data-role="import-file"]', {
    name: "annotations.json", mimeType: "application/json", buffer: Buffer.from(imported)
  })
  await page.waitForFunction(() => (globalThis as any).__viewer.annotations.annotations.length === 2, undefined, { timeout: 5000 })
    .catch(() => fail("import did not replace the annotations"))
  await page.setInputFiles('[data-testid="viewer-tools"] input[data-role="import-file"]', {
    name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{}")
  })
  await page.waitForSelector('[data-testid="viewer-tools"] [data-role="status"]:has-text("Import failed")', { timeout: 5000 })
  if ((await annotationCount()) !== 2) fail("a rejected import changed the annotations")
  // M3: snapping, BVH picking, vertex editing, annotation colour.
  const anns = () => page.evaluate(() => (globalThis as any).__viewer.annotations.annotations) as Promise<Array<{ id: string; kind: string; points: number[][]; color?: string }>>
  await page.evaluate(() => (globalThis as any).__viewer.importJson(JSON.stringify({ schemaVersion: "1.0.0", annotations: [] })))
  await page.click('[data-testid="viewer-tools"] button[data-tool="polyline"]')
  await page.mouse.click(350, 250)
  await page.mouse.click(550, 250)
  await page.mouse.click(550, 400)
  await page.keyboard.press("Enter")
  await settle()
  const line0 = (await anns())[0]!
  if (line0.kind !== "polyline" || line0.points.length !== 3) fail(`polyline not drawn for snapping test: ${JSON.stringify(line0)}`)
  if ((await canvas.getAttribute("data-picker")) !== "meshes") fail(`surface picker is ${await canvas.getAttribute("data-picker")}`)
  if (line0.points.some((p) => !Number.isFinite(p[2]))) fail("picked point has no height")
  await page.click('[data-testid="viewer-tools"] button[data-tool="point"]')
  await page.mouse.click(355, 253)
  await settle()
  const snapped = (await anns())[1]!
  if (JSON.stringify(snapped.points[0]) !== JSON.stringify(line0.points[0])) fail(`point did not snap to the polyline vertex: ${JSON.stringify(snapped.points)} vs ${JSON.stringify(line0.points[0])}`)
  await page.evaluate(() => (globalThis as any).__viewer.snapping.set({ features: false, vertices: false }))
  await page.mouse.click(355, 253)
  await settle()
  const free = (await anns())[2]!
  if (JSON.stringify(free.points[0]) === JSON.stringify(line0.points[0])) fail("point snapped although feature snapping is off")
  await page.evaluate(() => (globalThis as any).__viewer.snapping.set({ features: true, vertices: true }))
  // Vertex editing: dragging a handle moves one vertex, not the camera; the drag is one undo step.
  await page.click('[data-testid="viewer-tools"] button[data-tool="select"]')
  await page.evaluate((id) => (globalThis as any).__viewer.selectAnnotation(id), line0.id)
  const handles = await page.evaluate(() => (globalThis as any).__viewer.vertexHandles().length as number)
  if (handles !== 3) fail(`expected 3 vertex handles, got ${handles}`)
  await settle()
  const camBefore = await hash()
  await page.mouse.move(550, 250)
  await page.mouse.down()
  await page.mouse.move(540, 230, { steps: 4 })
  await page.mouse.move(520, 190, { steps: 4 })
  await page.mouse.up()
  await settle()
  const moved = (await anns())[0]!
  if (JSON.stringify(moved.points[1]) === JSON.stringify(line0.points[1])) fail("dragging a handle did not move the vertex")
  if (JSON.stringify(moved.points[0]) !== JSON.stringify(line0.points[0]) || JSON.stringify(moved.points[2]) !== JSON.stringify(line0.points[2])) fail("dragging a handle moved other vertices")
  if ((await hash()) !== camBefore) fail("dragging a handle also moved the camera")
  await canvas.focus()
  await page.keyboard.press("Control+z")
  await settle()
  if (JSON.stringify((await anns())[0]!.points) !== JSON.stringify(line0.points)) fail("undo did not restore the dragged vertex in one step")
  await page.keyboard.press("Control+y")
  await settle()
  if (JSON.stringify((await anns())[0]!.points[1]) !== JSON.stringify(moved.points[1])) fail("redo did not re-apply the drag")
  await page.keyboard.press("Control+z")
  await settle()
  // Double-click an edge adds a vertex; Delete on the new vertex removes it again.
  await page.mouse.dblclick(450, 250)
  await settle()
  if ((await anns())[0]!.points.length !== 4) fail(`double-click on an edge did not insert a vertex (${(await anns())[0]!.points.length})`)
  await page.keyboard.press("Delete")
  await settle()
  if ((await anns())[0]?.points.length !== 3 || (await anns()).length !== 3) fail("Delete on a selected vertex did not remove just that vertex")
  // Annotation colour is drawn: a red polyline gets its own layer and red pixels.
  const reds = () => page.evaluate(() => {
    const c = document.querySelector("canvas")!
    const d = document.createElement("canvas"); d.width = c.width; d.height = c.height
    const ctx = d.getContext("2d")!; ctx.drawImage(c, 0, 0)
    const px = ctx.getImageData(0, 0, d.width, d.height).data
    let n = 0
    for (let i = 0; i < px.length; i += 4) if (px[i]! > 200 && px[i + 1]! < 60 && px[i + 2]! < 60) n++
    return n
  })
  const redBefore = await reds()
  await page.evaluate(() => (globalThis as any).__viewer.annotations.add({ kind: "polyline", points: [[-500, -300, 0], [500, -300, 0], [500, 300, 0]], color: "#ff0000" }))
  await settle()
  if ((await page.locator('[data-testid="viewer-layers"] [data-layer="ann.lines.ff0000"]').count()) !== 1) fail("coloured annotation has no layer of its own")
  if ((await reds()) - redBefore < 100) fail(`annotation colour not drawn (${(await reds()) - redBefore} red px)`)
  if (errors.length) fail(errors.join("; "))
  console.log("map-viewer e2e smoke: ok")
} finally {
  await browser.close()
  server.stop()
}
