import { expect, test } from "bun:test"
import type { PanelDefinition } from "@deadlock-query/contracts"
import { modules } from "../src/modules.ts"
import { availablePresets, DEFAULT_PRESET_ID, explorePreset, placementFor, PRESETS, queryPreset, reviewPreset } from "../src/presets.ts"

const def = (id: string, defaultPlacement: PanelDefinition["defaultPlacement"] = "center"): PanelDefinition => ({ id, title: id, defaultPlacement, component: () => null })
const all = [def("viewer.main"), def("viewer.tools", "left"), def("viewer.layers", "left"), def("query.editor", "right"), def("dummy")]

test("Explore: map with tools and layers, no editor and no extras", () => {
  expect(explorePreset(all).map((p) => p.id)).toEqual(["viewer.main", "viewer.tools", "viewer.layers"])
})

test("Inspector: under the editor in Query, its own column right of the map otherwise", () => {
  const withInspector = [...all, def("viewer.inspector", "right")]
  const query = queryPreset(withInspector)
  expect(query.map((p) => p.id)).toEqual(["viewer.main", "viewer.tools", "viewer.layers", "query.editor", "viewer.inspector", "dummy"])
  expect(query[4]!.position).toEqual({ referencePanel: "query.editor", direction: "below" })
  expect(query[4]!.initialHeight).toBeGreaterThan(0) // the editor and its results keep most of the column
  const explore = explorePreset(withInspector)
  expect(explore.map((p) => p.id)).toEqual(["viewer.main", "viewer.tools", "viewer.layers", "viewer.inspector"])
  expect(explore[3]!.position).toEqual({ referencePanel: "viewer.main", direction: "right" })
  expect(explore[3]!.initialWidth).toBeGreaterThan(0)
})

test("Review: adds metadata.* panels docked right of the map, drops the editor", () => {
  const preset = reviewPreset([...all, def("metadata.review", "right")])
  expect(preset.map((p) => p.id)).toEqual(["viewer.main", "viewer.tools", "viewer.layers", "metadata.review"])
  expect(preset[3]!.position).toEqual({ referencePanel: "viewer.main", direction: "right" })
})

test("Query keeps the editor and splits unknown panels below the map", () => {
  const preset = queryPreset(all)
  expect(preset.map((p) => p.id)).toEqual(["viewer.main", "viewer.tools", "viewer.layers", "query.editor", "dummy"])
})

test("every preset places each panel once, after the panel it references", () => {
  const panels = [...all, def("metadata.review", "right")]
  for (const preset of PRESETS) {
    const built = preset.build(panels)
    const placed = new Set<string>()
    for (const p of built) {
      expect(placed.has(p.id)).toBe(false)
      if (p.position) expect(placed.has(p.position.referencePanel)).toBe(true)
      placed.add(p.id)
    }
  }
})

test("availability: Review needs a metadata panel, all need the map", () => {
  expect(availablePresets(all).map((p) => p.id)).toEqual(["query", "explore"])
  expect(availablePresets([...all, def("metadata.review")]).map((p) => p.id)).toEqual(["query", "explore", "review"])
  expect(availablePresets([def("dummy")])).toEqual([])
  expect(PRESETS.some((p) => p.id === DEFAULT_PRESET_ID)).toBe(true)
})

test("presets built from the real module list only reference registered panels", () => {
  const panels = modules.flatMap((m) => m.panels)
  const ids = new Set(panels.map((p) => p.id))
  for (const p of availablePresets(panels)) for (const x of p.build(panels)) expect(ids.has(x.id)).toBe(true)
})

test("reopened panels go to their default placement", () => {
  expect(placementFor("left")).toEqual({ position: { direction: "left" } })
  expect(placementFor("top")).toEqual({ position: { direction: "above" } })
  expect(placementFor("bottom")).toEqual({ position: { direction: "below" } })
  expect(placementFor("float")).toEqual({ floating: true })
  expect(placementFor("center")).toEqual({})
})

test("Query leaves metadata.* panels for the Review preset instead of splitting them below the map", () => {
  expect(queryPreset([...all, def("metadata.editor", "right")]).map((p) => p.id)).not.toContain("metadata.editor")
})
