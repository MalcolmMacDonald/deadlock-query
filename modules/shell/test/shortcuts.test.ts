import { expect, test } from "bun:test"
import { matchShortcut, PALETTE_TOGGLE, SHORTCUTS, shortcutFor, shortcutLabel } from "../src/shortcuts.ts"

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key: k, ctrlKey: mods.ctrl ?? false, metaKey: mods.meta ?? false, altKey: mods.alt ?? false, shiftKey: mods.shift ?? false,
})

test("Ctrl+K and Cmd+K toggle the palette, in any case", () => {
  expect(matchShortcut(key("k", { ctrl: true }))?.command).toBe(PALETTE_TOGGLE)
  expect(matchShortcut(key("K", { meta: true }))?.command).toBe(PALETTE_TOGGLE)
})

test("exact modifiers are required", () => {
  expect(matchShortcut(key("k"))).toBeUndefined()
  expect(matchShortcut(key("k", { ctrl: true, shift: true }))).toBeUndefined()
  expect(matchShortcut(key("k", { ctrl: true, alt: true }))).toBeUndefined()
  expect(matchShortcut(key(".", { alt: true }))?.command).toBe("panel:next")
  expect(matchShortcut(key(",", { alt: true }))?.command).toBe("panel:previous")
  expect(matchShortcut(key("W", { alt: true, shift: true }))?.command).toBe("panel:close-active")
  expect(matchShortcut(key("w", { alt: true }))).toBeUndefined()
  expect(matchShortcut(key("ArrowRight", { alt: true, shift: true }))?.command).toBe("panel:wider")
  expect(matchShortcut(key("ArrowUp", { alt: true, shift: true }))?.command).toBe("panel:shorter")
  expect(shortcutFor("panel:wider")).toBe("Alt+Shift+Arrow Right")
})

test("registry has no duplicate bindings and labels read naturally", () => {
  const bindings = SHORTCUTS.map((s) => shortcutLabel(s))
  expect(new Set(bindings).size).toBe(bindings.length)
  expect(shortcutFor(PALETTE_TOGGLE)).toBe("Ctrl+K")
  expect(shortcutFor("nope")).toBeUndefined()
})
