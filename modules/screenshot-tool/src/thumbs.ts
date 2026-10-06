import jpeg from "jpeg-js"
import { PNG } from "pngjs"
import { imageSize } from "./image.ts"

export const DEFAULT_THUMB_EDGE = 320
const QUALITY = 75

export const thumbFile = (id: string): string => `thumbs/${id}.jpg`

interface Raster { readonly width: number; readonly height: number; readonly data: Uint8Array } // RGBA

const decode = (bytes: Uint8Array): Raster | undefined => {
  const kind = imageSize(bytes)?.format
  if (kind === "png") {
    const p = PNG.sync.read(Buffer.from(bytes))
    return { width: p.width, height: p.height, data: p.data }
  }
  if (kind === "jpeg") {
    const j = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true })
    return { width: j.width, height: j.height, data: j.data }
  }
  return undefined
}

/** Area-average downscale (each output pixel is the mean of the source pixels it covers): no aliasing from point sampling. */
const downscale = (src: Raster, width: number, height: number): Raster => {
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * src.height) / height), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * src.width) / width), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / width))
      let r = 0, g = 0, b = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) { const i = (sy * src.width + sx) * 4; r += src.data[i]!; g += src.data[i + 1]!; b += src.data[i + 2]! }
      }
      const n = (y1 - y0) * (x1 - x0), o = (y * width + x) * 4
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255
    }
  }
  return { width, height, data: out }
}

/** JPEG thumbnail whose longer edge is at most `maxEdge` (never upscaled). `undefined` when the input is not a decodable PNG/JPEG. */
export const makeThumbnail = (bytes: Uint8Array, maxEdge = DEFAULT_THUMB_EDGE): Uint8Array | undefined => {
  let src: Raster | undefined
  try { src = decode(bytes) } catch { return undefined }
  if (src === undefined || src.width < 1 || src.height < 1) return undefined
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height))
  const small = scale === 1 ? { ...src, data: src.data } : downscale(src, Math.max(1, Math.round(src.width * scale)), Math.max(1, Math.round(src.height * scale)))
  return jpeg.encode({ width: small.width, height: small.height, data: Buffer.from(small.data) }, QUALITY).data
}
