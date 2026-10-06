import { Effect } from "effect"
import {
  AnnotationDocument, decodeVersioned, makeAnnotationDocument, validateAnnotationDocument
} from "@deadlock-query/contracts"
import type { Annotation } from "./annotations.ts"

/** Map the annotations were drawn on; written into exports and checked on import. */
export interface MapIdentity {
  readonly mapName?: string
  readonly gameBuildId?: string
}

export const toDocument = (
  annotations: ReadonlyArray<Annotation>,
  layers: AnnotationDocument["layers"],
  map: MapIdentity
): AnnotationDocument =>
  makeAnnotationDocument(annotations, {
    ...(map.mapName !== undefined ? { mapName: map.mapName } : {}),
    ...(map.gameBuildId !== undefined ? { gameBuildId: map.gameBuildId } : {}),
    ...(layers !== undefined ? { layers } : {})
  })

export const serializeDocument = (doc: AnnotationDocument): string => JSON.stringify(doc, null, 2)

export type ParsedDocument =
  | { readonly ok: true; readonly doc: AnnotationDocument; readonly warnings: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: string }

/** Parses and validates an exported document (schema, version, cross-field rules); mismatched map/build only warn. */
export const parseDocument = (text: string, map: MapIdentity = {}): ParsedDocument => {
  let json: unknown
  try { json = JSON.parse(text) } catch (e) { return { ok: false, error: `not valid JSON: ${(e as Error).message}` } }
  let doc: AnnotationDocument
  try {
    doc = Effect.runSync(decodeVersioned(AnnotationDocument, 1)(json))
  } catch (e) {
    return { ok: false, error: `not a valid annotation document: ${e instanceof Error ? e.message : String(e)}` }
  }
  const problems = validateAnnotationDocument(doc)
  if (problems.length) return { ok: false, error: problems.join("; ") }
  const warnings: string[] = []
  if (map.mapName && doc.mapName && doc.mapName !== map.mapName) warnings.push(`drawn on map "${doc.mapName}", viewing "${map.mapName}"`)
  if (map.gameBuildId && doc.gameBuildId && doc.gameBuildId !== map.gameBuildId) {
    warnings.push(`drawn on build ${doc.gameBuildId}, viewing ${map.gameBuildId}`)
  }
  return { ok: true, doc, warnings }
}

/** Where autosaved documents live: one serialized document per key. */
export interface AnnotationStorage {
  readonly load: (key: string) => Promise<string | undefined>
  readonly save: (key: string, text: string) => Promise<void>
}

export const memoryStorage = (): AnnotationStorage & { readonly entries: Map<string, string> } => {
  const entries = new Map<string, string>()
  return { entries, load: async (k) => entries.get(k), save: async (k, v) => { entries.set(k, v) } }
}

const DB_NAME = "deadlock-query-viewer"
const STORE = "annotations"

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })

/** IndexedDB-backed storage, or undefined where IndexedDB is unavailable (tests, private modes). */
export const indexedDbStorage = (): AnnotationStorage | undefined => {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (!idb) return undefined
  let db: Promise<IDBDatabase> | undefined
  const open = () => db ??= new Promise((resolve, reject) => {
    const r = idb.open(DB_NAME, 1)
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE) }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => { db = undefined; reject(r.error) }
  })
  return {
    load: async (key) => {
      const v = await request((await open()).transaction(STORE).objectStore(STORE).get(key))
      return typeof v === "string" ? v : undefined
    },
    save: async (key, text) => { await request((await open()).transaction(STORE, "readwrite").objectStore(STORE).put(text, key)) }
  }
}

export const autosaveKey = (map: MapIdentity): string => `annotations:${map.mapName ?? "unknown"}`
