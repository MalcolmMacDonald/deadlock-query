import { Effect, Schema } from "effect"
import { MetadataRecord } from "@deadlock-query/contracts"

/** Where drafts live between visits. The editor uses IndexedDB (`idb.ts`); tests and the server side use memory. */
export interface DraftStorage {
  readonly load: () => Promise<ReadonlyArray<unknown>>
  readonly save: (record: MetadataRecord) => Promise<void>
  readonly remove: (id: string) => Promise<void>
  readonly clear: () => Promise<void>
}

export const memoryDraftStorage = (): DraftStorage & { readonly size: () => number } => {
  const map = new Map<string, unknown>()
  return {
    load: async () => [...map.values()].map((v) => structuredClone(v)),
    save: async (r) => void map.set(r.id, structuredClone(r)),
    remove: async (id) => void map.delete(id),
    clear: async () => void map.clear(),
    size: () => map.size
  }
}

const decode = Schema.decodeUnknownEffect(MetadataRecord)

export interface DraftSnapshot {
  readonly records: ReadonlyArray<MetadataRecord>
  /** Stored drafts that no longer match the schema (older editor version, hand-edited): dropped from the list, counted here. */
  readonly skipped: number
}

/**
 * The contributor's own proposed records, newest last. Every change is written through to storage; listeners get the new
 * list. Records are plain data (the contracts' `MetadataRecord`), so a draft is exactly what a submission will contain.
 */
export interface DraftStore {
  readonly list: () => ReadonlyArray<MetadataRecord>
  readonly get: (id: string) => MetadataRecord | undefined
  readonly add: (record: MetadataRecord) => void
  /** Replace the record with the same id. */
  readonly update: (record: MetadataRecord) => void
  readonly remove: (id: string) => void
  readonly clear: () => void
  readonly skipped: () => number
  readonly subscribe: (fn: (records: ReadonlyArray<MetadataRecord>) => void) => () => void
  /** Resolves when pending writes have reached storage. */
  readonly flush: () => Promise<void>
}

export const openDraftStore = async (storage: DraftStorage): Promise<DraftStore> => {
  const records = new Map<string, MetadataRecord>()
  let skipped = 0
  for (const raw of await storage.load().catch(() => [])) {
    const r = await Effect.runPromise(Effect.result(decode(raw)))
    if (r._tag === "Success") records.set(r.success.id, r.success)
    else skipped++
  }
  const listeners = new Set<(r: ReadonlyArray<MetadataRecord>) => void>()
  let pending: Promise<unknown> = Promise.resolve()
  // Storage failures (private mode, quota) must not break drawing: the draft stays in memory for the session.
  const write = (op: () => Promise<void>) => { pending = pending.then(op).catch(() => undefined) }
  const emit = () => { const l = [...records.values()]; for (const fn of listeners) fn(l) }
  return {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    add: (r) => { records.set(r.id, r); write(() => storage.save(r)); emit() },
    update: (r) => { if (!records.has(r.id)) return; records.set(r.id, r); write(() => storage.save(r)); emit() },
    remove: (id) => { if (records.delete(id)) { write(() => storage.remove(id)); emit() } },
    clear: () => { records.clear(); write(() => storage.clear()); emit() },
    skipped: () => skipped,
    subscribe: (fn) => { listeners.add(fn); return () => void listeners.delete(fn) },
    flush: () => pending.then(() => undefined)
  }
}
