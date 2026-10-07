import { expect, test } from "bun:test"
import { Effect } from "effect"
import { MapDataService, MockMapDataService } from "@deadlock-query/contracts"
import {
  SurfaceStore, ViewerController, buildScene, loadViewerData, setSurfaceVisible, surfacesOf, type SurfaceKind
} from "../src/index.ts"

const fixture = () =>
  Effect.runPromise(Effect.gen(function* () {
    const loaded = yield* loadViewerData
    const collision = yield* (yield* MapDataService).collisionBytes
    return { ...loaded, collision }
  }).pipe(Effect.provide(MockMapDataService)))

test("the render mesh is the default; collision is opt-in and the choice sticks", () => {
  const s = new SurfaceStore()
  s.setAvailable({ render: true, collision: true })
  expect(s.list().map((x) => [x.kind, x.visible])).toEqual([["render", true], ["collision", false]])
  s.set("collision", true)
  expect(s.isVisible("collision")).toBe(true)
  s.setAvailable({ render: true, collision: true })
  s.set("render", false)
  expect(s.list().map((x) => [x.kind, x.visible])).toEqual([["render", false], ["collision", true]])
})

test("a map without render tiles shows its collision mesh until the user chooses otherwise", () => {
  const s = new SurfaceStore()
  let n = 0
  s.subscribe(() => n++)
  s.setAvailable({ render: false, collision: true })
  expect(s.isVisible("collision")).toBe(true)
  expect(s.list().find((x) => x.kind === "render")!.available).toBe(false)
  s.setAvailable({ render: true, collision: true }) // the next map has render tiles
  expect(s.isVisible("collision")).toBe(false)
  s.setAvailable({ render: false, collision: true })
  s.set("collision", false)
  expect(s.isVisible("collision")).toBe(false)
  expect(n).toBe(4)
})

test("surfacesOf reports what the manifest carries", async () => {
  const data = await fixture()
  expect(surfacesOf(data)).toEqual({ render: true, collision: true })
  expect(surfacesOf({ ...data, collision: undefined }).collision).toBe(false)
  expect(surfacesOf({ ...data, manifest: { ...data.manifest, tiles: [] } }).render).toBe(false)
})

test("buildScene tags render and collision meshes so each can be toggled", async () => {
  const root = await buildScene(await fixture())
  const of = (k: SurfaceKind) => root.children.filter((c) => c.userData.surface === k)
  expect(of("render").length).toBeGreaterThan(0)
  expect(of("collision")).toHaveLength(1)
  setSurfaceVisible(root, "collision", false)
  expect(of("collision")[0]!.visible).toBe(false)
  expect(of("render").every((c) => c.visible)).toBe(true)
  setSurfaceVisible(root, "collision", true)
  expect(of("collision")[0]!.visible).toBe(true)
})

test("the controller pushes surface visibility to the surface on attach and on change", () => {
  const c = new ViewerController()
  c.surfaces.setAvailable({ render: true, collision: true })
  const log: string[] = []
  c.attach({
    setOverlay() {}, removeOverlay() {}, highlight() {}, setAppearance() {}, setDraft() {}, setHandles() {},
    setSurfaceVisible: (k, v) => { log.push(`${k}:${v}`) },
    getPose: () => c.getPose(), setPose() {}, capture: async () => new Uint8Array(), loadBundle: async () => {}
  })
  expect(log).toEqual(["render:true", "collision:false"])
  c.surfaces.set("collision", true)
  expect(log.slice(2)).toEqual(["render:true", "collision:true"])
})
