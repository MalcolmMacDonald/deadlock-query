import { afterAll, beforeAll, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { QueryEngine, type QueryOutput } from "@deadlock-query/contracts"
import { makeQueryEngine } from "../src/engine/engine.ts"
import { LIMITS } from "../src/sandbox/limits.ts"
import { miniBundle, preludeFor, stripTypesCompiler, workerRunner } from "./helpers.ts"

/**
 * Adversarial corpus, worker layer (Bun Worker, same source as the real sandbox, no iframe/CSP).
 * The iframe/CSP layer is covered by the Chromium corpus in `sandbox.e2e.test.ts`.
 */
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
const failure = async (source: string, timeoutMs?: number): Promise<string> => {
  try { await run(source, timeoutMs) } catch (e) { return String((e as Error).message) }
  throw new Error("expected the query to fail")
}
/** Runs a probe that returns a value, via the raw `Runner` (skips projection). */
const probe = async (js: string) => {
  const out = await runner.run(js, { timeoutMs: 10_000 })
  if (!out.ok) throw new Error(out.message)
  return out.value
}

test("escape attempts through the global object, Function and constructors find no network", async () => {
  const names = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "WebTransport",
    "Worker", "SharedWorker", "BroadcastChannel", "MessageChannel", "postMessage", "close"]
  const corpus = [
    `[${names.map((n) => `typeof ${n}`).join(", ")}]`,
    `[${names.map((n) => `typeof globalThis[${JSON.stringify(n)}]`).join(", ")}]`,
    `[${names.map((n) => `typeof (0, eval)(${JSON.stringify(n)})`).join(", ")}]`,
    `[${names.map((n) => `typeof new Function(${JSON.stringify(`return typeof ${n}`)})() === "undefined" ? "undefined" : typeof new Function(${JSON.stringify(`return ${n}`)})()`).join(", ")}]`,
    `[${names.map((n) => `typeof (function () { return this })()[${JSON.stringify(n)}]`).join(", ")}]`,
    `[${names.map((n) => `typeof (() => {}).constructor("return self")()[${JSON.stringify(n)}]`).join(", ")}]`,
    `[${names.map((n) => `typeof Object.getPrototypeOf(self)[${JSON.stringify(n)}]`).join(", ")}]`
  ]
  for (const js of corpus) {
    const v = (await probe(js)) as string[]
    expect(v.every((t) => t === "undefined")).toBe(true)
  }
})

test("scrubbed globals cannot be restored, deleted or re-defined", async () => {
  expect(await probe(`(() => {
    const out = []
    for (const k of ["fetch", "postMessage", "Worker"]) {
      try { delete self[k]; Object.defineProperty(self, k, { value: () => 1 }); out.push("redefined") } catch { out.push("blocked") }
      out.push(typeof self[k])
    }
    return out
  })()`)).toEqual(["blocked", "undefined", "blocked", "undefined", "blocked", "undefined"])
})

test("a query cannot forge protocol messages (postMessage and onmessage are not reachable)", async () => {
  expect(await probe(`typeof postMessage`)).toBe("undefined")
  expect(await probe(`(() => { try { self.postMessage({ type: "pong" }) ; return "sent" } catch { return "blocked" } })()`)).toBe("blocked")
})

test("a runaway top-level loop times out and the next query still runs", async () => {
  expect(await failure("while (true) {}", 300)).toMatch(/timed out/)
  expect((await resultOf("Math.max(1, 2)")).rows).toEqual([[2]])
})

test("a runaway promise loop times out", async () => {
  expect(await failure("(async () => { while (true) { await null } })()", 300)).toMatch(/timed out/)
  expect((await resultOf("Math.max(3, 1)")).rows).toEqual([[3]])
})

test("timers left behind by a query are cleared when the run ends", async () => {
  await resultOf(`(globalThis as any).__n = 0; setInterval(() => { (globalThis as any).__n++ }, 1); 1`)
  await Bun.sleep(50)
  const a = await probe("globalThis.__n")
  await Bun.sleep(50)
  expect(await probe("globalThis.__n")).toBe(a)
})

test("huge allocations fail with a RangeError instead of exhausting memory", async () => {
  const gb = 1024 ** 3
  for (const js of [
    `new ArrayBuffer(${4 * gb})`,
    `new Float64Array(${gb})`,
    `new Uint8Array(${LIMITS.maxAllocBytes + 1})`,
    `new (new Uint8Array(1).constructor)(${4 * gb})`,
    `new (new ArrayBuffer(1).constructor)(${4 * gb})`,
    `Float32Array.from({ length: ${gb} })`,
    `"x".repeat(${LIMITS.maxAllocBytes + 1})`,
    `"x".padStart(${LIMITS.maxAllocBytes + 1})`
  ]) {
    expect(await failure(js, 10_000)).toMatch(/exceeds the sandbox limit/)
  }
  // Reasonable allocations still work, and still behave as typed arrays.
  expect(await probe(`(() => { const a = new Float32Array(1000); a[3] = 2; return [a instanceof Float32Array, Array.isArray(Array.from(a)), a[3], Float32Array.from([1, 2]).length, new Float32Array(new ArrayBuffer(8)).length] })()`)).toEqual([true, true, 2, 2, 2])
})

test("a result with more than the row cap is cut in the worker and reported", async () => {
  const total = LIMITS.maxRows + 500
  const r = await resultOf(`Array.from({ length: ${total} }, (_, i) => i)`)
  expect(r.rows.length).toBe(LIMITS.maxRows)
  expect(r.stats.rowCount).toBe(LIMITS.maxRows)
  expect(r.warnings.some((w) => w.includes(`${LIMITS.maxRows} of ${total} rows`))).toBe(true)
})

test("a result with too many values fails with a clear message", async () => {
  const msg = await failure(`Array.from({ length: 90_000 }, () => Array.from({ length: 80 }, (_, j) => j))`)
  expect(msg).toMatch(/too large/i)
  expect((await resultOf("Math.max(1, 0)")).rows).toEqual([[1]])
})

test("a nested or circular result is bounded, not exploded", async () => {
  const circ = await resultOf(`const a: any = { n: 1 }; a.self = a; Array.of(a)`)
  expect(circ.rows.length).toBe(1)
  // A DAG with 2^40 paths: depth limit keeps it small.
  const dag = await resultOf(`let x: any = [1]; for (let i = 0; i < 40; i++) x = [x, x]; Array.of({ x })`)
  expect(dag.rows.length).toBe(1)
})

test("thrown values, throwing getters and hostile toArray surface as errors", async () => {
  expect(await failure(`throw { toString() { throw new Error("nested") } }`, 5000)).toMatch(/cannot be converted/)
  expect(await failure(`Array.of({ get x() { throw new Error("getter") } })`)).toMatch(/getter/)
  expect(await failure(`Array.of({ toArray() { throw new Error("toArray") } })`)).toMatch(/toArray/)
  expect((await resultOf("Math.max(2, 1)")).rows).toEqual([[2]])
})
