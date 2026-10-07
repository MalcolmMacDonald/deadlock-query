import { afterAll, beforeAll, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { QueryEngine, type QueryDiagnostic, type QueryOutput } from "@deadlock-query/contracts"
import { makeQueryEngine } from "../src/engine/engine.ts"
import { makeFriendly } from "../src/engine/friendly.ts"
import { miniBundle, preludeFor, stripTypesCompiler, workerRunner } from "./helpers.ts"
import { docIndexFromSource, typecheck } from "./librarySource.ts"

const friendly = makeFriendly(docIndexFromSource())
const diag = (message: string): QueryDiagnostic => ({ message, line: 1, column: 1, severity: "error" })

/** Real TypeScript messages for broken queries, rewritten. One program for all of them: a type-check per test is slow on busy CI. */
const BROKEN = [
  "guardians.count()",
  "secondz(10)",
  "wibble",
  "map.healingOrbs.closet(map.guardians.first()!)",
  "map.guardians.first()!.position.travelTimeToo",
  "map.guardians.filter((g) => g.team === 1)",
  "map.guardians.map((g) => g.id)",
  "map.healingOrbs.length",
  'map.guardians.inLane("red")',
  "map.guardians.first()!.position.distanceTo(5)",
]
let raw: Record<string, string[]>
beforeAll(() => {
  raw = typecheck(Object.fromEntries(BROKEN.map((src, i) => [String(i), src])))
}, 120_000)
const advise = (source: string): string => {
  const [first] = raw[String(BROKEN.indexOf(source))]!
  expect(first).toBeTruthy()
  return friendly.diagnostic(diag(first!)).message
}

test("unknown names point at map members and near misses", () => {
  expect(advise("guardians.count()")).toContain("Did you mean `map.guardians`?")
  expect(advise("secondz(10)")).toContain("Did you mean `seconds`?")
  expect(advise("wibble")).toContain("Docs panel")
})

test("misspelled members get a suggestion from the owning class", () => {
  expect(advise("map.healingOrbs.closet(map.guardians.first()!)")).toContain("Did you mean `closest`?")
  expect(advise("map.guardians.first()!.position.travelTimeToo")).toContain("Did you mean `travelTimeTo`?")
})

test("Array habits on a sequence are translated to the LINQ names", () => {
  expect(advise("map.guardians.filter((g) => g.team === 1)")).toContain("`.where(predicate)`")
  expect(advise("map.guardians.map((g) => g.id)")).toContain("`.select(fn)`")
  expect(advise("map.healingOrbs.length")).toContain("`.count()`")
})

test("lane and position argument mistakes explain the accepted values", () => {
  expect(advise('map.guardians.inLane("red")')).toContain('"yellow", "blue" or "green"')
  expect(advise("map.guardians.first()!.position.distanceTo(5)")).toContain("Expected a position")
})

test("top-level return and await get query-shaped advice", () => {
  expect(friendly.diagnostic(diag("A 'return' statement can only be used within a function body.")).message).toContain("drop `return`")
  expect(friendly.diagnostic(diag("Top-level 'await' expressions are only allowed when the 'module' option is set.")).message).toContain("no `await`")
})

test("the original message is kept, and unknown errors pass through unchanged", () => {
  const raw = "Property 'nope' does not exist on type 'EntityList'."
  expect(friendly.diagnostic(diag(raw)).message).toEndWith(`(${raw})`)
  const other = diag("Type 'string' is not assignable to type 'number'.")
  expect(friendly.diagnostic(other)).toEqual(other)
})

test("a bare number as a travel-time duration is flagged with the exact fix and position", () => {
  const [w] = friendly.lint("const x = 1\nmap.healingOrbs.withinTravelTime(10, map.guardians)")
  expect(w).toMatchObject({ line: 2, column: 34, severity: "warning" })
  expect(w!.message).toContain("seconds(10)")
  expect(friendly.lint("map.healingOrbs.withinTravelTime(seconds(10), map.guardians)")).toEqual([])
})

test("runtime errors about missing map data say what is missing", () => {
  expect(friendly.runtime("withinTravelTime() needs a navmesh: pass { spatial }")).toContain("withinTravelTime() needs map data this bundle does not have yet")
  expect(friendly.runtime("visibleFrom() needs a spatial backend: pass x")).toContain("navigation mesh, collision geometry or semantics")
  expect(friendly.runtime("sample.walls() needs semantics (spatial-core semantics/); none were provided")).toContain("sample.walls() needs")
  expect(friendly.runtime("Cannot read properties of undefined (reading 'id')")).toContain("`closest()`")
  expect(friendly.runtime("boom")).toBe("boom")
})

let runner: ReturnType<typeof workerRunner>
let layer: ReturnType<typeof makeQueryEngine>
beforeAll(async () => {
  runner = workerRunner(await preludeFor(), miniBundle())
  layer = makeQueryEngine({ compiler: stripTypesCompiler, runner, friendly })
})
afterAll(() => runner.dispose())
const run = (source: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* QueryEngine
      return Array.from((yield* Stream.runCollect(engine.run(source))) as Iterable<QueryOutput>)
    }).pipe(Effect.provide(layer))
  )

// What the gallery's travel-time queries do today: the fixture bundle has no navmesh.
test("the engine shows the friendly message when a query needs data the bundle lacks", async () => {
  await expect(run("map.healingOrbs.withinTravelTime(seconds(10), map.guardians).toArray()")).rejects.toThrow(/needs map data this bundle does not have yet/)
})

test("the engine reports lint warnings with the result", async () => {
  const out = (await run("map.guardians.count()")).find((o) => o._tag === "result")
  expect(out?._tag).toBe("result")
  const r = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* QueryEngine).check("map.healingOrbs.withinTravelTime(10, map.guardians)") }).pipe(Effect.provide(layer)))
  expect(r.map((d) => d.message).join("\n")).toContain("seconds(10)")
})
