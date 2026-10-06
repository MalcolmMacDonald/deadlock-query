import { deflateSync } from "node:zlib"

export interface ImageSize { readonly width: number; readonly height: number; readonly format: "png" | "jpeg" }

/** Pixel size from the file header; `undefined` for anything that is not a PNG or JPEG (the game's other formats are not supported yet). */
export const imageSize = (b: Uint8Array): ImageSize | undefined => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length >= 24 && v.getUint32(0) === 0x89504e47 && v.getUint32(4) === 0x0d0a1a0a && v.getUint32(12) === 0x49484452) {
    return { width: v.getUint32(16), height: v.getUint32(20), format: "png" }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]!
      if (m === 0xff) { i++; continue }
      // SOF0..SOF15 carry the frame size, except DHT (c4), JPG (c8) and DAC (cc).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: v.getUint16(i + 5), width: v.getUint16(i + 7), format: "jpeg" }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      i += 2 + v.getUint16(i + 2)
    }
  }
  return undefined
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
const crc32 = (b: Uint8Array): number => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Solid grey PNG of the given size: what `--fake` runs write instead of a real screenshot. */
export const placeholderPng = (width: number, height: number, shade: number): Uint8Array => {
  const ihdr = new Uint8Array(13)
  const hv = new DataView(ihdr.buffer)
  hv.setUint32(0, width); hv.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale
  const row = new Uint8Array(1 + width).fill(shade & 0xff, 1) // filter byte 0 + pixels
  const raw = new Uint8Array(row.length * height)
  for (let y = 0; y < height; y++) raw.set(row, y * row.length)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
