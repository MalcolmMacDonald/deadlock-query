/**
 * Minimal reader for binary KeyValues3, version 5, uncompressed (`KV3\x05`, compression method 0): what `.navflowmap` files use.
 * Ported from the layout in ValveResourceFormat's `BinaryKV3` (MIT); compressed blocks, binary blobs and older versions are
 * rejected with a clear error instead of being decoded.
 */

export type Kv3Value = null | boolean | number | string | Kv3Value[] | { [key: string]: Kv3Value }

export class Kv3Error extends Error {
  readonly _tag = "Kv3Error"
  constructor(message: string) { super(message) }
}

const MAGIC_V5 = 0x4b563305
const TRAILER = 0xffeedd00

// Node types (BinaryKV3.NodeType).
const T = {
  NULL: 1, BOOLEAN: 2, INT64: 3, UINT64: 4, DOUBLE: 5, STRING: 6, BINARY_BLOB: 7, ARRAY: 8, OBJECT: 9, ARRAY_TYPED: 10, INT32: 11,
  UINT32: 12, BOOLEAN_TRUE: 13, BOOLEAN_FALSE: 14, INT64_ZERO: 15, INT64_ONE: 16, DOUBLE_ZERO: 17, DOUBLE_ONE: 18, FLOAT: 19,
  INT16: 20, UINT16: 21, INT8: 22, UINT8: 23, ARRAY_TYPE_BYTE_LENGTH: 24, ARRAY_TYPE_AUXILIARY_BUFFER: 25
} as const

class Lane {
  constructor(private readonly dv: DataView, private off: number, private readonly end: number) {}
  private take(n: number): number {
    const o = this.off
    if (o + n > this.end) throw new Kv3Error("binary KV3 lane exhausted: corrupt or unsupported data")
    this.off += n
    return o
  }
  u8() { return this.dv.getUint8(this.take(1)) }
  i8() { return this.dv.getInt8(this.take(1)) }
  u16() { return this.dv.getUint16(this.take(2), true) }
  i16() { return this.dv.getInt16(this.take(2), true) }
  u32() { return this.dv.getUint32(this.take(4), true) }
  i32() { return this.dv.getInt32(this.take(4), true) }
  f32() { return this.dv.getFloat32(this.take(4), true) }
  i64() { return Number(this.dv.getBigInt64(this.take(8), true)) }
  u64() { return Number(this.dv.getBigUint64(this.take(8), true)) }
  f64() { return this.dv.getFloat64(this.take(8), true) }
  get position() { return this.off }
}

interface Lanes { bytes1: Lane; bytes2: Lane; bytes4: Lane; bytes8: Lane }

const align = (o: number, a: number) => (o + a - 1) & ~(a - 1)

/** Parses one binary KV3 block starting at `offset`; returns the value and the offset just past the block. */
export const parseKv3 = (bytes: Uint8Array, offset = 0): { value: Kv3Value; end: number } => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerSize = 4 + 16 + 25 * 4
  if (offset + headerSize > bytes.byteLength) throw new Kv3Error("KV3 block truncated")
  if (dv.getUint32(offset, true) !== MAGIC_V5) throw new Kv3Error("unsupported KV3: only binary version 5 is read")
  let p = offset + 20
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v }
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v }
  const method = u32()
  if (method !== 0) throw new Kv3Error(`unsupported KV3: compression method ${method} (only uncompressed blocks are read)`)
  p += 4 // dictionary id + frame size
  const countBytes1 = i32(), countBytes4 = i32(), countBytes8 = i32(), countTypes = i32()
  p += 4 // object and array counts (allocation hints)
  i32() /* sizeUncompressedTotal */; i32() /* sizeCompressedTotal */
  const countBlocks = i32(); i32() /* sizeBinaryBlobsBytes */
  if (countBlocks > 0) throw new Kv3Error("unsupported KV3: binary blobs")
  const countBytes2 = i32(); i32() /* sizeBlockCompressedSizesBytes */
  const size1 = i32(); i32() /* compressed 1 */; const size2 = i32(); i32() /* compressed 2 */
  const b2c1 = i32(), b2c2 = i32(), b2c4 = i32(), b2c8 = i32()
  i32(); const countObjects2 = i32(); i32(); i32() // nodes, objects, arrays, array elements
  if (p !== offset + headerSize) throw new Kv3Error("KV3 header parse error")
  const b1 = p, b2 = p + size1
  if (b2 + size2 > bytes.byteLength) throw new Kv3Error("KV3 block truncated")

  // Lanes of one buffer: byte lane, then 2, 4 and 8 byte lanes, each aligned to its element size when non-empty (version 5).
  const lanesOf = (base: number, c1: number, c2: number, c4: number, c8: number, skip = 0): { lanes: Lanes; end: number } => {
    let o = skip
    const take = (count: number, size: number): Lane => {
      if (count > 0) o = align(o, size)
      const l = new Lane(dv, base + o, base + o + count * size)
      o += count * size
      return l
    }
    const bytes1 = take(c1, 1), bytes2 = take(c2, 2), bytes4 = take(c4, 4), bytes8 = take(c8, 8)
    return { lanes: { bytes1, bytes2, bytes4, bytes8 }, end: o }
  }

  // Buffer 1: auxiliary lanes plus the string table.
  const lanes1 = lanesOf(b1, countBytes1, countBytes2, countBytes4, countBytes8).lanes
  const countStrings = lanes1.bytes4.u32()
  const strings: string[] = []
  {
    let s = lanes1.bytes1.position
    const dec = new TextDecoder()
    for (let i = 0; i < countStrings; i++) {
      let e = s
      while (e < b1 + countBytes1 && bytes[e] !== 0) e++
      strings.push(dec.decode(bytes.subarray(s, e)))
      s = e + 1
    }
  }

  // Buffer 2: object lengths, the main lanes, then the node types.
  const objectLengths = new Lane(dv, b2, b2 + countObjects2 * 4)
  const { lanes: main, end: lanesEnd } = lanesOf(b2, b2c1, b2c2, b2c4, b2c8, countObjects2 * 4)
  let o = lanesEnd
  const types = new Lane(dv, b2 + o, b2 + o + countTypes); o += countTypes
  if (dv.getUint32(b2 + o, true) !== TRAILER) throw new Kv3Error("KV3 trailer missing: unsupported layout")

  const str = (id: number) => (id >= 0 && id < strings.length ? strings[id]! : "")
  const readType = (): number => {
    const d = types.u8()
    if (d & 0x80) types.u8() // flag byte (resource, subclass, ...)
    if (d & 0x40) types.u8()
    return d & 0x3f
  }
  const readValue = (type: number, lane: Lanes): Kv3Value => {
    switch (type) {
      case T.NULL: return null
      case T.BOOLEAN_TRUE: return true
      case T.BOOLEAN_FALSE: return false
      case T.INT64_ZERO: return 0
      case T.INT64_ONE: return 1
      case T.DOUBLE_ZERO: return 0
      case T.DOUBLE_ONE: return 1
      case T.BOOLEAN: return lane.bytes1.u8() !== 0
      case T.INT8: return lane.bytes1.i8()
      case T.UINT8: return lane.bytes1.u8()
      case T.INT16: return lane.bytes2.i16()
      case T.UINT16: return lane.bytes2.u16()
      case T.INT32: return lane.bytes4.i32()
      case T.UINT32: return lane.bytes4.u32()
      case T.FLOAT: return lane.bytes4.f32()
      case T.INT64: return lane.bytes8.i64()
      case T.UINT64: return lane.bytes8.u64()
      case T.DOUBLE: return lane.bytes8.f64()
      case T.STRING: return str(main.bytes4.i32())
      case T.ARRAY: {
        const n = main.bytes4.i32()
        const out: Kv3Value[] = new Array(n)
        for (let i = 0; i < n; i++) out[i] = readValue(readType(), main)
        return out
      }
      case T.ARRAY_TYPED:
      case T.ARRAY_TYPE_BYTE_LENGTH:
      case T.ARRAY_TYPE_AUXILIARY_BUFFER: {
        const n = type === T.ARRAY_TYPED ? main.bytes4.i32() : main.bytes1.u8()
        const sub = readType()
        const el = type === T.ARRAY_TYPE_AUXILIARY_BUFFER ? lanes1 : main
        const out: Kv3Value[] = new Array(n)
        for (let i = 0; i < n; i++) out[i] = readValue(sub, el)
        return out
      }
      case T.OBJECT: {
        const n = objectLengths.i32()
        const out: { [key: string]: Kv3Value } = {}
        for (let i = 0; i < n; i++) {
          const t = readType()
          const name = str(main.bytes4.i32())
          out[name] = readValue(t, main)
        }
        return out
      }
      default: throw new Kv3Error(`unsupported KV3 node type ${type}`)
    }
  }
  const value = readValue(readType(), main)
  return { value, end: b2 + o + 4 }
}
