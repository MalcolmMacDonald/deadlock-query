/** Versioned persistence for the dockview layout. Pure functions so they are unit-testable without a DOM. */
export const LAYOUT_KEY = "dlq.shell.layout"
export const LAYOUT_VERSION = 2

export interface StoredLayout {
  readonly version: number
  readonly layout: unknown
}

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const serializeLayout = (layout: unknown): string =>
  JSON.stringify({ version: LAYOUT_VERSION, layout } satisfies StoredLayout)

/** Returns the stored layout, or null when absent, corrupt, or from an unknown version. */
export const parseLayout = (raw: string | null): unknown | null => {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const { version, layout } = parsed as Partial<StoredLayout>
    return version === LAYOUT_VERSION && layout !== undefined ? layout : null
  } catch {
    return null
  }
}

export const loadLayout = (store: KeyValueStore): unknown | null => parseLayout(store.getItem(LAYOUT_KEY))
export const saveLayout = (store: KeyValueStore, layout: unknown): void =>
  store.setItem(LAYOUT_KEY, serializeLayout(layout))
export const resetLayout = (store: KeyValueStore): void => store.removeItem(LAYOUT_KEY)

/** Ids of the panels a dockview JSON layout refers to, or null when it has no recognisable `panels` map. */
export const layoutPanelIds = (layout: unknown): ReadonlyArray<string> | null => {
  if (typeof layout !== "object" || layout === null) return null
  const panels = (layout as { panels?: unknown }).panels
  return typeof panels === "object" && panels !== null && !Array.isArray(panels) ? Object.keys(panels) : null
}

/** True when `layout` is non-empty and every panel it names is registered (a renamed/removed panel would break `fromJSON`). */
export const isRestorable = (layout: unknown, registered: Iterable<string>): boolean => {
  const ids = layoutPanelIds(layout)
  if (!ids || ids.length === 0) return false
  const known = new Set(registered)
  return ids.every((id) => known.has(id))
}
