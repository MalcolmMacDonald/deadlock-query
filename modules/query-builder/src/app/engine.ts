import { MockQueryEngine, QueryEngine, type QueryOutput, type QueryResult } from "@deadlock-query/contracts"
import { Effect, Layer, Stream } from "effect"

export type EngineLayer = Layer.Layer<QueryEngine>

/** Collects a `QueryEngine.run` stream into progress messages plus the final result. */
export const runQuery = async (layer: EngineLayer, source: string, opts?: { timeoutMs?: number }) => {
  const outputs = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* QueryEngine
      return yield* Stream.runCollect(engine.run(source, opts))
    }).pipe(Effect.provide(layer))
  )
  const all = Array.from(outputs as Iterable<QueryOutput>)
  const result = [...all].reverse().find((o): o is Extract<QueryOutput, { _tag: "result" }> => o._tag === "result")?.result
  if (!result) throw new Error("query produced no result")
  return { result: result as QueryResult, progress: all.filter((o) => o._tag === "progress") }
}

export const mockEngineLayer: EngineLayer = MockQueryEngine
