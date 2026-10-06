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
