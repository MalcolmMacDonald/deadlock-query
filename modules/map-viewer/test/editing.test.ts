import { expect, test } from "bun:test"
import type { Annotation, Vec3 } from "@deadlock-query/contracts"
import {
  AnnotationStore, ViewerController, annotationColor, annotationIdForFeature, annotationLayers, featureIdForAnnotation,
  insertVertex, moveVertex, nearestEdge, nearestVertex, normalizeColor, removeVertex
} from "../src/index.ts"

const project = (p: Vec3): readonly [number, number] => [p[0], p[1]]
const line: Annotation = { id: "l", kind: "polyline", points: [[0, 0, 0], [100, 0, 0], [100, 100, 0]] }
const tri: Annotation = { id: "t", kind: "polygon", points: [[0, 0, 0], [100, 0, 0], [0, 100, 0]] }

test("move / insert / remove vertex", () => {
  expect(moveVertex(line, 1, [5, 5, 5]).points[1]).toEqual([5, 5, 5])
  expect(moveVertex(line, 9, [5, 5, 5])).toBe(line)
  expect(insertVertex(line, 0, [50, 0, 0])!.points).toEqual([[0, 0, 0], [50, 0, 0], [100, 0, 0], [100, 100, 0]])
  expect(insertVertex(tri, 2, [0, 50, 0])!.points).toHaveLength(4) // closing edge
  expect(insertVertex({ id: "m", kind: "measure", points: [[0, 0, 0], [1, 1, 1]] }, 0, [0, 0, 0])).toBeUndefined()
  expect(removeVertex(line, 1)!.points).toEqual([[0, 0, 0], [100, 100, 0]])
  expect(removeVertex(removeVertex(line, 1)!, 0)).toBeUndefined() // would drop below two points
  expect(removeVertex(tri, 0)).toBeUndefined()
  expect(removeVertex({ id: "p", kind: "point", points: [[0, 0, 0]] }, 0)).toBeUndefined()
  expect(moveVertex({ ...line, color: "red" }, 0, [1, 1, 1]).color).toBe("red")
})

test("nearestVertex / nearestEdge work in screen pixels", () => {
  expect(nearestVertex(line.points, project, 103, 4)).toBe(1)
  expect(nearestVertex(line.points, project, 50, 50)).toBeUndefined()
  const e = nearestEdge(line, project, 40, 3)!
  expect(e.after).toBe(0)
  expect(e.point[0]).toBeCloseTo(40)
  expect(e.point[1]).toBeCloseTo(0)
  expect(nearestEdge(line, project, 40, 30)).toBeUndefined()
  expect(nearestEdge(tri, project, 50, 50)!.after).toBe(1) // hypotenuse
  expect(nearestEdge(tri, project, 0, 50)!.after).toBe(2) // closing edge
  expect(nearestEdge({ id: "p", kind: "point", points: [[0, 0, 0]] }, project, 0, 0)).toBeUndefined()
})

test("store: a live edit is one undo step; cancel restores; other mutations commit first", () => {
  const s = new AnnotationStore()
  const a = s.add({ kind: "polyline", points: [[0, 0, 0], [10, 0, 0]] })
  s.edit({ ...a, points: [[1, 0, 0], [10, 0, 0]] })
  s.edit({ ...a, points: [[2, 0, 0], [10, 0, 0]] })
  s.edit({ ...a, points: [[3, 0, 0], [10, 0, 0]] })
  expect(s.editing).toBe(true)
  expect(s.annotations[0]!.points[0]).toEqual([3, 0, 0])
  s.commitEdit()
  expect(s.editing).toBe(false)
  s.undo()
  expect(s.annotations[0]!.points[0]).toEqual([0, 0, 0]) // the drag undoes in one step
  s.redo()
  expect(s.annotations[0]!.points[0]).toEqual([3, 0, 0])

  s.edit({ ...a, points: [[9, 0, 0], [10, 0, 0]] })
  s.cancelEdit()
  expect(s.annotations[0]!.points[0]).toEqual([3, 0, 0])
  expect(s.canRedo).toBe(false)

  s.edit({ ...a, points: [[7, 0, 0], [10, 0, 0]] })
  s.undo() // commits the pending edit, then undoes it
  expect(s.annotations[0]!.points[0]).toEqual([3, 0, 0])
  expect(s.edit({ ...a, id: "ghost" })).toBe(false)
  // An edit that changes nothing leaves no history step.
  const before = s.canUndo
  s.commitEdit()
  expect(s.canUndo).toBe(before)
})

test("controller: drag, insert and delete vertices on the selected annotation", () => {
  const c = new ViewerController()
  c.tools.setTool("polyline")
  c.tools.click([0, 0, 0], 1000)
  c.tools.click([100, 0, 0], 2000)
  c.tools.click([100, 100, 0], 3000)
  c.tools.finish()
  c.tools.setTool("select")
  c.selectAnnotation("a1")
  expect(c.vertexHandles()).toHaveLength(3)
  c.tools.setTool("polyline")
  expect(c.vertexHandles()).toHaveLength(0) // handles only while selecting
  c.tools.setTool("select")

  c.selectVertex(1)
  c.moveVertex(1, [120, 10, 0])
  c.moveVertex(1, [130, 20, 0])
  c.commitVertexEdit()
  expect(c.annotations.annotations[0]!.points[1]).toEqual([130, 20, 0])
  c.annotations.undo()
  expect(c.annotations.annotations[0]!.points[1]).toEqual([100, 0, 0])
  c.annotations.redo()

  expect(c.insertVertexAfter(0, [60, 5, 0])).toBe(true)
  expect(c.annotations.annotations[0]!.points).toHaveLength(4)
  expect(c.selectedVertex).toBe(1)

  expect(c.deleteVertexOrSelected()).toBe(true) // removes vertex 1
  expect(c.annotations.annotations[0]!.points).toHaveLength(3)
  expect(c.selectedVertex).toBeUndefined()
  c.selectVertex(0)
  c.deleteVertexOrSelected()
  c.selectVertex(0)
  c.deleteVertexOrSelected() // two points left: deletes the whole annotation
  expect(c.annotations.annotations).toHaveLength(0)
  expect(c.selectedAnnotation).toBeUndefined()
})

test("controller pushes handles to the surface", () => {
  const c = new ViewerController()
  const log: string[] = []
  c.attach({
    setOverlay: () => {}, removeOverlay: () => {}, highlight: () => {}, setAppearance: () => {}, setDraft: () => {},
    setHandles: (pts, active) => { log.push(`${pts.length}:${active}`) },
    getPose: () => ({ target: [0, 0, 0], yaw: 0, pitch: 0, distance: 1 }), setPose: () => {},
    capture: async () => new Uint8Array(), loadBundle: async () => {}
  })
  c.annotations.add({ kind: "polygon", points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] })
  c.selectAnnotation("a1")
  c.selectVertex(2)
  expect(log.at(-1)).toBe("3:2")
  c.selectAnnotation(undefined)
  expect(log.at(-1)).toBe("0:undefined")
})

test("normalizeColor accepts hex, names, rgb(); rejects junk", () => {
  expect(normalizeColor("#F80")).toBe("#ff8800")
  expect(normalizeColor(" #FF8800 ")).toBe("#ff8800")
  expect(normalizeColor("red")).toBe("#ff0000")
  expect(normalizeColor("rgb(0, 255, 0)")).toBe("#00ff00")
  expect(normalizeColor("not a colour")).toBeUndefined()
  expect(normalizeColor("#12")).toBeUndefined()
  expect(normalizeColor(undefined)).toBeUndefined()
})

test("annotation colour: own colour, then layer colour, else the kind default; one overlay layer per colour", () => {
  const doc: Annotation[] = [
    { id: "a", kind: "point", points: [[0, 0, 0]] },
    { id: "b", kind: "point", points: [[1, 0, 0]], color: "#ff0000" },
    { id: "c", kind: "point", points: [[2, 0, 0]], color: "#FF0000" },
    { id: "d", kind: "point", points: [[3, 0, 0]], layer: "L" },
    { id: "e", kind: "point", points: [[4, 0, 0]], color: "bogus" },
    { id: "f", kind: "polyline", points: [[0, 0, 0], [1, 1, 1]], color: "lime" }
  ]
  const layers = [{ id: "L", name: "Layer", color: "#0000ff" }]
  expect(annotationColor(doc[3]!, layers)).toBe("#0000ff")
  expect(annotationColor(doc[1]!, layers)).toBe("#ff0000")
  expect(annotationColor(doc[4]!, layers)).toBeUndefined()
  const out = annotationLayers(doc, layers)
  expect(out.map((l) => [l.id, l.style.color, l.annotationIds.join("")])).toEqual([
    ["ann.points", "#ff5ec4", "ae"],
    ["ann.points.ff0000", "#ff0000", "bc"],
    ["ann.points.0000ff", "#0000ff", "d"],
    ["ann.lines.00ff00", "#00ff00", "f"]
  ])
  expect(out[1]!.style.size).toBe(9) // kind style other than colour is kept
  expect(featureIdForAnnotation(doc, "c", layers)).toBe("ann.points.ff0000:1")
  expect(annotationIdForFeature(doc, "ann.points.ff0000:1", layers)).toBe("c")
  expect(annotationIdForFeature(doc, "ann.points.0000ff:0", layers)).toBe("d")
  expect(annotationIdForFeature(doc, "ann.points.0000ff:0")).toBeUndefined() // without the document layers "d" has no colour
})

test("controller draws coloured annotations as their own overlay layers and drops them when empty", () => {
  const c = new ViewerController()
  c.annotations.add({ kind: "point", points: [[0, 0, 0]], color: "#00ff00" })
  c.annotations.add({ kind: "point", points: [[1, 0, 0]] })
  expect(c.layers.list().map((l) => [l.id, l.baseColor]).sort()).toEqual([["ann.points", "#ff5ec4"], ["ann.points.00ff00", "#00ff00"]])
  c.selectFeature("ann.points.00ff00:0")
  expect(c.selectedAnnotation).toBe("a1")
  c.deleteSelected()
  expect(c.layers.list().map((l) => l.id)).toEqual(["ann.points"])
})
