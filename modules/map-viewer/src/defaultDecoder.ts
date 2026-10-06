import { inlineDecoder, workerDecoder, type TileDecoder, type WorkerLike } from "./tileDecode.ts"

export const DEFAULT_DECODE_WORKERS = 2

/**
 * Decoder used when the host does not provide one: a small pool of module workers (bundlers pick up the
 * `new Worker(new URL(...))` form), or decoding on the calling thread where `Worker` does not exist (tests, SSR).
 */
export const defaultDecoder = (workers = DEFAULT_DECODE_WORKERS): TileDecoder => {
  if (typeof Worker === "undefined" || workers <= 0) return inlineDecoder()
  return workerDecoder(() => new Worker(new URL("./tileWorker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike, workers)
}
