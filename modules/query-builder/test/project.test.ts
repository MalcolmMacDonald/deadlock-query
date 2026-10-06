import { expect, test } from "bun:test"
import { projectResult } from "../src/engine/project.ts"

const stats = { compileMs: 1, runMs: 2 }

test("array of arrays → positional columns with inferred types", () => {
  const r = projectResult([["a", [1, 2, 3], 4.5], ["b", [4, 5, 6], 7]], stats)
  expect(r.columns).toEqual([{ name: "c1", type: "string" }, { name: "c2", type: "point" }, { name: "c3", type: "number" }])
  expect(r.geometryColumns).toEqual(["c2"])
  expect(r.rows).toHaveLength(2)
  expect(r.stats).toEqual({ rowCount: 2, compileMs: 1, runMs: 2 })
})

test("array of objects → one column per key; entities become entityRef ids", () => {
  const e = { id: "g1", position: [0, 0, 0] }
  const r = projectResult([{ guardian: e, d: 3 }, { guardian: { ...e, id: "g2" }, d: 4 }], stats)
  // Each entity column gets a `<name>.position` point column so the entity is drawn on the map.
  expect(r.columns).toEqual([{ name: "guardian", type: "entityRef" }, { name: "guardian.position", type: "point" }, { name: "d", type: "number" }])
  expect(r.rows).toEqual([["g1", [0, 0, 0], 3], ["g2", [0, 0, 0], 4]])
  expect(r.geometryColumns).toEqual(["guardian.position"])
})

test("a list of entities plots each at its position", () => {
  const r = projectResult([{ id: "a", position: [1, 2, 3] }, { id: "b", position: [4, 5, 6] }], stats)
  expect(r.columns).toEqual([{ name: "value", type: "entityRef" }, { name: "value.position", type: "point" }])
  expect(r.rows).toEqual([["a", [1, 2, 3]], ["b", [4, 5, 6]]])
  expect(r.rowIds).toEqual(["a", "b"])
})

test("scalars, single values, null and empty results", () => {
  expect(projectResult([1, 2, 3], stats).columns).toEqual([{ name: "value", type: "number" }])
  expect(projectResult(42, stats).rows).toEqual([[42]])
  expect(projectResult(null, stats).rows).toEqual([])
  expect(projectResult([], stats).stats.rowCount).toBe(0)
})

test("a lone 3-number array is a point row, a polyline column is detected", () => {
  expect(projectResult([[1, 2, 3]], stats).columns).toEqual([{ name: "value", type: "point" }])
  const r = projectResult([["a", [[0, 0, 0], [1, 1, 1], [2, 2, 2]]]], stats)
  expect(r.columns[1]).toEqual({ name: "c2", type: "polyline" })
})

test("mixed cells degrade to string and objects are stringified", () => {
  const r = projectResult([[1], ["x"], [{ k: 1 }]], stats)
  expect(r.columns[0]!.type).toBe("string")
  expect(r.rows[2]).toEqual(['{"k":1}'])
})
