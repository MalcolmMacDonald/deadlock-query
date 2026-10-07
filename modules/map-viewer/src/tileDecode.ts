import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js"

/** Geometry of one render tile, merged into one indexed mesh in GLB-local space (the tile holder applies the transform). */
export interface DecodedTile {
  readonly positions: Float32Array
  readonly indices: Uint16Array | Uint32Array
  /** Per-vertex RGBA8 (`COLOR_0`, linear), 4 bytes per vertex; absent when the tile (or any of its meshes) has no colour. */
  readonly colors?: Uint8Array | undefined
}

export const decodedBytes = (d: DecodedTile): number => d.positions.byteLength + d.indices.byteLength + (d.colors?.byteLength ?? 0)

/**
 * Parses a tile GLB (plain or EXT_meshopt_compression + KHR_mesh_quantization) and merges all its meshes. Node
 * transforms, including the dequantisation scale, are baked into the positions. Textures and materials are dropped:
 * the viewer draws every tile with one material (the vertex colours, when the tile has them, carry the look). Runs on
 * the main thread or inside the decode worker.
 */
export const decodeTileGlb = (bytes: Uint8Array): Promise<DecodedTile> => {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  return new Promise((resolve, reject) => loader.parse(buf, "", (gltf) => {
    try {
      gltf.scene.updateMatrixWorld(true)
      const meshes: THREE.Mesh[] = []
      gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
      let vertices = 0, indexCount = 0
      for (const m of meshes) {
        const pos = m.geometry.getAttribute("position")
        if (!pos) continue
        vertices += pos.count
        indexCount += m.geometry.index ? m.geometry.index.count : pos.count
      }
      const positions = new Float32Array(vertices * 3)
      // Colours only when every mesh has them: a half-coloured tile would draw the rest black.
      const withColor = meshes.length > 0 && meshes.every((m) => !m.geometry.getAttribute("position") || m.geometry.getAttribute("color") !== undefined)
      const colors = withColor ? new Uint8Array(vertices * 4) : undefined
      const indices = vertices > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
      const v = new THREE.Vector3()
      let vo = 0, io = 0, base = 0, co = 0
      for (const m of meshes) {
        const pos = m.geometry.getAttribute("position")
        if (!pos) continue
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
          positions[vo++] = v.x; positions[vo++] = v.y; positions[vo++] = v.z
        }
        if (colors) {
          const col = m.geometry.getAttribute("color")!
          const raw = col.array
          if (!(col as THREE.BufferAttribute).isBufferAttribute || !(raw instanceof Uint8Array) || !col.normalized || col.itemSize !== 4) {
            // Anything but tightly packed normalised RGBA8 (e.g. float or RGB colours from another exporter) goes through the generic path.
            const f = col.normalized || raw instanceof Float32Array ? 255 : 1
            const q = (x: number) => Math.max(0, Math.min(255, Math.round(x * f)))
            for (let i = 0; i < pos.count; i++) {
              const o = (co + i) * 4
              colors[o] = q(col.getX(i)); colors[o + 1] = q(col.getY(i)); colors[o + 2] = q(col.getZ(i)); colors[o + 3] = col.itemSize === 4 ? q(col.getW(i)) : 255
            }
          } else colors.set(raw.subarray(0, pos.count * 4), co * 4)
          co += pos.count
        }
        const idx = m.geometry.index
        const n = idx ? idx.count : pos.count
        for (let i = 0; i < n; i++) indices[io++] = base + (idx ? idx.getX(i) : i)
        base += pos.count
        m.geometry.dispose()
      }
      resolve({ positions, indices: indices.subarray(0, io - (io % 3)), ...(colors ? { colors } : {}) })
    } catch (e) { reject(e) }
  }, reject))
}

/** Where tile bytes get decoded. */
export interface TileDecoder {
  readonly decode: (bytes: Uint8Array) => Promise<DecodedTile>
  readonly dispose: () => void
}

export const inlineDecoder = (): TileDecoder => ({ decode: decodeTileGlb, dispose: () => {} })

/** Worker wire format (see `tileWorker.ts`). */
export type WorkerRequest = { readonly id: number; readonly bytes: Uint8Array }
export type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly positions: Float32Array; readonly indices: Uint16Array | Uint32Array; readonly colors?: Uint8Array | undefined }
  | { readonly id: number; readonly ok: false; readonly error: string }

/** The slice of `Worker` the pool uses, so tests can stand in a fake. */
export interface WorkerLike {
  postMessage(msg: WorkerRequest, transfer: Transferable[]): void
  terminate(): void
  onmessage: ((e: { data: WorkerReply }) => void) | null
  onerror: ((e: unknown) => void) | null
}

/**
 * Decodes in `size` workers (round robin by load). A worker that fails to start or dies falls back to decoding on the
 * calling thread, so a deployment where workers cannot load still shows the map, only with hitching.
 */
export const workerDecoder = (createWorker: () => WorkerLike, size = 2): TileDecoder => {
  const pending = new Map<number, { resolve: (d: DecodedTile) => void; reject: (e: unknown) => void; worker: number }>()
  let next = 0
  let broken = false
  const load: number[] = []
  const workers: WorkerLike[] = []
  const fail = (err: unknown) => {
    broken = true
    for (const [, p] of pending) p.reject(err)
    pending.clear()
    for (const w of workers) w.terminate()
  }
  try {
    for (let i = 0; i < Math.max(1, size); i++) {
      const w = createWorker()
      w.onmessage = (e) => {
        const r = e.data
        const p = pending.get(r.id)
        if (!p) return
        pending.delete(r.id)
        load[p.worker]!--
        if (r.ok) p.resolve({ positions: r.positions, indices: r.indices, ...(r.colors ? { colors: r.colors } : {}) })
        else p.reject(new Error(r.error))
      }
      w.onerror = (e) => fail(e)
      workers.push(w)
      load.push(0)
    }
  } catch (err) {
    fail(err)
  }
  return {
    decode: (bytes) => {
      if (broken) return decodeTileGlb(bytes)
      const id = next++
      let worker = 0
      for (let i = 1; i < workers.length; i++) if (load[i]! < load[worker]!) worker = i
      return new Promise<DecodedTile>((resolve, reject) => {
        pending.set(id, { resolve, reject, worker })
        load[worker]!++
        // The bytes are copied (not transferred): the caller may still hold them.
        const copy = bytes.slice()
        workers[worker]!.postMessage({ id, bytes: copy }, [copy.buffer])
      }).catch((err) => (broken ? decodeTileGlb(bytes) : Promise.reject(err)))
    },
    dispose: () => {
      for (const w of workers) w.terminate()
      for (const [, p] of pending) p.reject(new Error("decoder disposed"))
      pending.clear()
      broken = true
    }
  }
}
