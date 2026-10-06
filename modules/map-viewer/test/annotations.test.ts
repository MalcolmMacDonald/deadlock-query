import { expect, test } from "bun:test"
import {
  AnnotationStore, ToolMachine, LayerStore, ViewerController, annotationIdForFeature, annotationLayers,
  featureIdForAnnotation, formatMeasurement, measure
} from "../src/index.ts"
import type { Vec3 } from "@deadlock-query/contracts"

const rig = () => {
  const store = new AnnotationStore()
  const tools = new ToolMachine((a) => { store.add(a) })
  let t = 0
  const click = (p: Vec3) => tools.click(p, (t += 1000))
  return { store, tools, click }
}

test("measure: 3D, ground and rise along a path", () => {
  const m = measure([[0, 0, 0], [3, 4, 0], [3, 4, 12]])
  expect(m.distance).toBeCloseTo(17)
  expect(m.ground).toBeCloseTo(5)
  expect(m.rise).toBeCloseTo(12)
  expect(formatMeasurement(m)).toContain("3D 17.0u (0.43 m)")
})

test("point and label tools commit on click; label needs text", () => {
  const { store, tools, click } = rig()
  tools.setTool("point")
  click([1, 2, 3])
  tools.setTool("label")
  click([4, 5, 6])
  expect(store.annotations).toHaveLength(1)
  tools.askText = () => "  mid  "
  click([7, 8, 9])
  expect(store.annotations.map((a) => [a.kind, a.text])).toEqual([["point", undefined], ["label", "mid"]])
})

test("polyline finishes with Enter/dblclick; too-short shapes are dropped", () => {
  const { store, tools, click } = rig()
  tools.setTool("polyline")
  click([0, 0, 0])
  tools.finish()
  expect(store.annotations).toHaveLength(0)
  click([0, 0, 0]); click([10, 0, 0]); click([10, 10, 0])
  expect(tools.pending).toBe(3)
  tools.finish()
  expect(tools.pending).toBe(0)
  expect(store.annotations[0]).toMatchObject({ kind: "polyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]] })
  tools.setTool("polygon")
  click([0, 0, 0]); click([5, 0, 0])
  tools.finish()
  expect(store.annotations).toHaveLength(1)
  click([0, 0, 0]); click([5, 0, 0]); click([5, 5, 0])
  tools.finish()
  expect(store.annotations[1]?.kind).toBe("polygon")
})

test("double-click duplicate is ignored, but the same spot later is not", () => {
  const { tools, store } = rig()
  tools.setTool("point")
  tools.click([1, 1, 1], 1000)
  tools.click([1, 1, 1], 1200)
  tools.click([1, 1, 1], 2000)
  expect(store.annotations).toHaveLength(2)
})

test("measure commits after two clicks; Esc and tool switch cancel in-progress shapes", () => {
  const { store, tools, click } = rig()
  tools.setTool("measure")
  click([0, 0, 0])
  expect(tools.draft().length).toBeGreaterThan(0)
  click([0, 3, 4])
  expect(store.annotations[0]).toMatchObject({ kind: "measure" })
  tools.setTool("polyline")
  click([0, 0, 0])
  tools.cancel()
  expect(tools.pending).toBe(0)
  click([0, 0, 0])
  tools.setTool("select")
  expect(tools.pending).toBe(0)
  expect(tools.draft()).toEqual([])
})

test("draft previews the rubber band to the hover point", () => {
  const { tools, click } = rig()
  tools.setTool("polygon")
  click([0, 0, 0]); click([10, 0, 0])
  tools.move([10, 10, 0])
  expect(tools.draft().map((f) => f.type)).toEqual(["point", "point", "polygon"])
  tools.setTool("polyline")
  click([0, 0, 0])
  tools.move([5, 5, 0])
  expect(tools.draft().map((f) => f.type)).toEqual(["point", "polyline"])
})

test("undo/redo walks the history; a new edit clears redo", () => {
  const s = new AnnotationStore()
  const a = s.add({ kind: "point", points: [[0, 0, 0]] })
  s.add({ kind: "point", points: [[1, 1, 1]] })
  s.remove(a.id)
  expect(s.annotations.map((x) => x.id)).toEqual(["a2"])
  expect(s.undo()).toBe(true)
  expect(s.annotations.map((x) => x.id)).toEqual(["a1", "a2"])
  expect(s.undo()).toBe(true)
  expect(s.undo()).toBe(true)
  expect(s.undo()).toBe(false)
  expect(s.annotations).toHaveLength(0)
  expect(s.redo()).toBe(true)
  s.add({ kind: "point", points: [[2, 2, 2]] })
  expect(s.canRedo).toBe(false)
  expect(s.annotations.map((x) => x.id)).toEqual(["a1", "a3"])
})

test("annotation layers: one per populated kind, ids map both ways", () => {
  const s = new AnnotationStore()
  s.add({ kind: "polyline", points: [[0, 0, 0], [1, 0, 0]] })
  const p = s.add({ kind: "point", points: [[0, 0, 0]] })
  const q = s.add({ kind: "point", points: [[5, 5, 5]] })
  const layers = annotationLayers(s.annotations)
  expect(layers.map((l) => l.id)).toEqual(["ann.points", "ann.lines"])
  expect(featureIdForAnnotation(s.annotations, q.id)).toBe("ann.points:1")
  expect(annotationIdForFeature(s.annotations, "ann.points:0")).toBe(p.id)
  expect(annotationIdForFeature(s.annotations, "query:0")).toBeUndefined()
})

test("LayerStore: order, move, patch clamps opacity, drop", () => {
  const l = new LayerStore()
  l.ensure("a", { baseColor: "#f00" })
  l.ensure("b", { baseColor: "#0f0", label: "Bee" })
  l.ensure("c", { baseColor: "#00f" })
  expect(l.list().map((x) => x.id)).toEqual(["a", "b", "c"])
  l.move("a", 1)
  expect(l.list().map((x) => x.id)).toEqual(["b", "a", "c"])
  l.move("c", 1)
  expect(l.list().map((x) => x.id)).toEqual(["b", "a", "c"])
  l.patch("b", { opacity: 4, visible: false, color: "#abc" })
  expect(l.appearance("b")).toEqual({ visible: false, opacity: 1, order: 0, color: "#abc" })
  l.patch("b", { color: undefined })
  expect(l.appearance("b").color).toBeUndefined()
  l.ensure("b", { baseColor: "#fff" })
  expect(l.get("b")).toMatchObject({ label: "Bee", baseColor: "#fff", visible: false })
  l.drop("a")
  expect(l.list().map((x) => x.id)).toEqual(["b", "c"])
})

test("controller: annotations become overlay layers, layers panel state replays on attach, delete + undo round-trips", () => {
  const c = new ViewerController()
  const calls: string[] = []
  const surface = (log: string[]) => ({
    setOverlay: (id: string) => { log.push(`set:${id}`) }, removeOverlay: (id: string) => { log.push(`rm:${id}`) },
    highlight: (ids: ReadonlyArray<string>) => { log.push(`hl:${ids}`) },
    setAppearance: (id: string, a: { visible: boolean }) => { log.push(`ap:${id}:${a.visible}`) },
    setDraft: () => {}, getPose: () => ({ target: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, distance: 1 }),
    setPose: () => {}, capture: async () => new Uint8Array(), loadBundle: async () => {}
  })
  c.tools.setTool("point")
  c.tools.click([1, 2, 3], 1000)
  expect(c.layers.list().map((l) => [l.id, l.label])).toEqual([["ann.points", "Annotation points"]])
  c.layers.patch("ann.points", { visible: false })
  const detach = c.attach(surface(calls))
  expect(calls).toEqual(["ap:ann.points:false", "set:ann.points"])
  c.selectFeature("ann.points:0")
  expect(c.selectedAnnotation).toBe("a1")
  expect(c.deleteSelected()).toBe(true)
  expect(c.selectedAnnotation).toBeUndefined()
  expect(c.layers.list()).toHaveLength(0)
  expect(calls.at(-1)).toBe("hl:")
  c.annotations.undo()
  expect(c.layers.list().map((l) => l.id)).toEqual(["ann.points"])
  detach()
})
