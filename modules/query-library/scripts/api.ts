import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildCatalog, type CatalogEntry } from "./catalog.ts"

const root = join(import.meta.dir, "..")
export const snapshotPath = join(root, "test/api.snapshot.json")

export interface ApiSnapshot {
  readonly apiVersion: string
  /** One line per public symbol or member: `Name kind signature` / `Name.member kind signature`. */
  readonly symbols: ReadonlyArray<string>
}

/** Flatten the catalog to signatures only (docs are not part of API compatibility). */
export const toSymbols = (catalog: ReadonlyArray<CatalogEntry>): string[] =>
  catalog
    .flatMap((e) => [`${e.name} ${e.kind} ${e.signature}`, ...e.members.map((m) => `${e.name}.${m.name} ${m.kind} ${m.signature}`)])
    .sort()

export const currentApi = async (): Promise<ApiSnapshot> => ({
  apiVersion: (await Bun.file(join(root, "package.json")).json()).version,
  symbols: toSymbols(buildCatalog(join(root, "src")))
})

export const readSnapshot = (): ApiSnapshot => JSON.parse(readFileSync(snapshotPath, "utf8"))

export const diffApi = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) => {
  const a = new Set(before), b = new Set(after)
  return { removedOrChanged: before.filter((s) => !b.has(s)), added: after.filter((s) => !a.has(s)) }
}

if (import.meta.main) {
  const cur = await currentApi()
  let prev: ApiSnapshot | undefined
  try { prev = readSnapshot() } catch { /* first run */ }
  if (prev) {
    const { removedOrChanged } = diffApi(prev.symbols, cur.symbols)
    if (removedOrChanged.length && prev.apiVersion === cur.apiVersion) {
      console.error(`Breaking API change without a version bump (still ${cur.apiVersion}). Bump "version" in package.json, then rerun.\n` + removedOrChanged.map((s) => `  - ${s}`).join("\n"))
      process.exit(1)
    }
  }
  writeFileSync(snapshotPath, JSON.stringify(cur, null, 2) + "\n")
  console.log(`wrote test/api.snapshot.json (${cur.symbols.length} symbols, apiVersion ${cur.apiVersion})`)
}
