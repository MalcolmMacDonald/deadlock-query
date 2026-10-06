import { QueryEngine, type QueryDiagnostic, type QueryOutput } from "@deadlock-query/contracts"
import { Effect, Layer, Stream } from "effect"
import type { RunOutcome } from "../sandbox/runner.ts"
import { LIMITS } from "../sandbox/limits.ts"
import { projectResult } from "./project.ts"

/** Type-checks and transpiles query source. Monaco's TS worker in the app; Bun's transpiler in unit tests. */
export interface Compiler {
  readonly compile: (source: string) => Promise<{ readonly js: string; readonly diagnostics: ReadonlyArray<QueryDiagnostic> }>
}

/** Executes compiled JS in the sandbox. `SandboxRunner` in the app; a plain Worker in unit tests. */
export interface Runner {
  readonly run: (js: string, opts: { timeoutMs?: number }) => Promise<RunOutcome>
  readonly cancel: () => Promise<void>
}

export const DEFAULT_TIMEOUT_MS = 30_000

export class QueryFailed extends Error {
  readonly _tag = "QueryFailed"
  constructor(message: string, readonly reason: "diagnostics" | "error" | "cancelled" | "timeout", readonly diagnostics: ReadonlyArray<QueryDiagnostic> = []) {
    super(message)
  }
}

const formatDiagnostic = (d: QueryDiagnostic): string => `${d.line}:${d.column} ${d.message}`

/** The real `QueryEngine`: check → emit → run in the sandbox → project to a `QueryResult`. */
export const makeQueryEngine = (deps: { compiler: Compiler; runner: Runner }): Layer.Layer<QueryEngine> => {
  // Shared by every provision of the layer, so `cancel` reaches a `run` started under another `provide`.
  let status: "idle" | "compiling" | "running" = "idle"
  let epoch = 0 // bumped by cancel, so a cancel that lands during compilation still stops the run
  return Layer.sync(QueryEngine)(() => {
    return {
      status: Effect.sync(() => status),
      check: (source) => Effect.promise(() => deps.compiler.compile(source).then((c) => c.diagnostics)),
      cancel: Effect.promise(() => { epoch++; return deps.runner.cancel() }),
      run: (source, opts) =>
        Stream.fromEffect(
          Effect.tryPromise({
            try: async (): Promise<QueryOutput> => {
              const t0 = performance.now()
              const myEpoch = epoch
              status = "compiling"
              try {
                const { js, diagnostics } = await deps.compiler.compile(source)
                const errors = diagnostics.filter((d) => d.severity === "error")
                if (errors.length > 0) {
                  throw new QueryFailed(errors.map(formatDiagnostic).join("\n"), "diagnostics", diagnostics)
                }
                if (epoch !== myEpoch) throw new QueryFailed("Query cancelled.", "cancelled")
                const compileMs = performance.now() - t0
                status = "running"
                const out = await deps.runner.run(js, { timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS })
                if (!out.ok) {
                  const message =
                    out.reason === "timeout" ? `Query timed out after ${(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s and was stopped.`
                    : out.reason === "cancelled" ? "Query cancelled."
                    : out.message
                  throw new QueryFailed(message, out.reason)
                }
                const warnings = diagnostics.map((d) => `${formatDiagnostic(d)} (${d.severity})`)
                if (out.totalRows !== undefined) warnings.push(`Result truncated to ${LIMITS.maxRows} of ${out.totalRows} rows.`)
                return {
                  _tag: "result",
                  result: projectResult(out.value, { compileMs: Math.round(compileMs), runMs: Math.round(out.ms) }, warnings)
                }
              } finally {
                status = "idle"
              }
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e)))
          })
        )
    }
  })
}
