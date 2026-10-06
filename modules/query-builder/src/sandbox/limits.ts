/** Hard limits enforced inside the query Worker (see `worker-source.ts`) and again on the main thread. */
export const LIMITS = {
  /** Rows kept from a top-level array result; the rest is dropped inside the worker and reported as a warning. */
  maxRows: 100_000,
  /** Total values the result may contain (cells, nested values, strings weighted by length) before the run is failed. */
  maxResultNodes: 5_000_000,
  /** Largest single ArrayBuffer / typed array / repeated string a query may allocate, in bytes (chars for strings). */
  maxAllocBytes: 256 * 1024 * 1024
} as const

export type Limits = typeof LIMITS
