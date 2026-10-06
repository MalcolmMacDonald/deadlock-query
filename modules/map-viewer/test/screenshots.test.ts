import { expect, test } from "bun:test"
import { Effect } from "effect"
import { makeScreenshotSet, ViewerService, type Shot, type Vec3 } from "@deadlock-query/contracts"
import {
  ViewerController, frustumGlyph, makeViewerService, parseScreenshotSet, screenshotLayers, shotIndexForFeature, viewAxes
} from "../src/index.ts"

const near = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6))

const shot = (id: string, position: Vec3, angles: Vec3 = [0, 0, 0], extra: Partial<Shot> = {}): Shot => ({
  id, requested: { position, angles }, file: `${id}.png`, bytes: 10, sha256: "0".repeat(64), width: 1600, height: 900, capturedAt: "2026-10-06T12:00:00Z", ...extra
})
const META = { gameBuildId: "build1", mapName: "dl_midtown", fov: 90, hideHud: true }
const setOf = (shots: Shot[], extra: object = {}) => makeScreenshotSet({ ...META, ...extra }, shots)

test("viewAxes follows Source angles: pitch down looks -Z, yaw turns counter-clockwise, roll tilts the right side down", () => {
  const level = viewAxes([0, 0, 0])
  near(level.forward, [1, 0, 0]); near(level.right, [0, -1, 0]); near(level.up, [0, 0, 1])
  near(viewAxes([90, 0, 0]).forward, [0, 0, -1])
  near(viewAxes([0, 90, 0]).forward, [0, 1, 0]); near(viewAxes([0, 90, 0]).right, [1, 0, 0])
  const rolled = viewAxes([0, 0, 90])
  near(rolled.forward, [1, 0, 0]); near(rolled.right, [0, 0, -1])
})

test("frustumGlyph is a far rectangle plus four edges to the camera, sized by fov and image aspect", () => {
  const [rect, edges] = frustumGlyph(shot("a", [10, 20, 30]), 90, 100)
  expect(rect!.type).toBe("polyline")
  const pts = (rect as unknown as { points: Vec3[] }).points
  expect(pts).toHaveLength(5)
  // fov 90 at length 100 -> half height 100, half width 100 * 16/9; the rectangle is centred 100 ahead (+X).
  near(pts[0]!, [110, 20 + 100 * (16 / 9), 30 + 100])
  near(pts[2]!, [110, 20 - 100 * (16 / 9), 30 - 100])
  const e = (edges as unknown as { points: Vec3[] }).points
  expect(e).toHaveLength(8)
  near(e[0]!, [10, 20, 30]); near(e[1]!, pts[0]!)
})

test("the read-back pose wins over the requested one for markers and glyphs", () => {
  const s = shot("a", [0, 0, 0], [0, 0, 0], { actual: { position: [5, 5, 5], angles: [0, 90, 0] } })
  const { markers } = screenshotLayers(setOf([s]))
  expect(markers.features[0]).toEqual({ type: "point", at: [5, 5, 5] })
})

test("screenshotLayers: one marker per shot, two glyph features per shot, ids map back to the shot", () => {
  const set = setOf([shot("a", [0, 0, 0]), shot("b", [100, 0, 0])])
  const { markers, view } = screenshotLayers(set)
  expect(markers.features).toHaveLength(2)
  expect(view.features).toHaveLength(4)
  expect(markers.label).toBe("Screenshots (2)")
  expect(shotIndexForFeature("screenshots:1")).toBe(1)
  expect(shotIndexForFeature("screenshots.view:3")).toBe(1)
  expect(shotIndexForFeature("entities.guardian:3")).toBeUndefined()
  expect(shotIndexForFeature("screenshots:x")).toBeUndefined()
  expect(screenshotLayers({ ...set, placeholder: true }).markers.label).toBe("Screenshots (placeholder) (2)")
})

test("parseScreenshotSet accepts a valid set, rejects another map or build, and warns about shots whose pose strayed", () => {
  const good = setOf([shot("a", [0, 0, 0])])
  const ok = parseScreenshotSet(JSON.stringify(good), { mapName: "dl_midtown", gameBuildId: "build1" })
  expect(ok.ok && ok.warnings).toEqual([])
  const wrongMap = parseScreenshotSet(JSON.stringify(good), { mapName: "dl_other" })
  expect(wrongMap.ok).toBe(false)
  const wrongBuild = parseScreenshotSet(JSON.stringify(good), { gameBuildId: "build2" })
  expect(!wrongBuild.ok && wrongBuild.error).toContain("gameBuildId")
  expect(parseScreenshotSet("nope").ok).toBe(false)
  expect(parseScreenshotSet(JSON.stringify({ ...good, schemaVersion: "2.0.0" })).ok).toBe(false)
  const off = setOf([shot("a", [0, 0, 0], [0, 0, 0], { actual: { position: [50, 0, 0], angles: [0, 0, 0] } })])
  const warned = parseScreenshotSet(JSON.stringify(off))
  expect(warned.ok && warned.warnings[0]).toContain("units off")
  const dup = setOf([shot("a", [0, 0, 0]), shot("a", [1, 0, 0], [0, 0, 0], { file: "other.png" })])
  expect(parseScreenshotSet(JSON.stringify(dup)).ok).toBe(false)
})

test("controller: a set becomes two overlay layers, picks select the shot, removing the set clears them", () => {
  const c = new ViewerController()
  const set = setOf([shot("a", [0, 0, 0]), shot("b", [100, 0, 0])])
  let changes = 0
  c.onShotChange(() => changes++)
  c.setScreenshots({ set, imageUrl: (f) => `/img/${f}` })
  expect(c.layers.get("screenshots")?.label).toBe("Screenshots (2)")
  expect(c.layers.get("screenshots.view")).toBeDefined()
  expect(c.shotForFeature("screenshots:1")?.id).toBe("b")
  expect(c.shotForFeature("screenshots.view:0")?.id).toBe("a")
  c.selectFeature("screenshots:1")
  expect(c.selectedShot?.id).toBe("b")
  c.selectFeature("screenshots.view:1")
  expect(c.selectedShot?.id).toBe("a")
  c.selectShot(undefined)
  expect(c.selectedShot).toBeUndefined()
  c.selectShot("b")
  c.setScreenshots({ set: setOf([shot("a", [0, 0, 0])]), imageUrl: (f) => f })
  expect(c.selectedShot).toBeUndefined()
  c.setScreenshots(undefined)
  expect(c.layers.get("screenshots")).toBeUndefined()
  expect(c.shotForFeature("screenshots:0")).toBeUndefined()
  expect(changes).toBeGreaterThan(3)
})

test("lookThroughShot puts the camera at the shot looking the way it looked", () => {
  const c = new ViewerController()
  c.lookThroughShot(shot("a", [10, 20, 30], [0, 90, 0]), 100)
  const p = c.getPose()
  near(p.target, [10, 120, 30])
  expect(p.distance).toBeCloseTo(100, 6)
})

test("ViewerService.registerTool registers on the controller; a duplicate id is a defect", async () => {
  const c = new ViewerController()
  const tool = { id: "ext.one", label: "One" }
  const off = await Effect.runPromise(Effect.gen(function* () {
    const v = yield* ViewerService
    return yield* v.registerTool!(tool)
  }).pipe(Effect.provide(makeViewerService(c))))
  expect(c.tools.registered.map((t) => t.id)).toEqual(["ext.one"])
  await expect(Effect.runPromise(Effect.gen(function* () { return yield* (yield* ViewerService).registerTool!(tool) }).pipe(Effect.provide(makeViewerService(c))))).rejects.toThrow("already registered")
  off()
  expect(c.tools.registered).toHaveLength(0)
})

test("loadScreenshots fetches an index.json, resolves images beside it, and rejects a set for another map", async () => {
  const real = globalThis.fetch
  const body = JSON.stringify(setOf([shot("a", [0, 0, 0])]))
  globalThis.fetch = (async (u: URL | string) => String(u).endsWith("index.json") ? new Response(body) : new Response("", { status: 404 })) as typeof fetch
  try {
    const c = new ViewerController()
    c.setMap({ mapName: "dl_midtown", gameBuildId: "build1" })
    expect(await c.loadScreenshots("http://x.test/data/shots/index.json")).toEqual([])
    expect(c.screenshots?.imageUrl("a.png")).toBe("http://x.test/data/shots/a.png")
    expect(c.layers.get("screenshots")).toBeDefined()
    const other = new ViewerController()
    other.setMap({ mapName: "dl_other" })
    await expect(other.loadScreenshots("http://x.test/data/shots/index.json")).rejects.toThrow("mapName")
    expect(other.screenshots).toBeUndefined()
    await expect(c.loadScreenshots("http://x.test/missing.json")).rejects.toThrow("404")
  } finally { globalThis.fetch = real }
})
