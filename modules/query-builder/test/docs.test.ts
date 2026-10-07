import { expect, test } from "bun:test"
import { DOC_ALLOWLIST, findByWord, insertionFor, searchDocs } from "../src/docs/catalog.ts"
import { GALLERY } from "../src/gallery/queries.ts"
import { SNIPPETS, expandSnippet } from "../src/docs/snippets.ts"
import { docIndexFromSource, typecheck } from "./librarySource.ts"

const index = docIndexFromSource()
const item = (id: string) => index.byId.get(id)!

test("the index lists every catalog entry and member under a stable id", () => {
  expect(index.items.length).toBeGreaterThan(40)
  expect(index.items.length).toBeLessThan(80)
  for (const id of ["MapContext", "seconds", "EntityList.withinTravelTime", "Seq.where", "Vec3.travelTimeTo"]) expect(index.byId.has(id)).toBe(true)
  expect(new Set(index.items.map((i) => i.id)).size).toBe(index.items.length)
})

test("the docs show only the curated allowlist, without plumbing members", () => {
  const owners = new Set(index.items.filter((i) => i.owner === undefined).map((i) => i.id))
  expect([...owners].sort()).toEqual([...DOC_ALLOWLIST].sort())
  for (const id of ["MapContext.fromBundle", "MapEntity.provenance", "withRun", "RawEntity", "OrderedSeq"]) expect(index.byId.has(id)).toBe(false)
})

// M4 acceptance: each catalog entry is reachable from the editor hover, which looks entries up by the word under the cursor.
test("every entry and member is found by its own name", () => {
  for (const i of index.items) expect(findByWord(index, i.name).map((x) => x.id)).toContain(i.id)
})

test("search ranks name matches first and requires every term", () => {
  expect(searchDocs(index, "withintravel")[0]!.id).toBe("EntityList.withinTravelTime")
  expect(searchDocs(index, "seconds")[0]!.id).toBe("seconds")
  const both = searchDocs(index, "visible ray")
  expect(both.length).toBeGreaterThan(0)
  for (const i of both) expect(`${i.id} ${i.summary} ${i.category} ${i.signature}`.toLowerCase()).toMatch(/visible/)
  expect(searchDocs(index, "zzzznotathing")).toEqual([])
  expect(searchDocs(index, "  ")).toEqual(index.items)
})

test("insertion adds the dot and parentheses a click needs", () => {
  expect(insertionFor(item("seconds"), "")).toEqual({ text: "seconds()", cursorBack: 1 })
  expect(insertionFor(item("EntityList.closest"), "map.healingOrbs.")).toEqual({ text: "closest()", cursorBack: 1 })
  expect(insertionFor(item("EntityList.closest"), "map.healingOrbs")).toEqual({ text: ".closest()", cursorBack: 1 })
  expect(insertionFor(item("Seq.toArray"), "map.guardians\n  ")).toEqual({ text: ".toArray()", cursorBack: 0 })
  expect(insertionFor(item("MapContext.guardians"), "map")).toEqual({ text: ".guardians", cursorBack: 0 })
})

test("every gallery query and every snippet (with default placeholders) type-checks against the library", () => {
  const sources: Record<string, string> = {}
  for (const q of GALLERY) sources[`gallery_${q.id.replace(/\W/g, "_")}`] = q.source
  for (const s of SNIPPETS) {
    const body = expandSnippet(s.body)
    sources[`snippet_${s.label}`] = s.kind === "statement" ? body : `map.guardians${body}`
  }
  const results = typecheck(sources)
  for (const [name, problems] of Object.entries(results)) expect({ name, problems }).toEqual({ name, problems: [] })
  expect(Object.keys(results).length).toBe(GALLERY.length + SNIPPETS.length)
}, 120_000)

test("the gallery carries the three PLAN.md headline queries", () => {
  const text = GALLERY.map((q) => q.source).join("\n")
  expect(text).toContain("withinTravelTime(seconds(10)")
  expect(text).toMatch(/travelDistanceTo\(b\) >= 2 \* a\.crowFliesTo\(b\)/)
  expect(text).toContain("visibleFrom(")
  for (const q of GALLERY.filter((x) => x.requires.length > 0)) expect(q.note).toBeTruthy()
})

test("snippet placeholders expand to their defaults", () => {
  expect(expandSnippet('f(${1:a}, ${2:"b"}) + ${1:a}$0')).toBe('f(a, "b") + a')
})
