import { expect, test } from "bun:test"
import { Effect } from "effect"
import { MockMapDataService, EntityKind, type Entity } from "@deadlock-query/contracts"
import {
  OTHER_ENTITIES_LAYER, ViewerController, describeEntity, entityLayers, isEntityLayerId, loadViewerData
} from "../src/index.ts"

const fixtureEntities = () => Effect.runPromise(loadViewerData.pipe(Effect.provide(MockMapDataService))).then((d) => d.entities)

test("the fixture yields a layer for every entity kind, labelled where it helps", async () => {
  const layers = entityLayers(await fixtureEntities())
  const kinds = EntityKind.literals as ReadonlyArray<string>
  // One layer per kind, plus the fixture's one entity without a kind in the hidden 'other' layer.
  // The fixture's zipline nodes belong to no path, so they stay points in `entities.zipline`.
  expect(layers.map((l) => l.id.replace("entities.", "")).sort()).toEqual([...kinds, "other"].sort())
  for (const l of layers) {
    expect(isEntityLayerId(l.id)).toBe(true)
    expect(l.features).toHaveLength(l.entities.length)
    expect(l.hiddenByDefault).toBe(l.id === OTHER_ENTITIES_LAYER)
    expect(l.label).toContain(`(${l.entities.length})`)
  }
  const guardians = layers.find((l) => l.id === "entities.guardian")!
  expect(guardians.entities).toHaveLength(6)
  expect(guardians.features[0]).toMatchObject({ type: "point", label: "Guardian (team 2, Yellow lane)" })
  expect(layers.find((l) => l.id === "entities.zipline")!.features[0]).not.toHaveProperty("label") // too many to name
})

test("entities without a kind go to a hidden 'other' layer, after the kinds", () => {
  const e = (id: string, kind?: Entity["kind"]): Entity => ({ id, class: "prop_dynamic", ...(kind ? { kind } : {}), position: [1, 2, 3], properties: {} })
  const layers = entityLayers([e("a"), e("b", "shop"), e("c")])
  expect(layers.map((l) => l.id)).toEqual(["entities.shop", OTHER_ENTITIES_LAYER])
  expect(layers[1]!.hiddenByDefault).toBe(true)
  expect(layers[1]!.entities.map((x) => x.id)).toEqual(["a", "c"])
  expect(describeEntity(e("a"))).toBe("prop_dynamic")
  expect(describeEntity({ ...e("g", "guardian"), team: 2, lane: 1 })).toBe("Guardian (team 2, Yellow lane)")
  expect(describeEntity({ ...e("g", "walker"), lane: 3 })).toBe("Walker (Green lane)")
  expect(describeEntity({ ...e("g", "walker"), lane: 7 })).toBe("Walker (lane 7)")
})

test("controller: entities become toggleable layers, other starts hidden, picks map back to entities, a new map replaces them", async () => {
  const c = new ViewerController()
  const base = await fixtureEntities()
  const prop: Entity = { id: "prop-1", class: "prop_static", position: [5, 5, 5], properties: {} }
  c.setEntities([...base, prop])
  expect(c.layers.get("entities.guardian")?.visible).toBe(true)
  expect(c.layers.get(OTHER_ENTITIES_LAYER)?.visible).toBe(false)
  expect(c.layers.get("entities.guardian")?.label).toBe("Guardians (6)")
  expect(c.entityForFeature("entities.guardian:0")?.kind).toBe("guardian")
  expect(c.entityForFeature(`${OTHER_ENTITIES_LAYER}:0`)?.id).toBe("prop-1")
  expect(c.entityForFeature("ann.points:0")).toBeUndefined()
  c.layers.patch(OTHER_ENTITIES_LAYER, { visible: true })
  c.setEntities([...base, prop]) // same map again: the user's choice stays
  expect(c.layers.get(OTHER_ENTITIES_LAYER)?.visible).toBe(true)
  c.setEntities(base.filter((x) => x.kind === "guardian"))
  expect(c.layers.list().map((l) => l.id)).toEqual(["entities.guardian"])
})

const node = (id: string, path: string, index: number, at: [number, number, number], extra: Partial<Entity> = {}): Entity => ({
  id, class: "citadel_zipline_path_node", kind: "zipline", position: at, ...extra,
  properties: { path_uniqueid: path, path_index: index, ...(index === 0 ? { targetname: `${path}_start` } : {}) }
})
const pathEntity = (id: string, props: Record<string, unknown>): Entity => ({ id, class: "citadel_zipline_path", position: [0, 0, 0], properties: { hammeruniqueid: id, pathnodes: [1, 2, 3], ...props } })

test("ziplines are lines through their ordered nodes, one layer per lane colour", () => {
  const entities: Entity[] = [
    // listed out of order on purpose
    node("b2", "P2", 2, [30, 0, 0]), node("b0", "P2", 0, [10, 0, 0]), node("b1", "P2", 1, [20, 5, 0]),
    node("y1", "P1", 1, [5, 100, 0], { lane: 1 }), node("y0", "P1", 0, [0, 100, 0], { lane: 1 }),
    node("g0", "P3", 0, [0, 200, 0]), node("g1", "P3", 1, [9, 200, 0]),
    node("u0", "P4", 0, [0, 300, 0]), node("u1", "P4", 1, [9, 300, 0]),
    node("lone", "P5", 0, [1, 1, 1]),
    pathEntity("P2", { color_tint: [0, 25, 255], use_baselane_color: 0 }),
    pathEntity("P3", { color_tint: [139, 0, 139], use_baselane_color: 0 }),
    pathEntity("P4", { color_tint: [255, 255, 255] })
  ]
  const layers = entityLayers(entities)
  const ids = layers.map((l) => l.id)
  expect(ids).toEqual(["entities.zipline", "entities.zipline.yellow", "entities.zipline.blue", "entities.zipline.green", "entities.other"])
  const get = (id: string) => layers.find((l) => l.id === id)!

  // Yellow: lane set by the extractor. Blue/Green: from the path's tint (the game's purple is Green). White: no lane.
  expect(get("entities.zipline.yellow").features).toEqual([{ type: "polyline", points: [[0, 100, 0], [5, 100, 0]], label: "Zipline (Yellow lane)" }])
  expect(get("entities.zipline.blue").features[0]).toMatchObject({ type: "polyline", points: [[10, 0, 0], [20, 5, 0], [30, 0, 0]] })
  expect(get("entities.zipline.green").features[0]).toMatchObject({ type: "polyline", label: "Zipline (Green lane)" })
  expect(get("entities.zipline.blue").style.color).not.toBe(get("entities.zipline.green").style.color)
  expect(get("entities.zipline.yellow").label).toBe("Yellow lane ziplines (1)")
  expect(get("entities.zipline.yellow").hiddenByDefault).toBe(false)

  // Untinted path (a line, lane unknown) and the lone node share `entities.zipline`; no node is drawn as a point inside a path.
  expect(get("entities.zipline").features.map((f) => f.type)).toEqual(["point", "polyline"])
  expect(get("entities.zipline").label).toBe("Ziplines (2)")
  // Only the path entities are left over in `other` (kind-less, hidden).
  expect(get("entities.other").entities.map((e) => e.id).sort()).toEqual(["P2", "P3", "P4"])

  // Selecting a line reaches the path: its fields and every node.
  const blue = get("entities.zipline.blue").entities[0]!
  expect(blue).toMatchObject({ id: "P2", class: "citadel_zipline_path", kind: "zipline", lane: 2, position: [10, 0, 0] })
  expect(blue.properties).toMatchObject({ nodeCount: 3, color_tint: [0, 25, 255] })
  expect(blue.properties).not.toHaveProperty("pathnodes")
  expect((blue.properties["nodes"] as Array<{ id: string }>).map((n) => n.id)).toEqual(["b0", "b1", "b2"])
})

test("controller: a zipline line can be picked and inspected, and its lane layer toggled", () => {
  const c = new ViewerController()
  c.setEntities([node("n0", "P", 0, [0, 0, 0], { lane: 2 }), node("n1", "P", 1, [10, 0, 0], { lane: 2 }), pathEntity("P", { lane_number: 4 })])
  expect(c.layers.get("entities.zipline.blue")?.visible).toBe(true)
  expect(c.layers.get("entities.zipline")).toBeUndefined()
  const item = c.inspect("entities.zipline.blue:0")
  expect(item.title).toBe("P")
  const fields = item.sections.flatMap((s) => s.fields).map((f) => f.key)
  expect(fields).toContain("lane_number")
  expect(fields).toContain("nodes[0].id")
  expect(item.sections[0]!.fields.find((f) => f.key === "lane")!.value).toContain("Blue")
  c.layers.patch("entities.zipline.blue", { visible: false })
  c.setEntities([node("n0", "P", 0, [0, 0, 0], { lane: 2 }), node("n1", "P", 1, [10, 0, 0], { lane: 2 })])
  expect(c.layers.get("entities.zipline.blue")?.visible).toBe(false) // the user's choice stays
})
