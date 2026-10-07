import { expect, test } from "bun:test"
import type { Vec3 } from "@deadlock-query/contracts"
import {
  ViewerController, annotationLayers, isHidden, isLocked, labelAnchor, layerLabels, MAX_LABELS_PER_LAYER
} from "../src/index.ts"

const withThree = () => {
  const c = new ViewerController()
  const a = c.annotations.add({ kind: "point", points: [[0, 0, 0]] })
  const b = c.annotations.add({ kind: "polyline", points: [[0, 0, 0], [10, 0, 0]] })
  const d = c.annotations.add({ kind: "polygon", points: [[0, 0, 0], [10, 0, 0], [0, 10, 0]] })
  return { c, a, b, d }
}

test("multi-select: toggle, replace, select all, one-step delete", () => {
  const { c, a, b, d } = withThree()
  c.selectAnnotation(a.id)
  c.toggleAnnotation(b.id)
  expect(c.selection).toEqual([a.id, b.id])
  expect(c.selectedAnnotation).toBe(b.id)
  c.toggleAnnotation(a.id)
  expect(c.selection).toEqual([b.id])
  c.selectAll()
  expect(c.selection).toEqual([a.id, b.id, d.id])
  c.setSelection([a.id, "nope", a.id, d.id])
  expect(c.selection).toEqual([a.id, d.id])
  expect(c.deleteSelected()).toBe(true)
  expect(c.annotations.annotations.map((x) => x.id)).toEqual([b.id])
  expect(c.selection).toEqual([])
  c.annotations.undo()
  expect(c.annotations.annotations).toHaveLength(3) // both deletions come back with one undo
})

test("multi-select shows every selected annotation as highlighted", () => {
  const { c, a, b } = withThree()
  const seen: ReadonlyArray<string>[] = []
  c.attach({
    setOverlay() {}, removeOverlay() {}, highlight: (ids) => seen.push(ids), setAppearance() {}, setSurfaceVisible() {}, setDraft() {}, setHandles() {},
    getPose: () => c.getPose(), setPose() {}, capture: async () => new Uint8Array(), loadBundle: async () => {}
  })
  c.setSelection([a.id, b.id])
  expect(seen[seen.length - 1]).toEqual(["ann.points:0", "ann.lines:0"])
})

test("vertex handles only appear for a single selection", () => {
  const { c, b, d } = withThree()
  c.selectAnnotation(b.id)
  expect(c.vertexHandles()).toHaveLength(2)
  c.toggleAnnotation(d.id)
  expect(c.vertexHandles()).toHaveLength(0)
})

test("locked layer: its annotations cannot be selected, edited or deleted; unlock restores that", () => {
  const { c, a, b } = withThree()
  const layer = c.annotations.addLayer("Walls")
  expect(c.moveSelectionToLayer(layer.id)).toBe(false) // nothing selected yet
  c.selectAnnotation(a.id)
  expect(c.moveSelectionToLayer(layer.id)).toBe(true)
  expect(c.annotations.annotations.find((x) => x.id === a.id)!.layer).toBe(layer.id)
  c.annotations.patchLayer(layer.id, { locked: true })
  expect(c.selection).toEqual([]) // locking drops it from the selection
  expect(isLocked(c.annotations.annotations[0]!, c.annotations.layers)).toBe(true)
  c.selectAnnotation(a.id)
  expect(c.selection).toEqual([])
  c.selectAll()
  expect(c.selection).toEqual([b.id, c.annotations.annotations[2]!.id])
  c.setSelection([a.id, b.id])
  expect(c.selection).toEqual([b.id])
  c.annotations.patchLayer(layer.id, { locked: false })
  c.selectAnnotation(a.id)
  expect(c.selection).toEqual([a.id])
})

test("hidden document layer: not drawn, not selectable", () => {
  const { c, a } = withThree()
  const layer = c.annotations.addLayer()
  c.selectAnnotation(a.id)
  c.moveSelectionToLayer(layer.id)
  c.annotations.patchLayer(layer.id, { visible: false })
  const doc = c.annotations.annotations
  expect(isHidden(doc.find((x) => x.id === a.id)!, c.annotations.layers)).toBe(true)
  expect(annotationLayers(doc, c.annotations.layers).some((l) => l.id === "ann.points")).toBe(false)
  expect(c.selection).toEqual([])
  c.selectAnnotation(a.id)
  expect(c.selection).toEqual([])
})

test("active layer: new drawings go there; locked or hidden layers cannot be active", () => {
  const c = new ViewerController()
  const l1 = c.annotations.addLayer("A")
  const l2 = c.annotations.addLayer("B")
  expect(c.setActiveLayer(l1.id)).toBe(true)
  c.tools.setTool("point")
  c.tools.click([1, 2, 3], 0)
  expect(c.annotations.annotations[0]!.layer).toBe(l1.id)
  c.annotations.patchLayer(l1.id, { locked: true })
  expect(c.activeLayer).toBeUndefined() // locking the active layer clears it
  expect(c.setActiveLayer(l1.id)).toBe(false)
  c.annotations.patchLayer(l2.id, { visible: false })
  expect(c.setActiveLayer(l2.id)).toBe(false)
  expect(c.setActiveLayer("missing")).toBe(false)
  c.tools.click([4, 5, 6], 1000)
  expect(c.annotations.annotations[1]!.layer).toBeUndefined()
})

test("assignLayer is one undo step and layer settings survive export / import", () => {
  const { c, a, b } = withThree()
  const layer = c.annotations.addLayer("Routes")
  c.setSelection([a.id, b.id])
  c.moveSelectionToLayer(layer.id)
  c.annotations.patchLayer(layer.id, { locked: true, visible: true })
  const json = c.exportJson()
  const other = new ViewerController()
  expect(other.importJson(json).ok).toBe(true)
  expect(other.annotations.layers).toEqual([{ id: layer.id, name: "Routes", visible: true, locked: true }])
  expect(other.annotations.annotations.filter((x) => x.layer === layer.id)).toHaveLength(2)
  c.annotations.undo()
  expect(c.annotations.annotations.some((x) => x.layer === layer.id)).toBe(false)
})

test("label anchors: point, middle of a path, polygon mean; empty labels and the cap", () => {
  expect(labelAnchor({ type: "point", at: [1, 2, 3] })).toEqual([1, 2, 3])
  expect(labelAnchor({ type: "polyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]] })).toEqual([10, 0, 0])
  expect(labelAnchor({ type: "polyline", points: [[0, 0, 0], [30, 0, 0], [30, 10, 0]] })![0]).toBeCloseTo(20)
  expect(labelAnchor({ type: "polygon", ring: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]] })).toEqual([5, 5, 0])
  expect(labelAnchor({ type: "polyline", points: [] })).toBeUndefined()
  const labels = layerLabels([
    { type: "point", at: [0, 0, 0], label: "  " },
    { type: "point", at: [0, 0, 0] },
    { type: "point", at: [1, 0, 0], label: "A" },
    { type: "segment", points: [[0, 0, 0], [2, 0, 0]], label: "B" }
  ])
  expect(labels).toEqual([{ text: "A", at: [1, 0, 0] }, { text: "B", at: [1, 0, 0] }])
  const many = Array.from({ length: MAX_LABELS_PER_LAYER + 50 }, (_, i) => ({ type: "point" as const, at: [i, 0, 0] as [number, number, number], label: `n${i}` }))
  expect(layerLabels(many)).toHaveLength(MAX_LABELS_PER_LAYER)
  expect(layerLabels([{ type: "point", at: [0, 0, 0], label: "x".repeat(500) }])[0]!.text.length).toBeLessThanOrEqual(120)
})

test("focusSelection frames what is selected: a picked point, several features, an annotation; nothing selected does nothing", () => {
  const { c, a } = withThree()
  const far = { target: [9000, 9000, 0] as Vec3, yaw: 1, pitch: -0.7, distance: 20_000 }
  c.setPose(far)
  expect(c.focusSelection()).toBe(false)
  expect(c.getPose()).toEqual(far)
  c.setOverlay("pts", [{ type: "point", at: [100, 200, 30] }, { type: "point", at: [300, 200, 30] }])
  c.selectFeature("pts:0")
  expect(c.focusSelection()).toBe(true)
  expect(c.getPose().target).toEqual([100, 200, 30])
  expect(c.getPose().distance).toBeLessThan(far.distance)
  expect([c.getPose().yaw, c.getPose().pitch]).toEqual([1, -0.7])
  c.selectFeature("pts:1", true)
  c.focusSelection()
  expect(c.getPose().target).toEqual([200, 200, 30])
  c.clearSelection()
  c.setSelection([a.id])
  expect(c.selectionPoints()).toEqual(a.points)
  c.clearSelection()
  expect(c.selectionPoints()).toEqual([])
})
