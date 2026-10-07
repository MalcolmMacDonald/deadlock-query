export interface LanePrefs {
  readonly order: ReadonlyArray<string>
  readonly collapsed: ReadonlyArray<string>
}

export interface PrefsStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const KEY = "kanban.lanes"

export const loadPrefs = (store: PrefsStore): LanePrefs => {
  try {
    const p = JSON.parse(store.getItem(KEY) ?? "{}")
    const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [])
    return { order: strs(p.order), collapsed: strs(p.collapsed) }
  } catch {
    return { order: [], collapsed: [] }
  }
}

export const savePrefs = (store: PrefsStore, prefs: LanePrefs): void => {
  try {
    store.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* storage unavailable: prefs just aren't persisted */
  }
}

/** Saved order first (modules that still exist), then any new modules in manifest order. */
export const orderLanes = (modules: ReadonlyArray<string>, prefs: LanePrefs): string[] => {
  const known = prefs.order.filter((m) => modules.includes(m))
  return [...known, ...modules.filter((m) => !known.includes(m))]
}

export const toggleCollapsed = (prefs: LanePrefs, module: string): LanePrefs => ({
  ...prefs,
  collapsed: prefs.collapsed.includes(module) ? prefs.collapsed.filter((m) => m !== module) : [...prefs.collapsed, module]
})

export const moveLane = (modules: ReadonlyArray<string>, prefs: LanePrefs, module: string, delta: -1 | 1): LanePrefs => {
  const order = orderLanes(modules, prefs)
  const i = order.indexOf(module)
  const j = i + delta
  if (i < 0 || j < 0 || j >= order.length) return { ...prefs, order }
  ;[order[i], order[j]] = [order[j]!, order[i]!]
  return { ...prefs, order }
}
