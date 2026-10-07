import type { Kv3Value } from "../src/kv3.ts"

/** Synthetic binary KV3 v5 (uncompressed) writer and `.nav` writer for tests; contains no game data. */

const MAGIC_V5 = 0x4b563305
const TRAILER = 0xffeedd00
const GUID = [0x7c, 0x16, 0x12, 0x74, 0xe9, 0x06, 0x98, 0x46, 0xaf, 0xf2, 0xe6, 0x3e, 0xb5, 0x90, 0x37, 0xe7]
const T = { NULL: 1, DOUBLE: 5, STRING: 6, ARRAY: 8, OBJECT: 9, INT32: 11, BOOLEAN_TRUE: 13, BOOLEAN_FALSE: 14 }

class Bytes {
  readonly a: number[] = []
  u8(v: number) { this.a.push(v & 0xff) }
  u32(v: number) { for (let i = 0; i < 4; i++) this.a.push((v >>> (i * 8)) & 0xff) }
  i32(v: number) { this.u32(v >>> 0) }
  f64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this.a.push(...b) }
  f32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.a.push(...b) }
  pad(n: number) { while (this.a.length % n) this.a.push(0) }
  get length() { return this.a.length }
}

/** Encodes `value` as one binary KV3 v5 block: objects, arrays, int32 numbers, doubles, strings, booleans, null. */
export const encodeKv3 = (value: Kv3Value): Uint8Array => {
  const strings: string[] = []
  const sid = (s: string) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s) } return i }
  const types: number[] = []
  const objLens = new Bytes(), l4 = new Bytes(), l8 = new Bytes()
  const typeOf = (v: Kv3Value): number =>
    v === null ? T.NULL : v === true ? T.BOOLEAN_TRUE : v === false ? T.BOOLEAN_FALSE : typeof v === "number" ? (Number.isInteger(v) ? T.INT32 : T.DOUBLE)
      : typeof v === "string" ? T.STRING : Array.isArray(v) ? T.ARRAY : T.OBJECT
  // The reader reads a node's type, then (for object members) the name id, then the value: emit in that order.
  const content = (v: Kv3Value) => {
    if (typeof v === "number") { if (Number.isInteger(v)) l4.i32(v); else l8.f64(v) }
    else if (typeof v === "string") l4.i32(sid(v))
    else if (Array.isArray(v)) { l4.i32(v.length); for (const e of v) { types.push(typeOf(e)); content(e) } }
    else if (v !== null && typeof v === "object") {
      const keys = Object.keys(v)
      objLens.i32(keys.length)
      for (const k of keys) { types.push(typeOf(v[k]!)); l4.i32(sid(k)); content(v[k]!) }
    }
  }
  types.push(typeOf(value)); content(value)

  const chars = new Bytes()
  for (const s of strings) { chars.a.push(...new TextEncoder().encode(s)); chars.u8(0) }
  // Buffer 1: string characters (bytes1 lane), then the 4-byte lane holding the string count.
  const b1 = new Bytes()
  b1.a.push(...chars.a); b1.pad(4); b1.u32(strings.length)
  // Buffer 2: object lengths, the 4-byte lane, the 8-byte lane (8-aligned when used), the types, the trailer.
  const b2 = new Bytes()
  b2.a.push(...objLens.a, ...l4.a)
  if (l8.length > 0) b2.pad(8)
  b2.a.push(...l8.a, ...types); b2.u32(TRAILER)

  const h = new Bytes()
  h.u32(MAGIC_V5); h.a.push(...GUID)
  h.u32(0) // compression method: none
  h.u32(0) // dictionary id + frame size
  h.i32(chars.length); h.i32(1); h.i32(0); h.i32(types.length) // countBytes1, countBytes4 (the string count), countBytes8, countTypes
  h.u32(0) // object + array count hints
  h.i32(b1.length + b2.length); h.i32(b1.length + b2.length) // sizeUncompressedTotal, sizeCompressedTotal
  h.i32(0); h.i32(0) // binary blobs: count, bytes
  h.i32(0); h.i32(0) // countBytes2, sizeBlockCompressedSizes
  h.i32(b1.length); h.i32(0); h.i32(b2.length); h.i32(0) // buffer sizes (uncompressed, compressed) x2
  h.i32(0); h.i32(0); h.i32(l4.length / 4); h.i32(l8.length / 8) // buffer-2 lane counts: bytes1, bytes2, bytes4, bytes8
  h.i32(0); h.i32(objLens.length / 4); h.i32(0); h.i32(0) // node, object, array, array-element hints
  return Uint8Array.from([...h.a, ...b1.a, ...b2.a])
}

/** A `.nav` file: header, empty KV3, vertex pool, face list, then an opaque tail standing in for the undecoded per-face records. */
export const encodeNavFile = (vertices: ReadonlyArray<number>, faces: ReadonlyArray<ReadonlyArray<number>>, version = 36): Uint8Array => {
  const b = new Bytes()
  b.u32(0xfeedface); b.u32(version); b.u32(0); b.u32(0x01000001)
  b.a.push(...encodeKv3(null))
  b.u32(vertices.length / 3)
  for (const v of vertices) b.f32(v)
  b.u32(faces.length)
  for (const f of faces) { b.u8(f.length); for (const i of f) b.u32(i); b.u32(0xffffffff) }
  b.u32(faces.length)
  return Uint8Array.from(b.a)
}
