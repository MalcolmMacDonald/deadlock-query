import { decodeTileGlb, type WorkerReply, type WorkerRequest } from "./tileDecode.ts"

/** Tile decode worker: GLB bytes in, merged geometry out (both transferred, no copies). */
const scope = globalThis as unknown as {
  onmessage: ((e: { data: WorkerRequest }) => void) | null
  postMessage(msg: WorkerReply, transfer?: Transferable[]): void
}

scope.onmessage = async (e) => {
  const { id, bytes } = e.data
  try {
    const d = await decodeTileGlb(bytes)
    scope.postMessage({ id, ok: true, positions: d.positions, indices: d.indices, colors: d.colors }, [d.positions.buffer, d.indices.buffer, ...(d.colors ? [d.colors.buffer] : [])])
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String(err) })
  }
}
