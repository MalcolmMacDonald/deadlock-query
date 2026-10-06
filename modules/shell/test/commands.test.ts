import { expect, test } from "bun:test"
import { Layer } from "effect"
import type { ModuleDefinition } from "@deadlock-query/contracts"
import { buildCommands, filterCommands, type CommandActions } from "../src/commands.ts"
import { PRESETS } from "../src/presets.ts"

const mod = (id: string, panels: ReadonlyArray<[string, string]>, commands: ModuleDefinition["commands"] = []): ModuleDefinition => ({
  id,
  layer: Layer.empty,
  panels: panels.map(([pid, title]) => ({ id: pid, title, defaultPlacement: "center" as const, component: () => null })),
  commands,
})

const calls: string[] = []
const actions: CommandActions = {
  showPanel: (id) => void calls.push(`show:${id}`),
  applyPreset: (id) => void calls.push(`preset:${id}`),
  resetLayout: () => void calls.push("reset"),
  shareLayout: () => void calls.push("share"),
}
const commands = buildCommands(
  [mod("map-viewer", [["viewer.main", "Map"], ["viewer.layers", "Layers"]], [{ id: "go", title: "Go home", run: () => void calls.push("module") }])],
  PRESETS.slice(0, 2),
  actions,
)

test("one command per panel and preset, plus reset, share and module commands", () => {
  expect(commands.map((c) => c.id)).toEqual([
    "panel:viewer.main", "panel:viewer.layers", "preset:query", "preset:explore", "layout:reset", "layout:share", "module:map-viewer:go",
  ])
})

test("commands call the matching action", async () => {
  calls.length = 0
  for (const c of commands) await c.run()
  expect(calls).toEqual(["show:viewer.main", "show:viewer.layers", "preset:query", "preset:explore", "reset", "share", "module"])
})

test("empty query returns everything in order", () => {
  expect(filterCommands(commands, "  ")).toEqual(commands)
})

test("filter is case-insensitive, token-based, and ranks title prefixes first", () => {
  expect(filterCommands(commands, "LAYERS").map((c) => c.id)).toEqual(["panel:viewer.layers"])
  expect(filterCommands(commands, "layout reset")[0]!.id).toBe("layout:reset")
  expect(filterCommands(commands, "reset")[0]!.id).toBe("layout:reset")
  expect(filterCommands(commands, "go")[0]!.id).toBe("module:map-viewer:go")
  expect(filterCommands(commands, "zzz")).toEqual([])
})

test("group name is searchable but ranks below title matches", () => {
  const ids = filterCommands(commands, "panels").map((c) => c.id)
  expect(ids).toEqual(["panel:viewer.main", "panel:viewer.layers"])
})
