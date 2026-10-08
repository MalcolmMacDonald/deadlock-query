import { expect, test } from "bun:test"
import {
  AnnotationStore, ToolMachine, LayerStore, ViewerController, annotationIdForFeature, annotationLayers,
  featureIdForAnnotation, formatMeasurement, measure, memoryStorage
} from "../src/index.ts"
import { Schema } from "effect"
import { AnnotationDocument, validateAnnotationDocument, type Annotation, type Vec3 } from "@deadlock-query/contracts"

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
  expect(store.annotations.map((a) => [a.kind, a.kind === "label" ? a.text : undefined])).toEqual([["point", undefined], ["label", "mid"]])
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
    setDraft: () => {}, setSurfaceVisible: () => {}, setHandles: () => {}, getPose: () => ({ target: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, distance: 1 }),
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

const sample = (): ReadonlyArray<Annotation> => [
  { id: "a1", kind: "point", points: [[1, 2, 3]] },
  { id: "a2", kind: "label", points: [[0, 0, 0]], text: "mid boss", layer: "L1", properties: { note: "x" } },
  { id: "a3", kind: "polyline", points: [[0, 0, 0], [1, 1, 1]] },
  { id: "a4", kind: "polygon", points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], color: "#ff0000" },
  { id: "a5", kind: "measure", points: [[0, 0, 0], [3, 4, 0]] }
]
const layers = [{ id: "L1", name: "Notes", visible: true }]

test("store holds contract annotations: replace is one undo step, generated ids avoid imported ids", () => {
  const store = new AnnotationStore()
  store.add({ kind: "point", points: [[9, 9, 9]] })
  store.replace(sample(), layers)
  expect(store.annotations).toHaveLength(5)
  expect(store.layers).toEqual(layers)
  expect(store.add({ kind: "point", points: [[1, 1, 1]] }).id).toBe("a6")
  store.undo()
  expect(store.annotations.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4", "a5"])
  store.undo()
  expect(store.annotations.map((a) => a.points[0])).toEqual([[9, 9, 9]])
  expect(store.annotations.map((a) => a.kind)).toEqual(["point"])
})

test("export produces a schema-valid document that imports back unchanged", () => {
  const c = new ViewerController()
  c.setMap({ mapName: "dl_midtown", gameBuildId: "123" })
  c.annotations.replace(sample(), layers)
  const text = c.exportJson()
  const doc = Schema.decodeUnknownSync(AnnotationDocument)(JSON.parse(text))
  expect(validateAnnotationDocument(doc)).toEqual([])
  expect(doc.mapName).toBe("dl_midtown")
  const other = new ViewerController()
  other.setMap({ mapName: "dl_midtown", gameBuildId: "123" })
  const r = other.importJson(text)
  expect(r.ok && r.warnings).toEqual([])
  expect(other.annotations.annotations).toEqual(sample())
  expect(JSON.parse(other.exportJson())).toEqual(JSON.parse(text))
})

test("import rejects bad documents without touching the store and warns on a different map", () => {
  const c = new ViewerController()
  c.setMap({ mapName: "dl_midtown", gameBuildId: "123" })
  c.annotations.add({ kind: "point", points: [[1, 1, 1]] })
  expect(c.importJson("{nope").ok).toBe(false)
  expect(c.importJson(JSON.stringify({ schemaVersion: "1.0.0", annotations: [{ id: "a", kind: "polyline", points: [[0, 0, 0]] }] })).ok).toBe(false)
  expect(c.importJson(JSON.stringify({ schemaVersion: "9.0.0", annotations: [] })).ok).toBe(false)
  const dup = c.importJson(JSON.stringify({ schemaVersion: "1.0.0", annotations: [{ id: "a", kind: "point", points: [[0, 0, 0]], layer: "x" }] }))
  expect(dup.ok ? "" : dup.error).toContain('unknown layer "x"')
  expect(c.annotations.annotations).toHaveLength(1)
  const warn = c.importJson(JSON.stringify({ schemaVersion: "1.0.0", mapName: "dl_other", gameBuildId: "9", annotations: [] }))
  expect(warn.ok && warn.warnings).toHaveLength(2)
  expect(c.annotations.annotations).toHaveLength(0)
})

test("autosave writes the document per map and restores it into a fresh controller without an undo step", async () => {
  const storage = memoryStorage()
  const a = new ViewerController()
  a.setMap({ mapName: "dl_midtown" })
  a.useStorage(storage, 0)
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  a.annotations.replace(sample(), layers)
  await a.flushAutosave()
  expect([...storage.entries.keys()]).toEqual(["annotations:dl_midtown"])

  const b = new ViewerController()
  b.setMap({ mapName: "dl_midtown" })
  b.useStorage(storage, 0)
  await new Promise((r) => setTimeout(r, 0))
  expect(b.annotations.annotations).toEqual(sample())
  expect(b.annotations.canUndo).toBe(false)

  const other = new ViewerController()
  other.setMap({ mapName: "dl_other" })
  other.useStorage(storage, 0)
  await new Promise((r) => setTimeout(r, 0))
  expect(other.annotations.annotations).toHaveLength(0)
})

test("restore never overwrites annotations drawn before it finished, and corrupt saves are ignored", async () => {
  const storage = memoryStorage()
  storage.entries.set("annotations:m", "garbage")
  const c = new ViewerController()
  c.setMap({ mapName: "m" })
  c.useStorage(storage, 0)
  c.annotations.add({ kind: "point", points: [[1, 1, 1]] })
  await new Promise((r) => setTimeout(r, 10))
  expect(c.annotations.annotations).toHaveLength(1)
  expect(JSON.parse(storage.entries.get("annotations:m")!).annotations).toHaveLength(1)
})

test("removeLayer deletes the layer, keeps its annotations ungrouped, and is one undo step", () => {
  const { store } = rig()
  const layer = store.addLayer("Rotations")
  store.add({ id: "a1", kind: "point", points: [[0, 0, 0]], layer: layer.id } as Annotation)
  expect(store.removeLayer("nope")).toBe(false)
  expect(store.removeLayer(layer.id)).toBe(true)
  expect(store.layers ?? []).toHaveLength(0)
  expect(store.annotations[0]!.layer).toBeUndefined()
  store.undo()
  expect(store.annotations[0]!.layer).toBe(layer.id)
})
