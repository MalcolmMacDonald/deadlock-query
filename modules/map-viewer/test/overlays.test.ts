import { expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { MockViewerService, ViewerService, type OverlayFeature, type Vec3 } from "@deadlock-query/contracts"
import {
  OverlayScene, ViewerController, featureId, makeViewerService, normalizeFeatures, parseFeatureId, pickFeature,
  type OverlayLayerData, type Project
} from "../src/index.ts"

const ortho: Project = (p) => [p[0], p[1]]
const layer = (features: OverlayFeature[], size?: number): [string, OverlayLayerData] => ["L", { features, style: size === undefined ? {} : { size } }]

test("bare Vec3 arrays become point features; ids round-trip", () => {
  const f = normalizeFeatures([[1, 2, 3], [4, 5, 6]] as Vec3[])
  expect(f).toEqual([{ type: "point", at: [1, 2, 3] }, { type: "point", at: [4, 5, 6] }])
  expect(parseFeatureId(featureId("a:b", 7))).toEqual({ layerId: "a:b", index: 7 })
  expect(parseFeatureId("nope")).toBeUndefined()
})

test("picking: nearest point, line edge, polygon interior; misses return null", () => {
  const layers = [layer([
    { type: "point", at: [10, 10, 0] },
    { type: "polyline", points: [[100, 0, 0], [200, 0, 0]] },
    { type: "polygon", ring: [[300, 300, 0], [400, 300, 0], [400, 400, 0], [300, 400, 0]] }
  ])]
  expect(pickFeature(layers, ortho, 12, 12)).toBe("L:0")
  expect(pickFeature(layers, ortho, 150, 3)).toBe("L:1")
  expect(pickFeature(layers, ortho, 350, 350)).toBe("L:2")
  expect(pickFeature(layers, ortho, 250, 250)).toBeNull()
  expect(pickFeature(layers, () => undefined, 12, 12)).toBeNull()
})

test("OverlayScene: set/remove/highlight manage objects; 10k points is one draw call and fast to build", () => {
  let changes = 0
  const s = new OverlayScene(() => changes++)
  const pts = Array.from({ length: 10_000 }, (_, i): Vec3 => [i, i * 2, 0])
  const t0 = performance.now()
  s.set("pts", pts, { color: "#ff0000", size: 4 })
  expect(performance.now() - t0).toBeLessThan(500)
  expect(s.layerIds).toEqual(["pts"])
  expect(s.root.children.length).toBe(3) // highlight group + draft group + layer group
  expect(s.root.children[2]!.children.length).toBe(1) // one Points draw call for 10k points
  expect(s.root.children[0]!.children.length).toBe(0)
  s.highlight(["pts:5", "missing:0"])
  expect(s.root.children[0]!.children.length).toBe(1)
  s.remove("pts")
  expect(s.layerIds).toEqual([])
  expect(s.root.children[0]!.children.length).toBe(0)
  expect(s.root.children.length).toBe(2)
  expect(changes).toBe(3)
})

test("ViewerService: overlays set before a panel mounts replay on attach; camera round-trips; events stream", async () => {
  const c = new ViewerController()
  const calls: string[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const v = yield* ViewerService
    yield* v.setOverlay("a", [[1, 2, 3]], { color: "#0f0" })
    yield* v.highlight(["a:0"])
    yield* v.setCamera([0, -500, 500], [0, 0, 0])
    const cam = yield* v.getCamera
    expect(cam.target).toEqual([0, 0, 0])
    expect(cam.position[1]).toBeCloseTo(-500)
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(v.events, 1)))
    yield* Effect.sleep("10 millis")
    c.emit({ _tag: "pick", id: "a:0" })
    expect(Array.from(yield* Fiber.join(fiber))).toEqual([{ _tag: "pick", id: "a:0" }])
  }).pipe(Effect.provide(makeViewerService(c))))
  c.attach({
    setOverlay: (id) => calls.push(`set:${id}`), removeOverlay: (id) => calls.push(`rm:${id}`),
    highlight: (ids) => calls.push(`hl:${ids}`), getPose: () => ({ target: [9, 9, 9], yaw: 0, pitch: 0, distance: 1 }),
    setAppearance: () => {}, setDraft: () => {},
    setPose: () => {}, capture: async () => new Uint8Array([1]), loadBundle: async () => {}
  })
  expect(calls).toEqual(["set:a", "hl:a:0"])
  c.removeOverlay("a")
  expect(calls.at(-1)).toBe("rm:a")
  expect(c.getPose().target).toEqual([9, 9, 9])
})

test("ViewerService: unmounted capture/loadBundle fail with a clear error", async () => {
  const r = await Effect.runPromise(Effect.gen(function* () {
    const v = yield* ViewerService
    return yield* v.captureImage.pipe(Effect.flip)
  }).pipe(Effect.provide(makeViewerService(new ViewerController()))))
  expect(r.message).toContain("not mounted")
})

test("parity with MockViewerService: same members, and mutating calls succeed on both", async () => {
  const keys = (layer: Layer.Layer<ViewerService>) => Effect.runPromise(Effect.gen(function* () { return Object.keys(yield* ViewerService).sort() }).pipe(Effect.provide(layer)))
  expect(await keys(makeViewerService(new ViewerController()))).toEqual(await keys(MockViewerService))
  for (const layer of [makeViewerService(new ViewerController()), MockViewerService] as const) {
    await Effect.runPromise(Effect.gen(function* () {
      const v = yield* ViewerService
      yield* v.setOverlay("x", [[0, 0, 0]])
      yield* v.highlight([])
      yield* v.removeOverlay("x")
      yield* v.flyTo([1, 1, 1], 100)
    }).pipe(Effect.provide(layer)))
  }
})
