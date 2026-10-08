/**
 * What a query run can be told from outside: cancel it, bound it, watch it. A query runs synchronously inside a worker,
 * so an `AbortSignal` cannot fire mid-run there; the runner passes `shouldCancel` (for example a read of a shared
 * `Int32Array` flag set from the main thread) and/or a time budget, and the library polls them in its loops.
 * @category Run
 */
export interface RunOptions {
  /** Aborted signal stops the run at the next check. */
  readonly signal?: AbortSignal
  /** Polled at checks; return true to stop the run (works while the worker is busy, unlike a signal). */
  readonly shouldCancel?: () => boolean
  /** Wall-clock budget in milliseconds for the whole run; exceeding it stops the run with {@link QueryCancelled}. */
  readonly maxMillis?: number
  /** Receives `progress(fraction)` calls from the query and from long library operations. */
  readonly onProgress?: (fraction: number, label?: string) => void
}

/**
 * Thrown (as an `AbortError`) when a run is cancelled or runs out of time.
 * @example try { run() } catch (e) { if (e instanceof QueryCancelled) console.log(e.reason) }
 * @category Run
 */
export class QueryCancelled extends Error {
  override readonly name = "AbortError"
  constructor(readonly reason: "cancelled" | "timeout") {
    super(reason === "timeout" ? "query exceeded its time budget" : "query cancelled")
  }
}

interface Active { readonly opts: RunOptions; readonly deadline: number }
let active: Active | undefined
let tick = 0

/**
 * Runs `f` with cancellation, budget and progress hooks in force (nested runs are restored on exit).
 * @example withRun({ maxMillis: 5000 }, () => map.sample.grid(100).count())
 * @category Run
 */
export const withRun = <T>(opts: RunOptions, f: () => T): T => {
  const prev = active
  active = { opts, deadline: opts.maxMillis === undefined ? Infinity : Date.now() + opts.maxMillis }
  try { checkCancelled(true); return f() } finally { active = prev }
}

/** Throws {@link QueryCancelled} when the active run was cancelled or is over budget. Cheap: the clock is read every 256th call unless `force`. @internal */
export const checkCancelled = (force = false): void => {
  const a = active
  if (!a) return
  if (!force && (++tick & 255) !== 0 && !a.opts.signal?.aborted) return
  if (a.opts.signal?.aborted || a.opts.shouldCancel?.()) throw new QueryCancelled("cancelled")
  if (a.deadline !== Infinity && Date.now() > a.deadline) throw new QueryCancelled("timeout")
}

/** The signal of the active run, if any. @internal */
export const activeSignal = (): AbortSignal | undefined => active?.opts.signal

/**
 * Report progress of the query as a fraction from 0 to 1 (ignored when nobody is listening); also a cancellation point.
 * @example progress(0.5)
 * @category Run
 */
export const progress = (fraction: number, label?: string): void => {
  checkCancelled(true)
  active?.opts.onProgress?.(Math.min(1, Math.max(0, fraction)), label)
}

/**
 * Options for {@link ctx}`.parallel`.
 * @category Run
 */
export interface ParallelOptions {
  /** Items per chunk (default 256). Chunks are fixed slices by input index, so output order equals the sequential run. */
  readonly chunk?: number
  /** Read-only constants passed to `fn` as its second argument (structured-clone friendly, for worker backends). */
  readonly args?: unknown
}

/**
 * Runs chunks of work somewhere else (a worker pool). The query-builder installs one with {@link setParallelBackend};
 * without one, `ctx.parallel` runs the chunks in order on the current thread.
 * @category Run
 */
export interface ParallelBackend {
  /** Maps one chunk; `fnSource` is `fn.toString()` and `fn` is the same function for in-thread backends. */
  runChunk<T, R>(chunk: readonly T[], fn: (item: T, args: unknown) => R, fnSource: string, args: unknown): Promise<R[]>
}

let backend: ParallelBackend | undefined

/**
 * Installs (or clears, with `undefined`) the worker-pool backend used by `ctx.parallel`.
 * @example setParallelBackend(undefined)
 * @category Run
 */
export const setParallelBackend = (b: ParallelBackend | undefined): void => { backend = b }

const chunksOf = <T>(items: readonly T[], size: number): T[][] => {
  const n = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}

const parallelMap = async <T, R>(items: Iterable<T>, fn: (item: T, args: unknown) => R, opts: ParallelOptions = {}): Promise<R[]> => {
  const all = Array.isArray(items) ? items as readonly T[] : [...items]
  const chunks = chunksOf(all, opts.chunk ?? 256)
  const out: R[] = []
  const src = fn.toString()
  // `withRun` has returned by the time we resume after an await, so re-enter the run captured at the call.
  const run = active
  const inRun = <V>(f: () => V): V => { const prev = active; active = run; try { return f() } finally { active = prev } }
  for (let i = 0; i < chunks.length; i++) {
    inRun(() => checkCancelled(true))
    const c = chunks[i]!
    const part = backend ? await backend.runChunk(c, fn, src, opts.args) : c.map(x => fn(x, opts.args))
    for (const r of part) out.push(r)
    inRun(() => active?.opts.onProgress?.((i + 1) / chunks.length, "parallel"))
  }
  inRun(() => checkCancelled(true))
  return out
}

const parallelReduce = async <T, R, A>(items: Iterable<T>, fn: (item: T, args: unknown) => R, combine: (acc: A, r: R) => A, init: A, opts?: ParallelOptions): Promise<A> =>
  (await parallelMap(items, fn, opts)).reduce(combine, init)

/**
 * The run's context (`ctx` in queries): its signal, `progress`, and `parallel`.
 * @example ctx.progress(0.25)
 * @category Run
 */
export const ctx = {
  get signal(): AbortSignal | undefined { return activeSignal() },
  progress,
  /**
   * Shards work over input chunks: `map` returns results in input order, `reduce` folds them in that order. Output equals
   * the sequential run. `fn` must be a pure function of its item and the loaded map (no closures) so a worker backend can
   * re-evaluate it; pass constants through `opts.args`. Without a backend it runs the chunks in order on this thread.
   * @example await ctx.parallel.map([1, 2, 3], x => x * 2)
   */
  parallel: { map: parallelMap, reduce: parallelReduce },
  /** True when the run was asked to stop; queries with their own long loops can poll it instead of waiting for a library call to throw. */
  get cancelled(): boolean { try { checkCancelled(true); return false } catch { return true } }
} as const
