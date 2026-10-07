import type { MetadataRecord } from "@deadlock-query/contracts"
import type { DraftStorage } from "./drafts.ts"

const STORE = "drafts"

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })

/** Drafts in an IndexedDB database of their own, one object store keyed by record id. `name` separates maps and builds. */
export const indexedDbDraftStorage = (name: string, factory: IDBFactory = indexedDB): DraftStorage => {
  let db: Promise<IDBDatabase> | undefined
  const open = () => db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(`dlq-metadata-drafts:${name}`, 1)
    req.onupgradeneeded = () => void req.result.createObjectStore(STORE, { keyPath: "id" })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { db = undefined; reject(req.error) }
  })
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode)
  return {
    load: async () => request((await tx("readonly")).objectStore(STORE).getAll()),
    save: async (r: MetadataRecord) => { const t = await tx("readwrite"); t.objectStore(STORE).put(r); await done(t) },
    remove: async (id) => { const t = await tx("readwrite"); t.objectStore(STORE).delete(id); await done(t) },
    clear: async () => { const t = await tx("readwrite"); t.objectStore(STORE).clear(); await done(t) }
  }
}
