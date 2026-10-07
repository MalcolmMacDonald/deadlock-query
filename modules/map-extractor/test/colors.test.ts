import { expect, test } from "bun:test"
import { encode } from "fast-png"
import { buildMips, linearToSrgb8, meanColor, mipForDensity, sampleMips, solidMips, srgbToLinear } from "../src/colors.ts"
import { decodePng } from "../src/png.ts"

const rgbaOf = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
  const d = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4)
  return d
}

test("sRGB conversion round-trips and matches known values", () => {
  expect(srgbToLinear(0)).toBe(0)
  expect(srgbToLinear(255)).toBeCloseTo(1, 6)
  expect(srgbToLinear(128)).toBeCloseTo(0.2158, 3)
  for (const v of [0, 1, 30, 100, 128, 200, 255]) expect(linearToSrgb8(srgbToLinear(v))).toBe(v)
})

test("mip chain: power-of-two square, down to 1 x 1, averaged in linear light", () => {
  // 4 x 2 texture, left half white, right half black: mean is 0.5 linear, not 0.5 sRGB
  const m = buildMips(rgbaOf(4, 2, (x) => (x < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])), 4, 2)
  expect(m.size).toBe(4)
  expect(m.levels.map((l) => l.length / 4)).toEqual([16, 4, 1])
  const mean = meanColor(m)
  expect(mean[0]).toBeCloseTo(0.5, 2)
  expect(linearToSrgb8(mean[0])).toBeGreaterThan(180) // sRGB 188, not 128
  expect(buildMips(new Uint8Array(4 * 300 * 200).fill(255), 300, 200, 64).size).toBe(64)
  expect(solidMips([0.25, 0.5, 1]).levels).toHaveLength(1)
})

test("mip level follows the vertex density in UV space", () => {
  const m = buildMips(rgbaOf(64, 64, () => [10, 20, 30, 255]), 64, 64)
  expect(m.levels).toHaveLength(7)
  expect(mipForDensity(m, 1, 64 * 64)).toBe(0) // one vertex per texel
  expect(mipForDensity(m, 1, 16 * 16)).toBe(2) // 4 texels per vertex edge
  expect(mipForDensity(m, 1, 4)).toBe(5) // a quad over the whole texture: nearly the average
  expect(mipForDensity(m, 100, 4)).toBe(6) // a quad tiling the texture 10 x 10: the average
  expect(mipForDensity(solidMips([1, 1, 1]), 1, 4)).toBe(0)
})

test("sampling is bilinear with repeat wrapping", () => {
  const m = buildMips(rgbaOf(2, 2, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 2, 2)
  const o: [number, number, number] = [0, 0, 0]
  sampleMips(m, 0.25, 0.25, 0, o); expect(o[0]).toBeCloseTo(1, 5); expect(o[2]).toBeCloseTo(0, 5)
  sampleMips(m, 0.75, 0.25, 0, o); expect(o[2]).toBeCloseTo(1, 5)
  sampleMips(m, 1.25, 3.25, 0, o); expect(o[0]).toBeCloseTo(1, 5) // wraps to 0.25, 0.25
  sampleMips(m, 0.5, 0.25, 0, o); expect(o[0]).toBeCloseTo(0.5, 5) // halfway between the two columns
})

test("decodePng handles RGB, RGBA and 16-bit grey", () => {
  const rgb = decodePng(encode({ width: 2, height: 1, data: new Uint8Array([255, 0, 0, 0, 255, 0]), channels: 3, depth: 8 }))
  expect([...rgb.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255])
  const rgba = decodePng(encode({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]), channels: 4, depth: 8 }))
  expect([...rgba.data]).toEqual([1, 2, 3, 4])
  const grey = decodePng(encode({ width: 1, height: 1, data: new Uint16Array([0x8000]), channels: 1, depth: 16 }))
  expect([...grey.data]).toEqual([128, 128, 128, 255])
})
