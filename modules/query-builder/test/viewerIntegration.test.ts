import { expect, test } from "bun:test"
import { makeResult } from "@deadlock-query/contracts"
import { COLUMN_COLORS, columnLayerId, featureFocus, overlayFeatures, rowLabel, rowProperties } from "../src/app/viewerIntegration.ts"

const result = makeResult(
  [{ name: "g", type: "string" }, { name: "g.pos", type: "point" }, { name: "orb", type: "string" }, { name: "orb.pos", type: "point" }, { name: "d", type: "number" }],
  [["guardian-1", [1, 2, 3], "orb-9", [4, 5, 6], 12.3456], ["guardian-2", [7, 8, 9], "orb-8", null, 3]],
  ["r1", "r2"]
)

test("one layer per geometry column, in distinct colours", () => {
  const { layers } = overlayFeatures(result, "q")
  expect(layers.map((l) => [l.id, l.column, l.features.length])).toEqual([["q", "g.pos", 2], ["q~1", "orb.pos", 1]])
  expect(layers[0]!.style.color).toBe(COLUMN_COLORS[0]!)
  expect(layers[1]!.style.color).toBe(COLUMN_COLORS[1]!)
  expect(columnLayerId("q", 0)).toBe("q")
})

test("feature ids are the viewer's `<layer>:<index>` and map to table rows both ways", () => {
  const { featureToRow, rowToFeatures } = overlayFeatures(result, "q")
  expect(featureToRow.get("q:0")).toBe("r1")
  expect(featureToRow.get("q:1")).toBe("r2")
  expect(featureToRow.get("q~1:0")).toBe("r1")
  expect(rowToFeatures.get("r1")).toEqual(["q:0", "q~1:0"])
  expect(rowToFeatures.get("r2")).toEqual(["q:1"])
})

test("labels name what the geometry belongs to", () => {
  const { layers } = overlayFeatures(result, "q")
  expect(layers[0]!.features.map((f) => f.label)).toEqual(["guardian-1", "guardian-2"])
  // The orb point is labelled by the cell next to it, not by the guardian that shares the row.
  expect(layers[1]!.features.map((f) => f.label)).toEqual(["orb-9"])
  expect(rowLabel(makeResult([{ name: "p", type: "point" }], [[[0, 0, 0]]]), 0, "p")).toBe("#1")
  expect(rowLabel(makeResult([{ name: "p", type: "point" }, { name: "n", type: "number" }], [[[0, 0, 0], 12.3456]]), 0, "p")).toBe("12.35")
})

test("features carry the row's other columns as properties for the inspector", () => {
  expect(rowProperties(result, 0)).toEqual({ g: "guardian-1", orb: "orb-9", d: 12.3456 })
  const { layers } = overlayFeatures(result, "q")
  expect(layers[0]!.features.map((f) => f.properties)).toEqual([{ g: "guardian-1", orb: "orb-9", d: 12.3456 }, { g: "guardian-2", orb: "orb-8", d: 3 }])
  // The orb point of row 1 shares the row's properties with the guardian point of the same row.
  expect(layers[1]!.features[0]!.properties).toBe(layers[0]!.features[0]!.properties)
})

test("featureFocus aims at a point, the centre of a line, and nothing for no feature", () => {
  expect(featureFocus({ type: "point", at: [1, 2, 3] })).toEqual([1, 2, 3])
  expect(featureFocus({ type: "segment", points: [[0, 0, 0], [2, 4, 6]] })).toEqual([1, 2, 3])
  expect(featureFocus(undefined)).toBeUndefined()
})

test("a `color` string column and a `size` number column style the map, one layer per distinct look", () => {
  const r = makeResult(
    [{ name: "p", type: "point" }, { name: "color", type: "string" }, { name: "size", type: "number" }],
    [[[0, 0, 0], "red", 4], [[1, 0, 0], "blue", 4], [[2, 0, 0], "red", 4]],
    ["a", "b", "c"]
  )
  const { layers, featureToRow } = overlayFeatures(r, "q")
  expect(layers.map((l) => [l.id, l.style, l.features.length])).toEqual([
    ["q", { color: "red", size: 4 }, 2],
    ["q@1", { color: "blue", size: 4 }, 1]
  ])
  expect(featureToRow.get("q@1:0")).toBe("b")
  expect(featureToRow.get("q:1")).toBe("c")
})

test("too many distinct looks are ignored rather than creating dozens of layers", () => {
  const rows = Array.from({ length: 20 }, (_, i) => [[i, 0, 0], `#${i.toString(16).padStart(6, "0")}`])
  const r = makeResult([{ name: "p", type: "point" }, { name: "color", type: "string" }], rows, rows.map((_, i) => String(i)))
  expect(overlayFeatures(r, "q").layers.map((l) => l.id)).toEqual(["q"])
})

test("a result with no style columns keeps one default-coloured layer", () => {
  expect(overlayFeatures(result, "q").layers[0]!.style).toEqual({ color: COLUMN_COLORS[0]! })
})
