import { expect, test } from "bun:test"
import type { OverlayFeature, Vec3 } from "@deadlock-query/contracts"
import { ViewerController, pickInRect } from "../src/index.ts"

const pt = (x: number, y: number): OverlayFeature => ({ type: "point", at: [x, y, 0] as Vec3 })
// Screen = world x/y, so a rectangle in pixels is a rectangle in the data.
const project = (p: Vec3) => [p[0], p[1]] as const
const layer = (features: OverlayFeature[]) => ({ features, style: {} })

test("pickInRect returns the point features inside the box, in any corner order, and skips lines and excluded layers", () => {
  const layers = [
    ["entities.guardian", layer([pt(10, 10), pt(50, 50), pt(200, 200), { type: "polyline", points: [[20, 20, 0], [30, 30, 0]] }])],
    ["ann.points", layer([pt(15, 15)])]
  ] as const
  expect(pickInRect(layers, project, [0, 0], [60, 60])).toEqual(["entities.guardian:0", "entities.guardian:1", "ann.points:0"])
  expect(pickInRect(layers, project, [60, 60], [0, 0], (id) => !id.startsWith("ann."))).toEqual(["entities.guardian:0", "entities.guardian:1"])
  expect(pickInRect(layers, project, [300, 300], [400, 400])).toEqual([])
})

test("selectFeatures replaces the picks, or adds without duplicates", () => {
  const c = new ViewerController()
  c.selectFeatures(["entities.a:0", "entities.a:1"])
  expect(c.highlightedIds).toEqual(["entities.a:0", "entities.a:1"])
  c.selectFeatures(["entities.a:1", "entities.a:2"], true)
  expect(c.highlightedIds).toEqual(["entities.a:0", "entities.a:1", "entities.a:2"])
  c.selectFeatures(["entities.b:0"])
  expect(c.highlightedIds).toEqual(["entities.b:0"])
})
