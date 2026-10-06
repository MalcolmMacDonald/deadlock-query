/** The slice of `Storage` the store needs (`localStorage` in the app, a Map in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface SavedQuery {
  readonly id: string
  readonly name: string
  readonly source: string
  /** Library `apiVersion` the query was saved against. */
  readonly apiVersion?: string
  readonly savedAt: number
}

export interface HistoryEntry {
  readonly source: string
  readonly at: number
  readonly status: "ok" | "error"
  readonly rows?: number
  readonly error?: string
}

export interface QueryStore {
  readonly saved: () => ReadonlyArray<SavedQuery>
  /** Saves under `name`, replacing a query that already has that name. */
  readonly save: (name: string, source: string, apiVersion?: string) => SavedQuery
  readonly remove: (id: string) => void
  readonly history: () => ReadonlyArray<HistoryEntry>
  /** Newest first; running the same source with the same outcome again only refreshes its time. */
  readonly record: (entry: Omit<HistoryEntry, "at">) => void
  readonly clearHistory: () => void
}

export const STORAGE_KEY = "dlq.queryBuilder.v1"
export const MAX_HISTORY = 50
export const MAX_SAVED = 200
const MAX_SOURCE_CHARS = 100_000

interface Persisted { saved: SavedQuery[]; history: HistoryEntry[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const str = (v: unknown): v is string => typeof v === "string"

/** Keeps only well-formed entries: whatever is in storage (older versions, hand edits) must not break the panel. */
const sanitize = (raw: unknown): Persisted => {
  const out: Persisted = { saved: [], history: [] }
  if (!isObj(raw)) return out
  for (const s of Array.isArray(raw.saved) ? raw.saved : []) {
    if (isObj(s) && str(s.id) && str(s.name) && str(s.source) && typeof s.savedAt === "number")
      out.saved.push({ id: s.id, name: s.name, source: s.source, savedAt: s.savedAt, ...(str(s.apiVersion) ? { apiVersion: s.apiVersion } : {}) })
  }
  for (const h of Array.isArray(raw.history) ? raw.history : []) {
    if (isObj(h) && str(h.source) && typeof h.at === "number" && (h.status === "ok" || h.status === "error"))
      out.history.push({ source: h.source, at: h.at, status: h.status, ...(typeof h.rows === "number" ? { rows: h.rows } : {}), ...(str(h.error) ? { error: h.error } : {}) })
  }
  return out
}

export const makeQueryStore = (storage: KeyValueStorage | undefined, now: () => number = Date.now, newId: () => string = () => crypto.randomUUID()): QueryStore => {
  const load = (): Persisted => {
    try {
      const text = storage?.getItem(STORAGE_KEY)
      return text ? sanitize(JSON.parse(text)) : { saved: [], history: [] }
    } catch { return { saved: [], history: [] } }
  }
  let state = load()
  // Storage can be full, blocked or absent (private windows): the panel keeps working from memory.
  const persist = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* in-memory only */ } }
  return {
    saved: () => state.saved,
    save: (name, source, apiVersion) => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error("Give the query a name.")
      if (source.length > MAX_SOURCE_CHARS) throw new Error("The query is too large to save.")
      const existing = state.saved.find((s) => s.name === trimmed)
      const entry: SavedQuery = { id: existing?.id ?? newId(), name: trimmed, source, savedAt: now(), ...(apiVersion ? { apiVersion } : {}) }
      const rest = state.saved.filter((s) => s.id !== entry.id)
      if (!existing && rest.length >= MAX_SAVED) throw new Error(`You can keep up to ${MAX_SAVED} saved queries; delete one first.`)
      state = { ...state, saved: [entry, ...rest] }
      persist()
      return entry
    },
    remove: (id) => { state = { ...state, saved: state.saved.filter((s) => s.id !== id) }; persist() },
    history: () => state.history,
    record: (e) => {
      if (e.source.length > MAX_SOURCE_CHARS) return
      const [latest, ...older] = state.history
      const same = latest && latest.source === e.source && latest.status === e.status
      state = { ...state, history: [{ ...e, at: now() }, ...(same ? older : state.history)].slice(0, MAX_HISTORY) }
      persist()
    },
    clearHistory: () => { state = { ...state, history: [] }; persist() }
  }
}
