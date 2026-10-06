import { afterAll, beforeAll, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { QueryEngine, buildMiniMap, type QueryOutput } from "@deadlock-query/contracts"
import { makeQueryEngine } from "../src/engine/engine.ts"
import { miniBundle, preludeFor, stripTypesCompiler, workerRunner } from "./helpers.ts"

let runner: ReturnType<typeof workerRunner>
let layer: ReturnType<typeof makeQueryEngine>
beforeAll(async () => {
  runner = workerRunner(await preludeFor(), miniBundle())
  layer = makeQueryEngine({ compiler: stripTypesCompiler, runner })
})
afterAll(() => runner.dispose())

const run = (source: string, timeoutMs?: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* QueryEngine
      return Array.from((yield* Stream.runCollect(engine.run(source, timeoutMs === undefined ? {} : { timeoutMs }))) as Iterable<QueryOutput>)
    }).pipe(Effect.provide(layer))
  )
const resultOf = async (source: string) => {
  const out = (await run(source)).find((o) => o._tag === "result")
  if (out?._tag !== "result") throw new Error("no result")
  return out.result
}

// Slice-1 acceptance: the guardian → nearest healing orb query returns the fixture's expected rows.
test("slice-1 query on the mini-map returns the expected rows", async () => {
  const r = await resultOf(`
    map.guardians
      .select((g: any) => {
        const orb = map.healingOrbs.closest(g)!
        return [g.id, g.position.toArray(), orb.id, Math.round(g.distanceTo(orb) * 1000) / 1000]
      })
      .toArray()`)
  const expected = buildMiniMap().expectedGuardianOrbDistance
  expect(r.rows).toEqual(expected.rows as never)
  expect(r.columns.map((c) => c.type)).toEqual(["string", "point", "string", "number"])
  expect(r.geometryColumns).toEqual(["c2"])
  expect(r.stats.rowCount).toBe(expected.rows.length)
})

test("a Seq or Vec3 returned directly is normalised; entities project to ids", async () => {
  const seq = await resultOf("map.guardians.select((g: any) => g.position)")
  expect(seq.columns).toEqual([{ name: "value", type: "point" }])
  const ents = await resultOf("map.healingOrbs.toArray().map((o: any) => ({ orb: o, z: o.position.z }))")
  expect(ents.columns[0]).toEqual({ name: "orb", type: "entityRef" })
})

test("runtime errors surface as failures with the message", async () => {
  await expect(run("throw new Error('nope')")).rejects.toThrow(/nope/)
})

test("type/syntax diagnostics block the run", async () => {
  await expect(run("const = ;")).rejects.toThrow(/1:1/)
})

test("an infinite loop is stopped by the timeout and the next query still works", async () => {
  const t0 = performance.now()
  await expect(run("while (true) {}", 300)).rejects.toThrow(/timed out/)
  expect(performance.now() - t0).toBeLessThan(3000)
  expect((await resultOf("[1, 2, 3].map((n) => n)")).rows).toEqual([[1], [2], [3]])
  // The map is reloaded into the respawned worker.
  expect((await resultOf("map.guardians.count()")).rows[0]).toEqual([6])
})

test("explicit cancel rejects the running query", async () => {
  const p = run("while (true) {}", 10_000).then(() => undefined, (e: Error) => e)
  await Bun.sleep(100)
  await Effect.runPromise(Effect.gen(function* () { yield* (yield* QueryEngine).cancel }).pipe(Effect.provide(layer)))
  expect((await p)?.message).toMatch(/cancelled/)
})

test("a cancel that lands while compiling stops the run before it starts", async () => {
  let release!: () => void
  const slow = makeQueryEngine({
    compiler: { compile: async (src) => { await new Promise<void>((r) => (release = r)); return stripTypesCompiler.compile(src) } },
    runner
  })
  const p = Effect.runPromise(
    Effect.gen(function* () { return yield* Stream.runCollect((yield* QueryEngine).run("while (true) {}")) }).pipe(Effect.provide(slow))
  ).then(() => undefined, (e: Error) => e)
  await Bun.sleep(20)
  await Effect.runPromise(Effect.gen(function* () { yield* (yield* QueryEngine).cancel }).pipe(Effect.provide(slow)))
  release()
  expect((await p)?.message).toMatch(/cancelled/)
})
