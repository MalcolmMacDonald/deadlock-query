import type { ModuleDefinition } from "@deadlock-query/contracts"
import type { Preset } from "./presets.ts"
import { shortcutFor } from "./shortcuts.ts"

export interface PaletteCommand {
  readonly id: string
  readonly title: string
  readonly group: "Panels" | "Layout" | "View" | "Module"
  /** Keyboard shortcut label from the registry, when the command has one. */
  readonly shortcut?: string
  readonly run: () => void | Promise<void>
}

export interface CommandActions {
  readonly showPanel: (panelId: string) => void
  readonly applyPreset: (presetId: Preset["id"]) => void
  readonly resetLayout: () => void
  readonly shareLayout: () => void
  readonly focusNext: () => void
  readonly focusPrevious: () => void
  readonly closeActive: () => void
  readonly toggleMaximize: () => void
  readonly resize: (direction: "wider" | "narrower" | "taller" | "shorter") => void
  readonly moveToNextGroup: () => void
  readonly split: (direction: "right" | "bottom") => void
  readonly toggleTheme: () => void
}

const withShortcut = (c: PaletteCommand): PaletteCommand => {
  const shortcut = shortcutFor(c.id)
  return shortcut ? { ...c, shortcut } : c
}

/** Every palette entry: reopen/focus each registered panel, switch presets, reset, share, plus modules' own commands. */
export const buildCommands = (
  modules: ReadonlyArray<ModuleDefinition<any>>,
  presets: ReadonlyArray<Preset>,
  actions: CommandActions,
): ReadonlyArray<PaletteCommand> => [
  ...[
    { id: "panel:next", title: "Focus next panel", group: "Panels", run: actions.focusNext },
    { id: "panel:previous", title: "Focus previous panel", group: "Panels", run: actions.focusPrevious },
    { id: "panel:close-active", title: "Close active panel", group: "Panels", run: actions.closeActive },
    { id: "panel:maximize-active", title: "Maximize or restore active panel", group: "Panels", run: actions.toggleMaximize },
    { id: "panel:wider", title: "Make active panel group wider", group: "Panels", run: () => actions.resize("wider") },
    { id: "panel:narrower", title: "Make active panel group narrower", group: "Panels", run: () => actions.resize("narrower") },
    { id: "panel:taller", title: "Make active panel group taller", group: "Panels", run: () => actions.resize("taller") },
    { id: "panel:shorter", title: "Make active panel group shorter", group: "Panels", run: () => actions.resize("shorter") },
    { id: "panel:move-next-group", title: "Move active panel to the next group", group: "Panels", run: actions.moveToNextGroup },
    { id: "panel:split-right", title: "Split active panel to the right", group: "Panels", run: () => actions.split("right") },
    { id: "panel:split-below", title: "Split active panel below", group: "Panels", run: () => actions.split("bottom") },
  ].map((c): PaletteCommand => withShortcut(c as PaletteCommand)),
  ...modules.flatMap((m) =>
    m.panels.map((p): PaletteCommand => ({ id: `panel:${p.id}`, title: `Show panel: ${p.title}`, group: "Panels", run: () => actions.showPanel(p.id) })),
  ),
  ...presets.map((p): PaletteCommand => ({ id: `preset:${p.id}`, title: `Layout preset: ${p.title}`, group: "Layout", run: () => actions.applyPreset(p.id) })),
  { id: "layout:reset", title: "Reset layout", group: "Layout", run: actions.resetLayout },
  { id: "layout:share", title: "Copy share link for this layout", group: "Layout", run: actions.shareLayout },
  { id: "view:toggle-theme", title: "Toggle light or dark theme", group: "View", run: actions.toggleTheme },
  ...modules.flatMap((m) =>
    (m.commands ?? []).map((c): PaletteCommand => ({ id: `module:${m.id}:${c.id}`, title: c.title, group: "Module", run: c.run })),
  ),
]

const score = (cmd: PaletteCommand, tokens: ReadonlyArray<string>): number => {
  const title = cmd.title.toLowerCase()
  const haystack = `${title} ${cmd.group.toLowerCase()}`
  let total = 0
  for (const t of tokens) {
    const at = title.indexOf(t)
    if (at === 0) total += 3
    else if (at > 0) total += title[at - 1] === " " || title[at - 1] === ":" ? 2 : 1
    else if (haystack.includes(t)) total += 0.5
    else return -1
  }
  return total
}

/** Case-insensitive, whitespace-separated token match over title and group; best matches first, ties keep registration order. */
export const filterCommands = (commands: ReadonlyArray<PaletteCommand>, query: string): ReadonlyArray<PaletteCommand> => {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return commands
  return commands
    .map((c, i) => ({ c, i, s: score(c, tokens) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c)
}
