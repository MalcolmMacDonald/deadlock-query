/** The keyboard shortcut registry: every global shortcut and the command it runs (also shown in the command palette). */
export interface Shortcut {
  /** A palette command id (`commands.ts`), or `palette:toggle`, which the app handles itself. */
  readonly command: string
  /** `KeyboardEvent.key`, compared case-insensitively. */
  readonly key: string
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
}

export const PALETTE_TOGGLE = "palette:toggle"

export const SHORTCUTS: ReadonlyArray<Shortcut> = [
  { command: PALETTE_TOGGLE, key: "k", ctrl: true },
  { command: "panel:next", key: ".", alt: true },
  { command: "panel:previous", key: ",", alt: true },
  { command: "panel:close-active", key: "w", alt: true, shift: true },
  { command: "panel:maximize-active", key: "m", alt: true, shift: true },
]

type KeyEventLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">

/** The registered shortcut a key event triggers. Cmd counts as Ctrl so macOS users get the same bindings. */
export const matchShortcut = (e: KeyEventLike, shortcuts: ReadonlyArray<Shortcut> = SHORTCUTS): Shortcut | undefined =>
  shortcuts.find(
    (s) =>
      e.key.toLowerCase() === s.key &&
      (e.ctrlKey || e.metaKey) === Boolean(s.ctrl) &&
      e.altKey === Boolean(s.alt) &&
      e.shiftKey === Boolean(s.shift),
  )

/** Human label such as "Ctrl+K" or "Alt+Shift+W". */
export const shortcutLabel = (s: Shortcut): string =>
  [s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift", s.key.length === 1 ? s.key.toUpperCase() : s.key].filter(Boolean).join("+")

export const shortcutFor = (command: string, shortcuts: ReadonlyArray<Shortcut> = SHORTCUTS): string | undefined => {
  const s = shortcuts.find((x) => x.command === command)
  return s ? shortcutLabel(s) : undefined
}
