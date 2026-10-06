/** The library's `apiCatalog.json` (written by query-library's build). Browser-safe: no node imports. */
export interface CatalogMember {
  readonly name: string
  readonly kind: "method" | "property" | "getter" | "constructor"
  readonly signature: string
  readonly summary: string
  readonly category?: string
  readonly examples: ReadonlyArray<string>
}

export interface CatalogEntry {
  readonly name: string
  readonly kind: "class" | "function" | "const" | "type" | "interface"
  readonly signature: string
  readonly summary: string
  readonly category?: string
  readonly examples: ReadonlyArray<string>
  readonly members: ReadonlyArray<CatalogMember>
}

export interface ApiCatalog {
  readonly apiVersion: string
  readonly entries: ReadonlyArray<CatalogEntry>
}

/** One documentable thing: a top-level export (`seconds`) or a class member (`EntityList.closest`). */
export interface DocItem {
  /** Stable id: `Name` or `Class.member`. */
  readonly id: string
  readonly name: string
  readonly owner?: string
  readonly kind: CatalogEntry["kind"] | CatalogMember["kind"]
  readonly signature: string
  readonly summary: string
  readonly category: string
  readonly examples: ReadonlyArray<string>
}

export interface DocIndex {
  readonly apiVersion: string
  readonly items: ReadonlyArray<DocItem>
  readonly byId: ReadonlyMap<string, DocItem>
  /** Items whose `name` is exactly the key (a member name can belong to several classes). */
  readonly byName: ReadonlyMap<string, ReadonlyArray<DocItem>>
}

export const buildDocIndex = (catalog: ApiCatalog): DocIndex => {
  const items: DocItem[] = []
  for (const e of catalog.entries) {
    const category = e.category ?? "Other"
    items.push({ id: e.name, name: e.name, kind: e.kind, signature: e.signature, summary: e.summary, category, examples: e.examples })
    for (const m of e.members) {
      items.push({ id: `${e.name}.${m.name}`, name: m.name, owner: e.name, kind: m.kind, signature: m.signature, summary: m.summary, category: m.category ?? category, examples: m.examples })
    }
  }
  const byId = new Map(items.map((i) => [i.id, i]))
  const byName = new Map<string, DocItem[]>()
  for (const i of items) byName.set(i.name, [...(byName.get(i.name) ?? []), i])
  return { apiVersion: catalog.apiVersion, items, byId, byName }
}

/** Entries matching the identifier under the editor's cursor (what hover links to). */
export const findByWord = (index: DocIndex, word: string): ReadonlyArray<DocItem> => index.byName.get(word) ?? []

const score = (i: DocItem, terms: ReadonlyArray<string>): number => {
  const name = i.name.toLowerCase()
  const id = i.id.toLowerCase()
  const summary = i.summary.toLowerCase()
  const category = i.category.toLowerCase()
  let total = 0
  for (const t of terms) {
    const s =
      name === t ? 100 : id === t ? 90 : name.startsWith(t) ? 60 : name.includes(t) ? 40 : id.includes(t) ? 30
      : category.includes(t) ? 15 : summary.includes(t) ? 10 : i.signature.toLowerCase().includes(t) ? 5 : 0
    if (s === 0) return 0
    total += s
  }
  return total
}

/** All terms must match somewhere (name, owner, category, summary, signature); best name matches first. */
export const searchDocs = (index: DocIndex, query: string): ReadonlyArray<DocItem> => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return index.items
  return index.items
    .map((i) => ({ i, s: score(i, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i.id.localeCompare(b.i.id))
    .map((x) => x.i)
}

export interface Insertion {
  readonly text: string
  /** Characters to move the cursor back from the end of `text` (to land inside the parentheses). */
  readonly cursorBack: number
}

/** A `const` whose value is an arrow function (`seconds = (n: number): number => n`). */
const ARROW = /=\s*\([^)]*\)\s*(?::[^=]+)?=>/
const hasParams = (signature: string): boolean => /^[^(]*\(\s*[^)\s]/.test(signature)

/**
 * What clicking a docs entry inserts. `before` is the source text before the cursor: after `.` only
 * the member is inserted; after an expression a `.` is added; on a blank spot the bare name goes in.
 */
export const insertionFor = (item: DocItem, before: string): Insertion => {
  const callable = item.kind === "method" || item.kind === "function" || item.kind === "constructor" || (item.kind === "const" && ARROW.test(item.signature))
  const call = callable ? "()" : ""
  const back = callable && hasParams(item.signature) ? 1 : 0
  if (item.owner === undefined) return { text: `${item.name}${call}`, cursorBack: back }
  const prev = before.replace(/\s+$/, "").slice(-1)
  const dot = prev === "." ? "" : /[\w)\]]/.test(prev) ? "." : ""
  return { text: `${dot}${item.name}${call}`, cursorBack: back }
}
