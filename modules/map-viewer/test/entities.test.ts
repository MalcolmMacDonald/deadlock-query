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
  expect(layers.map((l) => l.id.replace("entities.", "")).sort()).toEqual([...kinds, "other"].sort())
  for (const l of layers) {
    expect(isEntityLayerId(l.id)).toBe(true)
    expect(l.features).toHaveLength(l.entities.length)
    expect(l.hiddenByDefault).toBe(l.id === OTHER_ENTITIES_LAYER)
    expect(l.label).toContain(`(${l.entities.length})`)
  }
  const guardians = layers.find((l) => l.id === "entities.guardian")!
  expect(guardians.entities).toHaveLength(6)
  expect(guardians.features[0]).toMatchObject({ type: "point", label: expect.stringContaining("Guardian (team") })
  expect(layers.find((l) => l.id === "entities.zipline")!.features[0]).not.toHaveProperty("label") // too many to name
})

test("entities without a kind go to a hidden 'other' layer, after the kinds", () => {
  const e = (id: string, kind?: Entity["kind"]): Entity => ({ id, class: "prop_dynamic", ...(kind ? { kind } : {}), position: [1, 2, 3], properties: {} })
  const layers = entityLayers([e("a"), e("b", "shop"), e("c")])
  expect(layers.map((l) => l.id)).toEqual(["entities.shop", OTHER_ENTITIES_LAYER])
  expect(layers[1]!.hiddenByDefault).toBe(true)
  expect(layers[1]!.entities.map((x) => x.id)).toEqual(["a", "c"])
  expect(describeEntity(e("a"))).toBe("prop_dynamic")
  expect(describeEntity({ ...e("g", "guardian"), team: 2, lane: 1 })).toBe("Guardian (team 2, lane 1)")
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
