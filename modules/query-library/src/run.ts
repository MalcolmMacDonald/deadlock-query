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
 * The run's context (`ctx` in queries): its signal, and `progress`.
 * @example ctx.progress(0.25)
 * @category Run
 */
export const ctx = {
  get signal(): AbortSignal | undefined { return activeSignal() },
  progress,
  /** True when the run was asked to stop; queries with their own long loops can poll it instead of waiting for a library call to throw. */
  get cancelled(): boolean { try { checkCancelled(true); return false } catch { return true } }
} as const
