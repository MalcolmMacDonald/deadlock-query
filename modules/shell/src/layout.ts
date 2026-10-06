/** Versioned persistence for the dockview layout. Pure functions so they are unit-testable without a DOM. */
export const LAYOUT_KEY = "dlq.shell.layout"
export const LAYOUT_VERSION = 1

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
