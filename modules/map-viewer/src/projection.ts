import type { Vec3 } from "@deadlock-query/contracts"

export interface Bounds2 { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }

export const boundsOf = (points: ReadonlyArray<Vec3>, pad = 0): Bounds2 => {
  if (points.length === 0) return { minX: -1, maxX: 1, minY: -1, maxY: 1 }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad }
}

/** Top-down fit: world (x right, y up) -> canvas pixels (y down), preserving aspect. */
export const fitTopDown = (b: Bounds2, width: number, height: number) => {
  const scale = Math.min(width / (b.maxX - b.minX || 1), height / (b.maxY - b.minY || 1))
  const ox = (width - (b.maxX - b.minX) * scale) / 2
  const oy = (height - (b.maxY - b.minY) * scale) / 2
  return (p: Vec3): [number, number] => [ox + (p[0] - b.minX) * scale, height - oy - (p[1] - b.minY) * scale]
}
