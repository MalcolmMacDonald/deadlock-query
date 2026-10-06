import { expect, test } from "bun:test"
import { join } from "node:path"
import { buildCatalog, docProblems } from "../scripts/catalog.ts"

const catalog = buildCatalog(join(import.meta.dir, "../src"))

test("every public export is documented with a category and example", () => {
  expect(docProblems(catalog)).toEqual([])
})

test("catalog covers the Slice-1 surface", () => {
  const names = catalog.map((e) => e.name)
  for (const n of ["MapContext", "Vec3", "Seq", "EntityList", "meters", "vec", "Lane"]) expect(names).toContain(n)
  expect(catalog.find((e) => e.name === "EntityList")!.members.map((m) => m.name)).toContain("inLane")
})
