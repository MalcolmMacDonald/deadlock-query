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
  focusNext: () => void calls.push("next"),
  focusPrevious: () => void calls.push("previous"),
  closeActive: () => void calls.push("close"),
  toggleMaximize: () => void calls.push("maximize"),
  resize: (d) => void calls.push(`resize:${d}`),
  moveToNextGroup: () => void calls.push("move"),
  split: (d) => void calls.push(`split:${d}`),
  toggleTheme: () => void calls.push("theme"),
}
const commands = buildCommands(
  [mod("map-viewer", [["viewer.main", "Map"], ["viewer.layers", "Layers"]], [{ id: "go", title: "Go home", run: () => void calls.push("module") }])],
  PRESETS.slice(0, 2),
  actions,
)

test("one command per panel and preset, plus reset, share and module commands", () => {
  expect(commands.map((c) => c.id)).toEqual([
    "panel:next", "panel:previous", "panel:close-active", "panel:maximize-active", "panel:wider", "panel:narrower", "panel:taller", "panel:shorter", "panel:move-next-group", "panel:split-right", "panel:split-below",
    "panel:viewer.main", "panel:viewer.layers", "preset:query", "preset:explore", "layout:reset", "layout:share", "view:toggle-theme", "module:map-viewer:go",
  ])
})

test("commands call the matching action", async () => {
  calls.length = 0
  for (const c of commands) await c.run()
  expect(calls).toEqual([
    "next", "previous", "close", "maximize", "resize:wider", "resize:narrower", "resize:taller", "resize:shorter", "move", "split:right", "split:bottom",
    "show:viewer.main", "show:viewer.layers", "preset:query", "preset:explore", "reset", "share", "theme", "module",
  ])
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
  expect(ids.slice(-2)).toEqual(["panel:viewer.main", "panel:viewer.layers"])
  expect(ids.every((id) => id.startsWith("panel:"))).toBe(true)
})

test("commands with a registered shortcut carry its label", () => {
  const byId = new Map(commands.map((c) => [c.id, c]))
  expect(byId.get("panel:next")!.shortcut).toBe("Alt+.")
  expect(byId.get("panel:close-active")!.shortcut).toBe("Alt+Shift+W")
  expect(byId.get("layout:reset")!.shortcut).toBeUndefined()
})
