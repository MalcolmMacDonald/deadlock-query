/**
 * Base colours for the lite render tiles. Textures are far too big for the site budget (the full export's textures are
 * about 1.8 GB), so a material's colour is baked into the vertices instead: every tile vertex gets one RGBA8 `COLOR_0`
 * (linear, as glTF defines it), which meshopt compresses to almost nothing where neighbours share a colour.
 *
 * A material's paint is a linear tint, optionally times a small mip chain of its base-colour texture. The texture is
 * sampled per vertex at the mip level that matches the vertex spacing in UV space, so a coarse prop gets its average
 * colour and a dense mesh gets real detail. This module has no IO: building paints from a game install is `materials.ts`.
 */

/** Linear-light colour, 0..1 per channel. */
export type Rgb = readonly [number, number, number]

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

export const srgbToLinear = (c8: number): number => SRGB_TO_LINEAR[c8 & 255]!
/** Linear 0..1 to an sRGB byte. */
export const linearToSrgb8 = (c: number): number => {
  const x = c <= 0 ? 0 : c >= 1 ? 1 : c
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255)
}
/** Linear 0..1 to a byte (what a normalised `COLOR_0` stores). */
export const toByte = (c: number): number => (c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255))

/** A square RGBA8 sRGB texture with its mip chain: `levels[0]` is `size` x `size`, each next level half as wide, the last 1 x 1. */
export interface MipChain {
  readonly size: number
  readonly levels: ReadonlyArray<Uint8Array>
}

const pow2AtMost = (n: number): number => { let p = 1; while (p * 2 <= n) p *= 2; return p }

/**
 * Builds the chain from RGBA8 sRGB pixels (`w` x `h`, any size): resampled to a power-of-two square of at most `maxSize` by
 * averaging (in linear light), then halved down to 1 x 1.
 */
export const buildMips = (rgba: Uint8Array, w: number, h: number, maxSize = 128): MipChain => {
  const size = Math.max(1, Math.min(maxSize, pow2AtMost(Math.max(w, h))))
  const level0 = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * h) / size), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / size))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * w) / size), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / size))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const o = (yy * w + xx) * 4
        r += srgbToLinear(rgba[o]!); g += srgbToLinear(rgba[o + 1]!); b += srgbToLinear(rgba[o + 2]!); a += rgba[o + 3]!; n++
      }
      const d = (y * size + x) * 4
      level0[d] = linearToSrgb8(r / n); level0[d + 1] = linearToSrgb8(g / n); level0[d + 2] = linearToSrgb8(b / n); level0[d + 3] = Math.round(a / n)
    }
  }
  const levels: Uint8Array[] = [level0]
  for (let s = size; s > 1; s >>= 1) {
    const src = levels[levels.length - 1]!, half = s >> 1, dst = new Uint8Array(half * half * 4)
    for (let y = 0; y < half; y++) for (let x = 0; x < half; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let k = 0; k < 4; k++) sum += srgbToLinear(src[(((y * 2 + (k >> 1)) * s) + x * 2 + (k & 1)) * 4 + c]!)
        dst[(y * half + x) * 4 + c] = linearToSrgb8(sum / 4)
      }
      let a = 0
      for (let k = 0; k < 4; k++) a += src[(((y * 2 + (k >> 1)) * s) + x * 2 + (k & 1)) * 4 + 3]!
      dst[(y * half + x) * 4 + 3] = Math.round(a / 4)
    }
    levels.push(dst)
  }
  return { size, levels }
}

/** A flat 1 x 1 chain of one colour (linear). */
export const solidMips = (c: Rgb): MipChain => ({ size: 1, levels: [new Uint8Array([linearToSrgb8(c[0]), linearToSrgb8(c[1]), linearToSrgb8(c[2]), 255])] })

/** Average colour of the whole texture (linear). */
export const meanColor = (m: MipChain): Rgb => {
  const t = m.levels[m.levels.length - 1]!
  return [srgbToLinear(t[0]!), srgbToLinear(t[1]!), srgbToLinear(t[2]!)]
}

/** Mip levels in `m`. */
export const mipCount = (m: MipChain): number => m.levels.length

/** Mip level whose texel is about one vertex spacing wide, for a primitive with `verts` vertices spanning `uvArea` of UV space (repeats count). */
export const mipForDensity = (m: MipChain, uvArea: number, verts: number): number => {
  if (m.levels.length === 1 || verts <= 0) return 0
  const spacing = Math.sqrt(Math.max(uvArea, 1e-9) / verts)
  const level = Math.round(Math.log2(Math.max(spacing * m.size, 1)))
  return Math.min(m.levels.length - 1, Math.max(0, level))
}

/** Bilinear sample of one mip level with repeat wrapping; `out` receives linear RGB. */
export const sampleMips = (m: MipChain, u: number, v: number, level: number, out: [number, number, number]): void => {
  const s = m.size >> level, px = m.levels[level]!
  const fx = (u - Math.floor(u)) * s - 0.5, fy = (v - Math.floor(v)) * s - 0.5
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
  const at = (x: number, y: number, c: number) => srgbToLinear(px[(((y % s + s) % s) * s + ((x % s + s) % s)) * 4 + c]!)
  for (let c = 0; c < 3; c++) {
    out[c] = (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) + (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty
  }
}

/** What one material looks like: a linear tint times its (optional) base-colour texture. */
export interface MaterialPaint {
  readonly tint: Rgb
  readonly texture?: MipChain | undefined
}

/** Looks up paints for the lite reduction. Names are glTF material names and the `_mt_<name>` suffix of mesh names. */
export interface ColorProvider {
  /** The paint for the first name that resolves; undefined when none does (the vertices get `fallback`). */
  readonly paintFor: (names: ReadonlyArray<string>) => MaterialPaint | undefined
  /** Colour of primitives with no resolved material (linear). */
  readonly fallback: Rgb
}

/** Fixed paints by name: the simplest provider (tests, and `colors.json` caches). */
export const mapProvider = (paints: ReadonlyMap<string, MaterialPaint>, fallback: Rgb): ColorProvider => ({
  paintFor: (names) => { for (const n of names) { const p = paints.get(n); if (p) return p } return undefined },
  fallback
})
