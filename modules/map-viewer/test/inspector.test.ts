import { expect, test } from "bun:test"
import { MockMapDataService, type Entity } from "@deadlock-query/contracts"
import { Effect } from "effect"
import { ViewerController, entityItem, flattenFields, loadViewerData } from "../src/index.ts"

const guardian: Entity = {
  id: "g1", class: "info_super_trooper_spawn", kind: "guardian", position: [1, 2, 3], team: 2, lane: 1,
  properties: { subclass_name: "boss_combine_t1_yellow", "0.0,": "junk", nested: { a: [1, 2, 3], b: "x" }, list: ["p", "q"] }
}

const keys = (c: ViewerController, id: string, section: number) => c.inspect(id).sections[section]!.fields.map((f) => f.key)

test("flattenFields: scalars, short number arrays inline, nesting by path, odd keys kept", () => {
  expect(flattenFields({ a: 1, b: "x", c: null, d: [1, 2, 3], e: { f: true }, g: [{ h: 1 }], "0.0,": "j", z: [] })).toEqual([
    { key: "a", value: "1" }, { key: "b", value: "x" }, { key: "c", value: "null" }, { key: "d", value: "[1, 2, 3]" },
    { key: "e.f", value: "true" }, { key: "g[0].h", value: "1" }, { key: "0.0,", value: "j" }, { key: "z", value: "[]" }
  ])
})

test("flattenFields: long arrays are capped and say so", () => {
  const f = flattenFields({ nums: Array.from({ length: 40 }, (_, i) => i), objs: Array.from({ length: 80 }, (_, i) => ({ i })) })
  expect(f[0]!.value).toContain("40 numbers")
  expect(f.at(-1)!.value).toBe("30 more not shown")
})

test("entityItem: every top-level field and every property is listed, known fields first", () => {
  const item = entityItem({ ...guardian, futureField: "new" } as Entity, "entities.guardian:0")
  const [entity, props] = item.sections
  expect(entity!.fields.map((f) => f.key)).toEqual(["id", "class", "kind", "team", "lane", "position", "futureField"])
  expect(entity!.fields.find((f) => f.key === "position")!.value).toBe("[1, 2, 3]")
  expect(props!.fields.map((f) => f.key)).toEqual(["subclass_name", "0.0,", "nested.a", "nested.b", "list[0]", "list[1]"])
  expect(item.title).toBe("g1")
  expect(item.raw).toEqual({ ...guardian, futureField: "new" })
})

test("entityItem: absent team/lane are simply not listed", () => {
  const { team: _t, lane: _l, ...bare } = guardian
  expect(entityItem(bare as Entity, "x:0").sections[0]!.fields.map((f) => f.key)).not.toContain("team")
})

test("inspect: entity, overlay feature with row properties, annotation, unknown id", () => {
  const c = new ViewerController()
  c.setEntities([guardian])
  c.setOverlay("q", [
    { type: "point", at: [5, 6, 7], label: "hit", properties: { entity: "g1", dist: 12.5, "0.0,": "j" } },
    { type: "polyline", points: [[0, 0, 0], [1, 1, 1]] }
  ], { color: "#f00", size: 9 })
  const a = c.annotations.add({ kind: "label", points: [[0, 0, 0]], text: "spawn here" })

  expect(c.inspect("entities.guardian:0").title).toBe("g1")
  const f = c.inspect("q:0")
  expect(f.title).toBe("hit")
  expect(f.sections[0]!.fields).toEqual(expect.arrayContaining([
    { key: "layer", value: "q" }, { key: "index", value: "0" }, { key: "type", value: "point" }, { key: "at", value: "[5, 6, 7]" }
  ]))
  expect(keys(c, "q:0", 1)).toEqual(["entity", "dist", "0.0,"])
  expect(f.sections[2]!.fields).toEqual([{ key: "color", value: "#f00" }, { key: "size", value: "9" }])
  expect(keys(c, "q:1", 0)).toEqual(["layer", "index", "type", "points[0]", "points[1]"])

  const annFeature = c.highlightedIds
  expect(annFeature).toEqual([])
  c.selectAnnotation(a.id)
  const item = c.inspect(c.highlightedIds[0]!)
  expect(item.title).toBe("spawn here")
  expect(item.sections[0]!.fields.map((x) => x.key)).toEqual(expect.arrayContaining(["id", "kind", "text", "points[0]"]))

  expect(c.inspect("entities.guardian:9").subtitle).toBe("no data for this id")
  expect(c.inspect("nope").subtitle).toBe("no data for this id")
})

test("selectFeature: click replaces, additive toggles, clear empties; listeners hear every change", () => {
  const c = new ViewerController()
  c.setOverlay("q", [[0, 0, 0], [1, 1, 1], [2, 2, 2]])
  const seen: string[][] = []
  const off = c.onHighlightChange((ids) => seen.push([...ids]))
  c.selectFeature("q:0")
  c.selectFeature("q:1", true)
  c.selectFeature("q:2", true)
  c.selectFeature("q:1", true)
  expect(c.highlightedIds).toEqual(["q:0", "q:2"])
  c.selectFeature("q:2")
  expect(c.highlightedIds).toEqual(["q:2"])
  c.clearSelection()
  expect(c.highlightedIds).toEqual([])
  off()
  c.selectFeature("q:0")
  expect(seen.at(-1)).toEqual([])
  expect(seen.some((s) => s.join() === "q:0,q:1")).toBe(true)
})

test("selectFeature: annotations and plain features share the highlight; a plain click drops the annotation selection", () => {
  const c = new ViewerController()
  c.setOverlay("q", [[0, 0, 0]])
  const a = c.annotations.add({ kind: "point", points: [[5, 5, 0]] })
  c.selectAnnotation(a.id)
  c.selectFeature("q:0", true)
  expect(c.highlightedIds).toHaveLength(2)
  expect(c.selection).toEqual([a.id])
  c.selectFeature("q:0")
  expect(c.highlightedIds).toEqual(["q:0"])
  expect(c.selection).toEqual([])
  c.selectFeature(c.annotations.annotations.length ? "ann:none" : "x:0")
  expect(c.highlightedIds).toHaveLength(1)
})

test("picked features are dropped when their layer is replaced or removed, or the entities change", () => {
  const c = new ViewerController()
  c.setEntities([guardian])
  c.setOverlay("q", [[0, 0, 0], [1, 1, 1]])
  c.selectFeature("entities.guardian:0")
  c.selectFeature("q:1", true)
  expect(c.highlightedIds).toEqual(["entities.guardian:0", "q:1"])
  c.setOverlay("q", [[9, 9, 9]])
  expect(c.highlightedIds).toEqual(["entities.guardian:0"])
  c.setEntities([])
  expect(c.highlightedIds).toEqual([])
  c.setOverlay("q", [[0, 0, 0]])
  c.selectFeature("q:0")
  c.removeOverlay("q")
  expect(c.highlightedIds).toEqual([])
})

test("a service highlight() shows in the inspector list too", () => {
  const c = new ViewerController()
  c.setOverlay("q", [[0, 0, 0]])
  c.highlight(["q:0"])
  expect(c.highlightedIds).toEqual(["q:0"])
  expect(c.inspect("q:0").title).toBe("q #0")
})

test("fixture entities all inspect with their fields", async () => {
  const data = await Effect.runPromise(loadViewerData.pipe(Effect.provide(MockMapDataService)))
  const c = new ViewerController()
  c.setEntities(data.entities)
  c.selectFeature("entities.guardian:0")
  const item = c.inspect(c.highlightedIds[0]!)
  expect(item.title).toBe(data.entities.find((e) => e.kind === "guardian")!.id)
  expect(item.sections[0]!.fields.length).toBeGreaterThan(2)
})
