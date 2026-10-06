import type { DockviewApi } from "dockview"
import type { PanelDefinition } from "@deadlock-query/contracts"
import { placementFor, type PresetPanel } from "./presets.ts"

/** Adds `preset`'s panels to `api` in order (each may be positioned relative to one placed earlier). */
export const addPreset = (api: DockviewApi, preset: ReadonlyArray<PresetPanel>): void => {
  for (const p of preset)
    api.addPanel({
      id: p.id,
      title: p.title,
      component: p.id,
      ...(p.position ? { position: p.position } : {}),
      ...(p.initialWidth ? { initialWidth: p.initialWidth } : {}),
    })
}

/** Replaces the whole layout with `preset`. */
export const applyPreset = (api: DockviewApi, preset: ReadonlyArray<PresetPanel>): void => {
  api.clear()
  addPreset(api, preset)
}

/** Focuses the panel when it is open; otherwise reopens it at its default placement. */
export const showPanel = (api: DockviewApi, def: PanelDefinition): void => {
  const existing = api.getPanel(def.id)
  if (existing) {
    existing.api.setActive()
    return
  }
  const base = { id: def.id, title: def.title, component: def.id }
  const { position, floating } = placementFor(def.defaultPlacement)
  if (floating) api.addPanel({ ...base, floating: true })
  else if (position) api.addPanel({ ...base, position })
  else api.addPanel(base)
}

const allPanels = (api: DockviewApi) => api.groups.flatMap((g) => g.panels)

/** Focuses the panel `delta` places after (or before, when negative) the active one, wrapping around, in tab order group by group. */
export const cyclePanel = (api: DockviewApi, delta: 1 | -1): void => {
  const panels = allPanels(api)
  if (panels.length === 0) return
  const at = api.activePanel ? panels.findIndex((p) => p.id === api.activePanel!.id) : -1
  const next = panels[(at + delta + panels.length) % panels.length]!
  next.api.setActive()
  next.focus()
}

/** Closes the active panel; returns its title, or undefined when none is active. */
export const closeActivePanel = (api: DockviewApi): string | undefined => {
  const p = api.activePanel
  if (!p) return undefined
  const title = p.title ?? p.id
  p.api.close()
  return title
}

/** Maximizes the active panel's group, or restores it when already maximized. */
export const toggleMaximizeActive = (api: DockviewApi): void => {
  const p = api.activePanel
  if (!p) return
  if (p.api.isMaximized()) p.api.exitMaximized()
  else p.api.maximize()
}

/** Moves the active panel into the next group as a tab (wrapping); false when there is only one group. */
export const moveActiveToNextGroup = (api: DockviewApi): boolean => {
  const p = api.activePanel
  if (!p || api.groups.length < 2) return false
  const i = api.groups.findIndex((g) => g.id === p.group.id)
  const target = api.groups[(i + 1) % api.groups.length]!
  p.api.moveTo({ group: target, position: "center" })
  return true
}

/** Splits the active panel out of its tab group to the `direction` of the others; false when it is alone in its group. */
export const splitActive = (api: DockviewApi, direction: "right" | "bottom"): boolean => {
  const p = api.activePanel
  if (!p || p.group.panels.length < 2) return false
  p.api.moveTo({ group: p.group, position: direction })
  return true
}
