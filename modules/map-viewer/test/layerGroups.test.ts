import { expect, test } from "bun:test"
import { LAYER_PRESETS, layerGroupOf } from "../src/panels.ts"

test("layers are grouped by id prefix", () => {
  expect(layerGroupOf("entities.guardian")).toBe("entities")
  expect(layerGroupOf("entities.zipline.blue")).toBe("entities")
  expect(layerGroupOf("metadata.tags.heavy-box")).toBe("tags")
  expect(layerGroupOf("metadata.drafts.creepCamp")).toBe("tags")
  expect(layerGroupOf("ann.lines")).toBe("annotations")
  expect(layerGroupOf("query-result")).toBe("results")
})

test("presets: Map only hides everything, Tagging keeps entities and tags but not unkinded entities or results", () => {
  const show = (id: string, ids: string[]) => ids.filter(LAYER_PRESETS.find((p) => p.id === id)!.show)
  const ids = ["entities.guardian", "entities.other", "metadata.tags.heavy-box", "ann.lines", "query-result"]
  expect(show("map", ids)).toEqual([])
  expect(show("all", ids)).toEqual(ids)
  expect(show("entities", ids)).toEqual(["entities.guardian"])
  expect(show("tagging", ids)).toEqual(["entities.guardian", "metadata.tags.heavy-box"])
})
