import type { ModuleDefinition } from "@deadlock-query/contracts"
import type { Preset } from "./presets.ts"

export interface PaletteCommand {
  readonly id: string
  readonly title: string
  readonly group: "Panels" | "Layout" | "Module"
  readonly run: () => void | Promise<void>
}

export interface CommandActions {
  readonly showPanel: (panelId: string) => void
  readonly applyPreset: (presetId: Preset["id"]) => void
  readonly resetLayout: () => void
  readonly shareLayout: () => void
}

/** Every palette entry: reopen/focus each registered panel, switch presets, reset, share, plus modules' own commands. */
export const buildCommands = (
  modules: ReadonlyArray<ModuleDefinition<any>>,
  presets: ReadonlyArray<Preset>,
  actions: CommandActions,
): ReadonlyArray<PaletteCommand> => [
  ...modules.flatMap((m) =>
    m.panels.map((p): PaletteCommand => ({ id: `panel:${p.id}`, title: `Show panel: ${p.title}`, group: "Panels", run: () => actions.showPanel(p.id) })),
  ),
  ...presets.map((p): PaletteCommand => ({ id: `preset:${p.id}`, title: `Layout preset: ${p.title}`, group: "Layout", run: () => actions.applyPreset(p.id) })),
  { id: "layout:reset", title: "Reset layout", group: "Layout", run: actions.resetLayout },
  { id: "layout:share", title: "Copy share link for this layout", group: "Layout", run: actions.shareLayout },
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
