import type { KeyValueStore } from "./layout.ts"

export type Theme = "dark" | "light"
export const THEME_KEY = "dlq.shell.theme"

/** Dark is the default; only an explicit stored "light" switches it. */
export const parseTheme = (raw: string | null): Theme => (raw === "light" ? "light" : "dark")
export const nextTheme = (t: Theme): Theme => (t === "dark" ? "light" : "dark")

/** Storage can throw (private mode, blocked cookies): the theme then just falls back to the default. */
export const loadTheme = (store: Pick<KeyValueStore, "getItem">): Theme => {
  try {
    return parseTheme(store.getItem(THEME_KEY))
  } catch {
    return "dark"
  }
}
export const saveTheme = (store: Pick<KeyValueStore, "setItem">, t: Theme): void => {
  try {
    store.setItem(THEME_KEY, t)
  } catch {
    /* not persisted; still applied for this session */
  }
}

/** Sets the colour variables' selector (`data-theme`) and the UA `color-scheme` on the document. */
export const applyTheme = (doc: Document, t: Theme): void => {
  doc.documentElement.dataset.theme = t
  doc.documentElement.style.colorScheme = t
}
