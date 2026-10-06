import type { Mat4 } from "@deadlock-query/contracts"

/** Inverse of an affine column-major 4x4 (last row 0,0,0,1). Throws when singular. */
export const invertAffine = (m: Mat4): Mat4 => {
  const [a, b, c, d, e, f, g, h, i, j, k, l] = [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!, m[12]!, m[13]!, m[14]!]
  // rows of the 3x3: [a b c; d e f; g h i]
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-30) throw new Error("matrix is singular")
  const r = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det
  ]
  const tx = -(r[0]! * j + r[1]! * k + r[2]! * l)
  const ty = -(r[3]! * j + r[4]! * k + r[5]! * l)
  const tz = -(r[6]! * j + r[7]! * k + r[8]! * l)
  return [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, tx, ty, tz, 1]
}

export const mulMat4 = (p: Mat4, q: Mat4): Mat4 => {
  const o: number[] = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += p[k * 4 + r]! * q[c * 4 + k]!
  return o
}
