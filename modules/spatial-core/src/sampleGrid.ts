import type { Aabb, Vec3 } from "@deadlock-query/contracts"
import type { Raycaster } from "./raycaster.ts"

export type ChannelType = "f32" | "u8"
export interface CellCtx {
  readonly rc: Raycaster
  readonly ix: number
  readonly iy: number
  /** Cell centre in world XY. */
  readonly x: number
  readonly y: number
  /** Built-in `floorHeight` for this cell; NaN when nothing is below. */
  readonly floorZ: number
}
export type ChannelGen = (cell: CellCtx) => number
export type ChannelSpec = ChannelGen | { readonly type?: ChannelType; readonly gen: ChannelGen }
export interface BuildOpts {
  readonly signal?: AbortSignal
  readonly onProgress?: (done: number, total: number) => void
}

export const FLOOR_HEIGHT = "floorHeight"
const MAGIC = 0x31475344 // "DSG1"
const VERSION = 1

type Channel = { type: ChannelType; data: Float32Array | Uint8Array }

/** Generic 2-D grid over the XY bounds of a map with named channels. */
export class SampleGrid {
  private constructor(
    readonly origin: readonly [number, number],
    readonly cellSize: number,
    readonly nx: number,
    readonly ny: number,
    private readonly channels: ReadonlyMap<string, Channel>
  ) {}

  get channelNames(): string[] { return [...this.channels.keys()] }

  /**
   * Samples every cell. `floorHeight` (downward ray from above the bounds) is always included
   * and passed to generators as `cell.floorZ`; owner functions are plain channel generators.
   */
  static build(rc: Raycaster, bounds: Aabb, cellSize: number, channels: Record<string, ChannelSpec> = {}, opts: BuildOpts = {}): SampleGrid {
    if (!(cellSize > 0)) throw new Error("cellSize must be > 0")
    const nx = Math.max(1, Math.ceil((bounds.max[0] - bounds.min[0]) / cellSize))
    const ny = Math.max(1, Math.ceil((bounds.max[1] - bounds.min[1]) / cellSize))
    const total = nx * ny
    const names = Object.keys(channels).sort()
    if (names.includes(FLOOR_HEIGHT)) throw new Error(`"${FLOOR_HEIGHT}" is built in`)
    const specs = names.map((n) => {
      const s = channels[n]!
      return typeof s === "function" ? { type: "f32" as ChannelType, gen: s } : { type: s.type ?? "f32", gen: s.gen }
    })
    const floor = new Float32Array(total)
    const outs = specs.map((s) => (s.type === "u8" ? new Uint8Array(total) : new Float32Array(total)))
    const top = bounds.max[2] + 1
    const down: Vec3 = [0, 0, -1]
    for (let iy = 0; iy < ny; iy++) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix
        const x = bounds.min[0] + (ix + 0.5) * cellSize, y = bounds.min[1] + (iy + 0.5) * cellSize
        const h = rc.raycastFirst([x, y, top], down, { backfaces: true })
        const floorZ = h ? h.point[2] : NaN
        floor[i] = floorZ
        const cell: CellCtx = { rc, ix, iy, x, y, floorZ }
        for (let c = 0; c < specs.length; c++) outs[c]![i] = specs[c]!.gen(cell)
      }
      opts.onProgress?.((iy + 1) * nx, total)
    }
    const map = new Map<string, Channel>([[FLOOR_HEIGHT, { type: "f32", data: floor }]])
    names.forEach((n, c) => map.set(n, { type: specs[c]!.type, data: outs[c]! }))
    return new SampleGrid([bounds.min[0], bounds.min[1]], cellSize, nx, ny, map)
  }

  private index(p: Vec3 | readonly [number, number]): number {
    const ix = Math.floor((p[0] - this.origin[0]) / this.cellSize)
    const iy = Math.floor((p[1] - this.origin[1]) / this.cellSize)
    return ix < 0 || iy < 0 || ix >= this.nx || iy >= this.ny ? -1 : iy * this.nx + ix
  }

  /** Value of the cell containing `p` (XY only), or null outside the grid. */
  get(channel: string, p: Vec3 | readonly [number, number]): number | null {
    const ch = this.channels.get(channel)
    if (!ch) throw new Error(`unknown channel "${channel}"`)
    const i = this.index(p)
    return i < 0 ? null : ch.data[i]!
  }

  raw(channel: string): Float32Array | Uint8Array {
    const ch = this.channels.get(channel)
    if (!ch) throw new Error(`unknown channel "${channel}"`)
    return ch.data
  }

  /** Header (magic, version, nx, ny, channels), f64 origin x/y/cellSize, then per channel: nameLen, name, type, padded data. */
  serialize(): ArrayBuffer {
    const enc = new TextEncoder()
    const names = [...this.channels.keys()]
    const pad = (n: number) => (n + 3) & ~3
    let size = 20 + 24
    for (const n of names) {
      const ch = this.channels.get(n)!
      size += pad(2 + enc.encode(n).length) + pad(ch.data.byteLength)
    }
    const buf = new ArrayBuffer(size)
    const dv = new DataView(buf)
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, VERSION, true)
    dv.setUint32(8, this.nx, true); dv.setUint32(12, this.ny, true); dv.setUint32(16, names.length, true)
    dv.setFloat64(20, this.origin[0], true); dv.setFloat64(28, this.origin[1], true); dv.setFloat64(36, this.cellSize, true)
    let o = 44
    for (const n of names) {
      const ch = this.channels.get(n)!, nb = enc.encode(n)
      dv.setUint8(o, nb.length); dv.setUint8(o + 1, ch.type === "u8" ? 1 : 0)
      new Uint8Array(buf, o + 2, nb.length).set(nb)
      o += pad(2 + nb.length)
      new Uint8Array(buf, o, ch.data.byteLength).set(new Uint8Array(ch.data.buffer, ch.data.byteOffset, ch.data.byteLength))
      o += pad(ch.data.byteLength)
    }
    return buf
  }

  static deserialize(bytes: ArrayBuffer): SampleGrid {
    const dv = new DataView(bytes)
    if (dv.getUint32(0, true) !== MAGIC) throw new Error("not a SampleGrid")
    if (dv.getUint32(4, true) !== VERSION) throw new Error("unsupported SampleGrid version")
    const nx = dv.getUint32(8, true), ny = dv.getUint32(12, true), count = dv.getUint32(16, true)
    const origin: [number, number] = [dv.getFloat64(20, true), dv.getFloat64(28, true)]
    const cellSize = dv.getFloat64(36, true)
    const dec = new TextDecoder()
    const pad = (n: number) => (n + 3) & ~3
    const map = new Map<string, Channel>()
    let o = 44
    for (let k = 0; k < count; k++) {
      const len = dv.getUint8(o), type: ChannelType = dv.getUint8(o + 1) === 1 ? "u8" : "f32"
      const name = dec.decode(new Uint8Array(bytes, o + 2, len))
      o += pad(2 + len)
      const n = nx * ny, nbytes = type === "u8" ? n : n * 4
      const data = type === "u8" ? new Uint8Array(bytes.slice(o, o + nbytes)) : new Float32Array(bytes.slice(o, o + nbytes))
      map.set(name, { type, data })
      o += pad(nbytes)
    }
    return new SampleGrid(origin, cellSize, nx, ny, map)
  }
}
