import { decode } from "fast-png"

export interface Rgba8 { readonly width: number; readonly height: number; readonly data: Uint8Array }

/** Decodes a PNG (8 or 16 bit; grey, grey+alpha, RGB, RGBA or palette) into RGBA8, sRGB-encoded as stored. */
export const decodePng = (bytes: Uint8Array): Rgba8 => {
  const img = decode(bytes)
  const { width, height, channels, depth } = img
  const src = img.data as Uint8Array | Uint16Array
  const shift = depth === 16 ? 8 : 0
  const px = (v: number) => (depth === 16 ? v >> shift : v)
  const out = new Uint8Array(width * height * 4)
  const palette = img.palette as number[][] | undefined
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    if (palette && channels === 1) {
      const e = palette[src[i]!]
      out[o] = e?.[0] ?? 0; out[o + 1] = e?.[1] ?? 0; out[o + 2] = e?.[2] ?? 0; out[o + 3] = e?.[3] ?? 255
    } else if (channels === 1 || channels === 2) {
      const g = px(src[i * channels]!)
      out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = channels === 2 ? px(src[i * 2 + 1]!) : 255
    } else {
      out[o] = px(src[i * channels]!); out[o + 1] = px(src[i * channels + 1]!); out[o + 2] = px(src[i * channels + 2]!)
      out[o + 3] = channels === 4 ? px(src[i * 4 + 3]!) : 255
    }
  }
  return { width, height, data: out }
}
